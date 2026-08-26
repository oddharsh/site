// resample.rs — a separable resampling kernel, written rather than borrowed.
//
// WHY HAND-WRITTEN, corrected 2026-08-26. This header used to claim `image`'s
// Lanczos3 "is not identity at scale 1.0" and "softens unconditionally". THAT
// CLAIM IS RETRACTED, and the retraction is worth more than the claim was:
//
//   - Both of image 0.25.10's public resize entry points SHORT-CIRCUIT at
//     equal dimensions (dynimage.rs:876, sample.rs:985 both copy), so the
//     identity property is vacuously true there and untestable from outside.
//     The measurement that "confirmed" the claim couldn't reach the kernel,
//     and neither could the one that later "refuted" it.
//   - Their kernel source has the same centre convention ((i+0.5)*ratio-0.5),
//     the same support scaling, and the same per-sample renormalisation as
//     this file. Fed identical linear f32, image and fast_image_resize agree
//     with this kernel to within 6e-7, with identical Lanczos ringing (0.0105
//     on a 0.2/0.8 step) and identical zero aliasing.
//
// What the failed second attempt at the square crop ACTUALLY hit was the
// wrapper, not the kernel: image's default u8 path averages ENCODED values.
// A 0/255 checkerboard reduced 16x comes back 127.02 from image, 127.98 from
// fast_image_resize's default u8 path, and 188 is correct. fir ships an sRGB
// mapper that fixes it, opt-in, and nothing calls it for you.
//
// So the real reasons this file exists, stated honestly:
//
//   1. THE CORRECT COLOUR PATH IS THE ONLY PATH. The API takes planar linear
//      f32, so resampling encoded values is unrepresentable here rather than a
//      default you must remember to override. Both major Rust crates make the
//      wrong thing the default; this makes it impossible.
//   2. Zero dependencies and testable against analytic answers, which is what
//      let the probe catch its own three bugs (see resample-probe.ts).
//   3. It is CORRECT-first, not fast-first: scalar f32. The fixed-channel
//      inner loop (see resample_fixed) recovered 2x of the resample core
//      (42.9 -> 22.9ms on 5952x3968 RGB -> 900x600 Box, byte-identical),
//      which puts the whole gamma-correct job ahead of fast_image_resize's
//      opt-in correct path (u16 linear) while staying f32 linear. fir's SIMD
//      on its gamma-WRONG default u8 path is still ~1.8x faster; that gap is
//      the price of the transfer function, not the kernel.
//
// THE THREE THINGS THAT MAKE THIS CORRECT, none of which is exotic and all of
// which something in the wild gets wrong (sips gets all three wrong at once;
// see the probe's gamma/flat/ring columns):
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
///
/// The passes are monomorphised over the channel count for the two counts the
/// pipeline produces (1 and 3), with the dynamic loop kept as the fallback for
/// any other. The win is not vectorisation so much as what a compile-time CH
/// removes: the per-channel pass over the tap list becomes one pass carrying a
/// fixed-width accumulator, so each weight is loaded once instead of ch times
/// and the bounds checks fold. Measured on 5952x3968 RGB -> 900x600 Box:
/// 42.9 -> 22.9 ms for the resample core, output byte-identical.
///
/// BYTE-IDENTICAL is a property of the summation ORDER, not luck: both shapes
/// accumulate each channel over k ascending, and rustc does not reassociate
/// f32 adds, so the sums are bitwise the same. A future SIMD pass that splits
/// the accumulator would break that order and re-mint every content-addressed
/// thumbnail; the corpus check in the tests below is the tripwire.
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
    match ch {
        1 => resample_fixed::<1>(src, sw, sh, dw, dh, f),
        3 => resample_fixed::<3>(src, sw, sh, dw, dh, f),
        _ => resample_dyn(src, sw, sh, ch, dw, dh, f),
    }
}

fn resample_fixed<const CH: usize>(
    src: &[f32],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    f: Filter,
) -> Vec<f32> {
    // Horizontal first: it shrinks the row length before the vertical pass has
    // to walk it, which is strictly less work when both axes reduce.
    let xplan = plan(sw, dw, f);
    let mut mid = vec![0.0f32; dw * sh * CH];
    for y in 0..sh {
        let row = &src[y * sw * CH..(y + 1) * sw * CH];
        for (x, tap) in xplan.iter().enumerate() {
            let mut acc = [0.0f32; CH];
            for (k, w) in tap.weights.iter().enumerate() {
                let p = &row[(tap.first + k) * CH..(tap.first + k + 1) * CH];
                for c in 0..CH {
                    acc[c] += p[c] * w;
                }
            }
            mid[(y * dw + x) * CH..(y * dw + x + 1) * CH].copy_from_slice(&acc);
        }
    }
    let yplan = plan(sh, dh, f);
    let mut dst = vec![0.0f32; dw * dh * CH];
    for (y, tap) in yplan.iter().enumerate() {
        for x in 0..dw {
            let mut acc = [0.0f32; CH];
            for (k, w) in tap.weights.iter().enumerate() {
                let i = ((tap.first + k) * dw + x) * CH;
                for c in 0..CH {
                    acc[c] += mid[i + c] * w;
                }
            }
            dst[(y * dw + x) * CH..(y * dw + x + 1) * CH].copy_from_slice(&acc);
        }
    }
    dst
}

