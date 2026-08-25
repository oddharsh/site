// resample.rs — a separable resampling kernel, written rather than borrowed.
//
// WHY HAND-WRITTEN. `image`'s Lanczos3 fails the one property a resampler
// cannot fail: it is not identity at scale 1.0. Measured by
// tools/photos/resample-probe.ts, it softens unconditionally, at every scale
// and not only the degenerate one. That is what sank the second attempt at
// moving the pipeline's square crop into zenc, and it is not a tuning problem.
//
// THE THREE THINGS THAT MAKE THIS CORRECT, none of which is exotic and all of
// which something in the wild gets wrong:
//
// 1. SUPPORT SCALES WITH THE REDUCTION. On a downscale the filter has to
//    low-pass at the OUTPUT Nyquist, so its support in SOURCE pixels widens by
//    the reduction factor. A kernel evaluated at fixed width is sampling, not
//    filtering, and it aliases. This is the bug that makes naive "Lanczos3"
//    downscales shimmer.
//
// 2. THE AVERAGE IS OVER LIGHT. sRGB is an encoding of perceived brightness,
//    not of light, so averaging encoded values darkens every texture. A 1px
//    black/white checkerboard must reduce to sRGB ~187.5, and sips and ffmpeg
//    both give ~128. That is the defect this kernel exists to not have.
//
// 3. WEIGHTS ARE NORMALISED PER OUTPUT SAMPLE. The support window clips at the
//    image edge, so the weights that survive must be renormalised or the border
//    darkens toward zero. Cheap to get right, easy to forget, and it shows up as
//    a vignette nobody can explain.
//
// The kernel is deliberately free of I/O and of any image type. It takes planar
// f32 in linear light and returns the same. That is what makes it testable
// against analytic answers, and it is the shape this would take if it ever left
// this repository.

/// How the filter weights fall off with distance from the sample centre.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Filter {
    /// Area average. Zero ringing by construction, since no weight is negative,
    /// and exactly the analytic answer when the reduction is an integer factor.
    Box,
    /// Windowed sinc, three lobes. Sharper than Box and it rings, because the
    /// lobes are negative. Whether that trade is worth taking is a decision for
    /// the probe rather than for this comment.
    Lanczos3,
    /// Cubic with B=C=1/3. Between the two: mild ringing, less softening.
    Mitchell,
}

impl Filter {
    /// Half-width in OUTPUT-normalised units, before the reduction factor
    /// widens it.
    fn support(self) -> f32 {
        match self {
            Filter::Box => 0.5,
            Filter::Lanczos3 => 3.0,
            Filter::Mitchell => 2.0,
        }
    }

    fn eval(self, t: f32) -> f32 {
        let t = t.abs();
        match self {
            Filter::Box => {
                // Half-open so a sample exactly on the boundary is counted once
                // rather than by both neighbours.
                if t < 0.5 { 1.0 } else if t == 0.5 { 0.5 } else { 0.0 }
            }
            Filter::Lanczos3 => {
                if t < 1e-7 {
                    1.0
                } else if t < 3.0 {
                    let pt = std::f32::consts::PI * t;
                    (pt.sin() / pt) * ((pt / 3.0).sin() / (pt / 3.0))
                } else {
                    0.0
                }
            }
            Filter::Mitchell => {
                const B: f32 = 1.0 / 3.0;
                const C: f32 = 1.0 / 3.0;
                let t2 = t * t;
                if t < 1.0 {
                    ((12.0 - 9.0 * B - 6.0 * C) * t * t2
                        + (-18.0 + 12.0 * B + 6.0 * C) * t2
                        + (6.0 - 2.0 * B))
                        / 6.0
                } else if t < 2.0 {
                    ((-B - 6.0 * C) * t * t2
                        + (6.0 * B + 30.0 * C) * t2
                        + (-12.0 * B - 48.0 * C) * t
                        + (8.0 * B + 24.0 * C))
                        / 6.0
                } else {
                    0.0
                }
            }
        }
    }
}

/// The taps for one output sample: where they start and what they weigh.
struct Taps {
    first: usize,
    weights: Vec<f32>,
}

/// Weights for every output sample along one axis.
///
/// `center` is the source coordinate the output sample sits on, derived from
/// PIXEL CENTRES rather than edges. Getting that half-pixel wrong shifts the
/// whole image by half an output pixel, which reads as "slightly blurry" and is
/// actually a misalignment.
fn plan(src_len: usize, dst_len: usize, f: Filter) -> Vec<Taps> {
    let scale = dst_len as f32 / src_len as f32;
    // On a downscale the filter widens; on an upscale it does not.
    let widen = if scale < 1.0 { 1.0 / scale } else { 1.0 };
    let support = f.support() * widen;
    let mut out = Vec::with_capacity(dst_len);
    for i in 0..dst_len {
        let center = (i as f32 + 0.5) / scale - 0.5;
        let first = ((center - support).ceil().max(0.0)) as usize;
        let last = ((center + support).floor().min(src_len as f32 - 1.0)) as usize;
        let mut weights = Vec::with_capacity(last.saturating_sub(first) + 1);
        let mut sum = 0.0f32;
        for s in first..=last {
            let w = f.eval((s as f32 - center) / widen);
            weights.push(w);
            sum += w;
        }
        // Renormalise, so a window clipped by the edge still integrates to 1.
        if sum != 0.0 {
            for w in &mut weights {
                *w /= sum;
            }
        }
        out.push(Taps { first, weights });
    }
    out
}

