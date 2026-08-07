---
title: "aadhar.sh/lwe/dac"
description: "Why DAC nerds fight about multibit versus delta-sigma, explained at MSN-chat pace. An R-2R ladder you can mismatch, a multibit staircase, a live noise-shaping DFT, an audible bit-depth demo, a reconstruction filter showing the time-frequency tradeoff, and a tube stage you can overdrive into even or odd harmonics. Leans on Schiit Happened and head-fi, cited."
path: "/lwe/dac"
section: "lwe"
kind: "content"
updated: "2026-06-22"
source: "https://aadhar.sh/lwe/dac"
---

**DACs**Online, ladders vs noise shaping

Learning With Errors
bits & voltages

**Starter draft.** The explanations lean on [Schiit Happened](http://lucasbosch.de/schiit/jason-stoddard-shiit-happened-tablet-lblb.pdf) (Jason Stoddard's book, shared free by the author) and the [head-fi threads](https://www.head-fi.org/threads/schiit-happened-the-story-of-the-gods-of-noise.701900/), paraphrased and cited. The six demos run real math: a quantized staircase, an R-2R ladder you can mismatch, an actual DFT of a noise-shaped signal, a Web Audio tone you can hear at each bit depth, a reconstruction filter showing the time-frequency tradeoff, and a tube stage that turns a sine into even or odd harmonics.

**aadharsh**14:20

every dac debate online collapses into multibit versus delta-sigma, and everyone gets religious about it. what's the actual engineering difference, underneath the tribalism?

**DACs**14:20

Both turn a stream of numbers into a voltage. They split on how to rebuild the wave from the samples. Multibit builds each sample as one exact level. Delta-sigma approximates that level with a coarse switch running very fast, then hides the leftover error where your ears can't reach. Two roads to the same clean output.

**aadharsh**14:21

start with multibit. that's the one that works the way I'd naively guess.

**DACs**14:21

It does. An N-bit value selects one of 2^N voltages, and a resistor ladder (R-2R) sums the bits into exactly that level. A 16-bit sample picks one of 65,536 voltages. The raw output is a staircase, one flat step per sample, which a filter then smooths into a curve.

the staircase · drag the bit depth

A multibit DAC builds each sample as one exact voltage, chosen from 2^N levels a resistor ladder defines. Drag the bit depth: more bits means a finer staircase, closer to the smooth wave underneath.

Hit **play** and drag the bit depth: at 3-bit the quantization hash is loud, and it melts off as the staircase gets finer. Same tone, same sine, just more levels.

**aadharsh**14:22

back up. how does a ladder of resistors actually turn the bits into that exact voltage?

**DACs**14:22

It is a chain of voltage dividers built from only two resistor values, R and 2R, one rung per bit. The trick: from any rung, the resistance looking back toward the smaller bits always works out to R, so each rung halves the contribution of the one above it. The most significant bit lands Vref/2 at the output, the next Vref/4, then Vref/8, on down. Switch a bit to Vref and it adds its rung's share, so the total is Vref times the binary value over 2^N, all from two resistor values repeated.

the R-2R ladder · toggle bits, then add resistor error

An R-2R ladder turns N bits into one voltage from just two resistor values. Each raised bit adds half the previous bit's share: the MSB adds Vref/2, the next Vref/4, and so on. Toggle the bits, then crank the resistor tolerance and watch the transfer curve bend.

Vout = 0.500 Vref

The transfer curve over all 64 codes, ideal (straight) against actual. Errors in the big bits bend the line; push the tolerance and a step can run backward (red), a non-monotonic glitch. That is why a 20-bit ladder wants parts matched to about 1 part per million: the MSB resistor alone has to beat the size of the smallest step. Play a tone through the ladder and raise the tolerance: the bending curve turns into audible harmonic distortion, worst where a step runs backward.

**aadharsh**14:23

so a tiny error in the big bits wrecks it. that's where the cost goes.

**DACs**14:23

Exactly. Those resistors have to be matched to brutal tolerances, which is instrumentation hardware, not audio-grade parts. Schiit's Yggdrasil runs a quad of 20-bit Analog Devices AD5791 ladders, the same parts that sit in MRI machines, because ordinary chips can't hold that line.

[\[src\]](https://darko.audio/2018/04/dial-m-for-multi-bit-schiits-yggdrasil-analog-2-dac/)

**aadharsh**14:24

ok, delta-sigma. how do you get clean audio out of a switch that's basically on or off?

**DACs**14:24

Speed plus a feedback loop. Run a 1-bit quantizer at 64 to 256 times the audio rate, and feed the quantization error back so the output works out to `X(z)·z-1 + E(z)·(1 - z-1)`. That `(1 - z-1)` is a high-pass filter on the error: it shoves the noise up into ultrasonic frequencies, out of the band you hear, where a cheap analog filter wipes it. You trade amplitude precision for timing precision, which is exactly what digital is good at.

[\[src\]](https://en.wikipedia.org/wiki/Delta-sigma_modulation)

noise shaping · a live DFT

A delta-sigma DAC runs a coarse quantizer fast, with a feedback loop that shapes the quantization noise. Toggle it: the same 3-bit quantizer either way, but shaping pushes the error up out of the band you can hear (shaded).

3-bit quantizer, 1st-order shaping

Spectrum of the quantizer output. The spike is the tone; the floor is quantization noise. Shaping tilts that floor up and away from the shaded audible band. Play it and toggle shaping: OFF is a grainy in-band hash, ON pushes that hash up into a faint high hiss and clears the tone.

**aadharsh**14:25

huh. same coarse quantizer either way, but shaping pulls the floor down inside the band. that's the whole move?

**DACs**14:25

That's the whole move. Stack more integrators and the term becomes `(1 - z-1)2` or `3` for a steeper tilt. Because the quantizer is just a fast switch, it stays cheap and very linear, which is why nearly every DAC chip on the market (ESS, AKM, Cirrus) is delta-sigma and posts excellent THD and SNR.

**aadharsh**14:26

both end up as a stairstep or a 1-bit stream. how does that become a smooth analog wave? something filters it, right?

**DACs**14:26

The reconstruction filter, and it carries the other big optimization. The ideal one is a sinc, a perfect brick wall at 20 kHz, but a brick wall in frequency is an endless ripple in time. That is the Fourier tradeoff: you get sharpness in frequency or cleanliness in time, and tightening one loosens the other. A fast, sharp filter kills the images just above the band but rings; a slow filter rings less but rolls off some treble and lets a little imaging through. NOS DACs skip the filter (no ringing, images and all); oversampling first pushes the images far up, so a gentle filter can finish without ringing much.

reconstruction filter · time against frequency

A windowed-sinc reconstruction filter. Drag the sharpness: more taps steepen the frequency wall on the right, and the impulse response on the left rings longer to pay for it. You cannot tighten both at once.

Left: the impulse response in time, the sinc and its ringing. Right: the frequency response, flat through the shaded audio band and rolling off near Nyquist. A sharper wall on the right means longer ringing on the left. Play the click train and drag sharpness: the left graph IS what one click sounds like, so a sharper filter makes each click ring longer.

**aadharsh**14:27

so the filter shape is a taste call as much as a number on a spec sheet.

**DACs**14:27

Largely yes, and a lot of the audible gap between two competent DACs lives right here, more than in the last decimal of THD. It is also Mike Moffat's whole angle: instead of the stock windowed-sinc he ships a custom closed-form filter, the kind of choice a measurement cannot fully settle.

**aadharsh**14:28

so if delta-sigma measures better and costs less, why does multibit still have a cult around it?

**DACs**14:28

Two honest reasons. First, coarse bits are audible when nothing shapes them away, and some listeners argue the modulator's behavior on quiet passages and decay sounds different in ways a steady-tone measurement won't show. Second, Mike Moffat, the digital half of Schiit, bet a company on multibit, the ladders plus that closed-form filter, and built a following that hears a difference. The measurable gap is tiny and often below audibility; the preference is real to the people who hold it and hard to reduce to one number.

[\[src\]](http://lucasbosch.de/schiit/jason-stoddard-shiit-happened-tablet-lblb.pdf)

**aadharsh**14:30

I get the theory, but I still can't reconcile what people MEAN by the multibit sound versus delta-sigma. can you make that difference concrete?

**DACs**14:30

The honest place it lives is low-level linearity: the soft tail of a note, where only the bottom bits are working. Multibit rounds to its nearest exact level, which down there bends the wave into harmonic distortion. Delta-sigma keeps the level honest on average and trades that for a shaped noise floor. Same quiet tone, two different imperfections. Here they are side by side, as spectra you can also play.

the contested ground · low-level linearity

Where the multibit-versus-delta-sigma argument actually lives: a quiet tone, the soft tail of a note, where only the lowest bits are working. Drag the bit depth. Multibit rounds to its nearest exact level, which at low level bends the wave into harmonic distortion; delta-sigma keeps the level honest on average but rides a shaped noise floor. Same tone, two flavors of imperfection.

multibit (round to level)

delta-sigma (noise-shaped)

Both spectra are the same quiet tone. Multibit sprouts harmonic spikes at the tone's multiples (distortion); delta-sigma stays a single clean spike on a raised noise floor (no harmonics). Push the bit depth toward 16 and both shrink below hearing.

**aadharsh**14:31

so multibit adds harmonics, delta-sigma adds noise, and by 16-bit both basically vanish.

**DACs**14:31

That is the whole reconciliation: pick your imperfection. Harmonic distortion can read as warmth or as grit; a noise floor reads as clean, though some hear it as veiling. On good 24-bit gear both sit below audibility, so the preference comes down to taste and system matching rather than a measurement. Real multibit DACs usually dither as well, which trades their distortion for a noise floor of their own and narrows the gap further.

hear the bit depth

Quantization noise is audible when the bit depth is low. Click to hear a 440 Hz tone quantized to each depth (about a second each, through your speakers).

Same tone, fewer levels. At 2-bit the error is loud hash; by 16-bit it's gone. Delta-sigma keeps the bits low and moves that hash above 20 kHz instead.

**aadharsh**14:29

yeah, I can hear the hash at 2-bit, and it's gone by 16. and delta-sigma just shoves that hash above 20k instead of spending money to delete it.

**DACs**14:29

Right. Multibit pays in hardware to make every level physically exact. Delta-sigma pays in cleverness to make the errors inaudible. Both arrive at clean sound; they just disagree about where to put the hard part, and the filter is where a lot of the audible character is decided.

**aadharsh**14:32

one more, since you keep landing on that word. "warmth" is the exact thing people say about tube amps. is the multibit version literally the same effect a tube has?

**DACs**14:32

Same family, and it is worth seeing why. Both bend the wave into harmonics; the character is set by *which* ones. A gentle, lopsided curve, the kind a single tube makes, adds mostly the 2nd harmonic, which sits exactly one octave above the note, so your ear reads it as fuller rather than dirty. Drive the same tone into a hard, symmetric clip and the even harmonics cancel, leaving the odd ones (3rd, 5th, 7th) that climb toward a square wave, the buzz of a signal slammed flat into its rails. Push the curve below and watch which harmonics grow.

[\[src\]](https://en.wikipedia.org/wiki/Valve_sound)

tube warmth · drive a sine into the curve

Past the DAC, the signal meets an amplifier, and this is where "warmth" gets built on purpose. A single tube's transfer curve is gently lopsided, so it grows mostly the **2nd harmonic**, one octave up. A hard, symmetric clip cancels the even harmonics and grows odd ones instead, heading for a square wave. Drive it, switch the curve, and watch the spectrum; hit play to hear it.

Left: the transfer curve, output against input, the straight dashed line being no distortion at all. The tube curve bows more on one side (asymmetric, even harmonics); the clip flattens both rails alike (symmetric, odd harmonics). Middle: what that does to a sine. Bottom: the harmonics, each labeled by its multiple of the note. **2×** is the octave that reads as warmth; the odd stack (3×, 5×, 7×...) is the square-wave buzz. Real tubes add some higher-order even harmonics too; this isolates the dominant 2nd. Hit play, then keep driving and toggling: the tone shifts in real time, no need to re-press.

**aadharsh**14:33

so the 2nd harmonic IS the octave, that's why it reads as musical, and hard clipping just collapses into a square, all odd harmonics. the asymmetry is the whole tell.

**DACs**14:33

That is the tell, and it is the same axis the DAC argument rides. A little 2nd harmonic is what some people are chasing when a multibit ladder or a tube stage "sounds warm," even as the meter reports higher THD. A square wave is just the far end of that dial: every bit of headroom spent, nothing left but the odd harmonics.

**aadharsh**14:34

clearest version of this I've read. thanks.

→ [Schiit Happened (Jason Stoddard)](http://lucasbosch.de/schiit/jason-stoddard-shiit-happened-tablet-lblb.pdf) · [the head-fi thread](https://www.head-fi.org/threads/schiit-happened-the-story-of-the-gods-of-noise.701900/) · [delta-sigma on Wikipedia](https://en.wikipedia.org/wiki/Delta-sigma_modulation) · [back to Learning With Errors](https://aadhar.sh/lwe)

end of first pass

This is a recorded conversation. The demos above run live: drag, toggle, and click to hear.

Source: https://aadhar.sh/lwe/dac