/// The original dynamic-channel loops, kept verbatim as the fallback and as
/// the oracle the specialisation is tested against.
fn resample_dyn(
    src: &[f32],
    sw: usize,
    sh: usize,
    ch: usize,
    dw: usize,
    dh: usize,
    f: Filter,
) -> Vec<f32> {
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

/// The forward transfer takes a u8, so it has exactly 256 answers and does not
/// need to be computed 119 million times. Measured on a 7728x5152 frame, the
/// powf per sample was most of the resize; the table makes it a load. Built
/// once, lazily, from the same expression the table replaces, so there is no
/// second definition of sRGB to keep in step.
static SRGB_LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();

#[inline]
pub fn srgb_to_linear(c: u8) -> f32 {
    SRGB_LUT.get_or_init(|| std::array::from_fn(|i| srgb_to_linear_exact(i as u8)))[c as usize]
}

fn srgb_to_linear_exact(c: u8) -> f32 {
    let s = c as f32 / 255.0;
    if s <= 0.040_449_936 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
}

pub fn linear_to_srgb(l: f32) -> u8 {
    let l = l.clamp(0.0, 1.0);
    let s = if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

// ── pure gamma 2.2, the Leica M Monochrom's declared transfer ───────────────
// A separate pair rather than a parameter on the sRGB one, because the two
// curves must never blend: the piecewise linear toe is exactly what makes sRGB
// not-a-power-law, and a "close enough" hybrid is how the max-4-code shadow
// error this exists to fix would come back wearing a fix's name.

static G22_LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();

#[inline]
pub fn g22_to_linear(c: u8) -> f32 {
    G22_LUT.get_or_init(|| std::array::from_fn(|i| (i as f32 / 255.0).powf(2.2)))[c as usize]
}

pub fn linear_to_g22(l: f32) -> u8 {
    let l = l.clamp(0.0, 1.0);
    (l.powf(1.0 / 2.2) * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g22_round_trip_is_exact_at_8_bit() {
        for c in 0u8..=255 {
            assert_eq!(linear_to_g22(g22_to_linear(c)), c, "g22 value {c} did not return");
        }
    }

    /// The two curves must actually differ where it matters, or the parameter
    /// is decoration. Largest gap is in the shadows, where sRGB's linear toe
    /// departs from the power law.
    #[test]
    fn g22_and_srgb_are_distinct_curves() {
        let mut diverge = 0;
        for c in 1u8..=254 {
            if (g22_to_linear(c) - srgb_to_linear(c)).abs() / srgb_to_linear(c).max(1e-9) > 0.01 {
                diverge += 1;
            }
        }
        assert!(diverge > 100, "curves nearly identical ({diverge} values differ >1%); the transfer parameter buys nothing");
    }

    #[test]
    fn srgb_round_trip_is_exact_at_8_bit() {
        for c in 0u8..=255 {
            assert_eq!(linear_to_srgb(srgb_to_linear(c)), c, "value {c} did not return");
        }
    }

    /// Box and Lanczos3 are INTERPOLATING filters: their weight is 1 at zero
    /// offset and 0 at every other integer, so at unit scale each output sample
    /// reads exactly one input sample. `image` short-circuits this case to a
    /// copy, so the property is untestable there; here the kernel actually runs
    /// at unit scale, which is why the test means something.
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

    /// The fixed-channel passes must be BITWISE equal to the dynamic loop they
    /// replaced, because /i/ URLs are content-addressed and one moved bit
    /// re-mints the corpus. Bitwise rather than epsilon on purpose: both shapes
    /// accumulate each channel over k ascending and rustc does not reassociate
    /// f32, so exact equality is the contract, and an epsilon here would let a
    /// reordering SIMD rewrite slip through the exact gate it needs to hit.
    #[test]
    fn fixed_channel_passes_match_the_dynamic_oracle_bitwise() {
        let (sw, sh) = (97, 61); // deliberately awkward, non-square, prime-ish
        for ch in [1usize, 3] {
            let src: Vec<f32> = (0..sw * sh * ch)
                .map(|i| ((i * 2654435761usize) % 1000) as f32 / 999.0)
                .collect();
            for f in [Filter::Box, Filter::Lanczos3, Filter::Mitchell] {
                for (dw, dh) in [(29, 17), (97, 61), (120, 80)] {
                    let a = resample(&src, sw, sh, ch, dw, dh, f);
                    let b = resample_dyn(&src, sw, sh, ch, dw, dh, f);
                    assert_eq!(a.len(), b.len());
                    for (i, (x, y)) in a.iter().zip(&b).enumerate() {
                        assert_eq!(x.to_bits(), y.to_bits(), "{f:?} ch={ch} {dw}x{dh} sample {i}");
                    }
                }
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

#[cfg(test)]
mod lut_tests {
    use super::*;

    // The table is an optimisation and must not be a second opinion about sRGB.
    #[test]
    fn the_lut_agrees_with_the_expression_it_replaces() {
        for c in 0..=255u8 {
            assert_eq!(
                srgb_to_linear(c).to_bits(),
                srgb_to_linear_exact(c).to_bits(),
                "lut disagrees at {c}"
            );
        }
    }
}