/// Separable resample of interleaved planar f32.
///
/// Separable because a 2D filter of this family factors into two 1D passes,
/// which turns O(support^2) per output pixel into O(support). At the pipeline's
/// 3.3x reduction that is the difference between ~44 taps and ~13 per pixel.
pub fn resample(
    src: &[f32],
    sw: usize,
    sh: usize,
    ch: usize,
    dw: usize,
    dh: usize,
    f: Filter,
) -> Vec<f32> {
    debug_assert_eq!(src.len(), sw * sh * ch);
    // Horizontal first: it shrinks the row length before the vertical pass has
    // to walk it, which is strictly less work when both axes reduce.
    let xplan = plan(sw, dw, f);
    let mut mid = vec![0.0f32; dw * sh * ch];
    for y in 0..sh {
        for (x, tap) in xplan.iter().enumerate() {
            for c in 0..ch {
                let mut acc = 0.0f32;
                for (k, w) in tap.weights.iter().enumerate() {
                    acc += src[(y * sw + tap.first + k) * ch + c] * w;
                }
                mid[(y * dw + x) * ch + c] = acc;
            }
        }
    }
    let yplan = plan(sh, dh, f);
    let mut dst = vec![0.0f32; dw * dh * ch];
    for (y, tap) in yplan.iter().enumerate() {
        for x in 0..dw {
            for c in 0..ch {
                let mut acc = 0.0f32;
                for (k, w) in tap.weights.iter().enumerate() {
                    acc += mid[((tap.first + k) * dw + x) * ch + c] * w;
                }
                dst[(y * dw + x) * ch + c] = acc;
            }
        }
    }
    dst
}

// ── sRGB transfer, the only colour this file knows ──────────────────────────
// Exact round trip at 8 bit: all 256 values return to themselves, verified in
// the tests below rather than assumed.

pub fn srgb_to_linear(c: u8) -> f32 {
    let s = c as f32 / 255.0;
    if s <= 0.040_449_936 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
}

pub fn linear_to_srgb(l: f32) -> u8 {
    let l = l.clamp(0.0, 1.0);
    let s = if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_round_trip_is_exact_at_8_bit() {
        for c in 0u8..=255 {
            assert_eq!(linear_to_srgb(srgb_to_linear(c)), c, "value {c} did not return");
        }
    }

    /// The property `image`'s Lanczos3 fails. Box and Lanczos3 are INTERPOLATING
    /// filters: their weight is 1 at zero offset and 0 at every other integer,
    /// so at unit scale each output sample reads exactly one input sample.
    #[test]
    fn unit_scale_is_identity_for_the_interpolating_filters() {
        let src: Vec<f32> = (0..64 * 64).map(|i| (i % 251) as f32 / 251.0).collect();
        for f in [Filter::Box, Filter::Lanczos3] {
            let out = resample(&src, 64, 64, 1, 64, 64, f);
            for (i, (a, b)) in src.iter().zip(out.iter()).enumerate() {
                assert!((a - b).abs() < 1e-5, "{f:?} moved sample {i}: {a} -> {b}");
            }
        }
    }

    /// Mitchell is NOT identity, and that is the filter rather than a defect.
    /// B=1/3 makes it approximating instead of interpolating: its weight at zero
    /// offset is (6-2B)/6 = 0.889, with the remainder spread to the neighbours,
    /// so it blurs slightly at every scale including 1.0. Asserted rather than
    /// left to a comment, because the identity test above would otherwise read
    /// as something Mitchell had failed.
    #[test]
    fn mitchell_is_approximating_and_so_blurs_at_unit_scale() {
        let src: Vec<f32> = (0..64 * 64).map(|i| if i % 2 == 0 { 0.0 } else { 1.0 }).collect();
        let out = resample(&src, 64, 64, 1, 64, 64, Filter::Mitchell);
        let moved = src.iter().zip(out.iter()).filter(|(a, b)| (*a - *b).abs() > 1e-4).count();
        assert!(moved > src.len() / 2, "Mitchell behaved as interpolating, which it is not");
    }

    /// A checkerboard is half light, and half light is what must come out.
    #[test]
    fn checkerboard_reduces_to_half_light() {
        let n = 64;
        let src: Vec<f32> = (0..n * n)
            .map(|i| if ((i / n) + (i % n)) % 2 == 0 { 0.0 } else { 1.0 })
            .collect();
        for f in [Filter::Box, Filter::Lanczos3, Filter::Mitchell] {
            let out = resample(&src, n, n, 1, 4, 4, f);
            let mean = out.iter().sum::<f32>() / out.len() as f32;
            assert!((mean - 0.5).abs() < 0.02, "{f:?} gave {mean}, expected 0.5");
        }
    }

    /// Weights integrate to 1 everywhere, including where the window clips the
    /// edge. A flat field must stay flat rather than darkening at the border.
    #[test]
    fn a_flat_field_stays_flat_including_the_edges() {
        let src = vec![0.5f32; 100 * 100];
        for f in [Filter::Box, Filter::Lanczos3, Filter::Mitchell] {
            let out = resample(&src, 100, 100, 1, 30, 30, f);
            for (i, v) in out.iter().enumerate() {
                assert!((v - 0.5).abs() < 1e-4, "{f:?} sample {i} drifted to {v}");
            }
        }
    }

    /// Box has no negative lobes, so it cannot overshoot. The other two can, and
    /// this pins which is which rather than leaving it to belief.
    #[test]
    fn box_does_not_ring_and_lanczos_does() {
        let n = 64;
        let src: Vec<f32> = (0..n * n).map(|i| if (i % n) < n / 2 { 0.0 } else { 1.0 }).collect();
        let over = |f: Filter| {
            resample(&src, n, n, 1, 16, 16, f)
                .iter()
                .fold(0.0f32, |m, v| m.max((-*v).max(*v - 1.0)))
        };
        assert!(over(Filter::Box) < 1e-6, "Box rang");
        assert!(over(Filter::Lanczos3) > 1e-4, "Lanczos3 did not ring, so this test proves nothing");
    }
}
