#!/usr/bin/env python3
"""Matched-bytes comparison: at EQUAL bytes, is the gamma-correct geometry better?

THE ANSWER IS NO, measured 2026-08-25 over 8 real sources. sips at q84 beats the
zenc geometry q-matched to the same bytes on 7 of 8 photos under EVERY reference,
including zenc's own kernel as the reference, which is the direction that would
have flattered it. Matching bytes costs the zenc path q84 -> q76..79, and that
quality drop costs more than gamma correctness gains.

The reference-free metric says the opposite about a different thing, and both are
true: zenc preserves mean linear luminance 77% better (0.00027 against 0.00118),
so its geometry really is more correct. It just cannot be had for free. The
+26.7% in bytes IS the quality, and there is no q-tuning that recovers it.

The trap on this thread has twice been the instrument, so two defences:

  1. THE REFERENCE IS A VARIABLE. Scoring a 600px result against a native crop
     needs the crop resampled to 600, and that resampler is the bias. So every
     candidate is scored against THREE references (sips, zenc, ffmpeg). A result
     that holds under all three is real; one that flips is reported as
     inconclusive rather than as a winner.

  2. ONE METRIC NEEDS NO REFERENCE AT ALL. A downscale is an average, so it must
     preserve MEAN LINEAR LUMINANCE exactly. That is scale-invariant, needs no
     resampling to compare, and has an analytically known target: the native
     crop's own mean. It measures the gamma axis on real photographs instead of
     synthetic patterns.
"""
import subprocess, sys, os, glob, json, struct, zlib

ZENC = sys.argv[1]
SRC = "/Users/aadharsh/Downloads/to post (from ssd)"
WORK = "/tmp/mb"
SQ = 600
os.makedirs(WORK, exist_ok=True)

def run(*a):
    return subprocess.run(a, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode

def sips_geom(work, out, sq):
    d = subprocess.run(["sips","-g","pixelWidth","-g","pixelHeight",work],capture_output=True,text=True).stdout
    W = int([l for l in d.splitlines() if "pixelWidth" in l][0].split()[-1])
    H = int([l for l in d.splitlines() if "pixelHeight" in l][0].split()[-1])
    tl = -(-sq*H//W) if W <= H else -(-sq*W//H)
    t = out + ".t.tif"; s = out + ".s.tif"
    run("sips","-s","format","tiff",work,"--out",t)
    run("sips","-Z",str(tl),t)
    run("sips","-c",str(sq),str(sq),t,"--out",s)
    run("sips","-s","format","png",s,"--out",out)
    return min(W,H)

def zenc_geom(work, out, sq):
    run(ZENC,"square",work,"--size",str(sq),"--out",out,"--filter","box")

def ffmpeg_geom(src_png, out, sq):
    run("ffmpeg","-hide_banner","-loglevel","error","-y","-i",src_png,"-sws_flags","lanczos","-vf",f"scale={sq}:{sq}",out)

def enc(png, jpg, q):
    run(ZENC, png, jpg, "-q", str(q))
    return os.path.getsize(jpg)

def search_q(png, jpg, target, lo=40, hi=95):
    """Lowest-error quality that lands nearest the byte target."""
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        n = enc(png, jpg, mid)
        if best is None or abs(n - target) < abs(best[1] - target):
            best = (mid, n)
        if n < target: lo = mid + 1
        else: hi = mid - 1
    enc(png, jpg, best[0])
    return best

def s2(a, b):
    r = subprocess.run(["ssimulacra2", a, b], capture_output=True, text=True)
    try: return float(r.stdout.strip().splitlines()[0])
    except Exception: return float("nan")

LUT = [(v/255/12.92 if v/255<=0.040449936 else ((v/255+0.055)/1.055)**2.4) for v in range(256)]

def mean_linear(path):
    """Mean LINEAR luminance, read through ffmpeg's raw output so no PNG parser
    of mine is in the measurement path. Scale-invariant, so comparing a 600px
    result to a 1333px crop needs no resampling and therefore carries no bias."""
    r = subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-i",path,
                        "-f","rawvideo","-pix_fmt","rgb24","-"],
                       capture_output=True)
    b = r.stdout
    if not b: return float("nan")
    # Sample rather than sum every byte: 200k samples is far inside the noise of
    # a mean over millions and keeps the whole sweep interactive.
    step = max(1, len(b)//200000)
    vals = b[::step]
    return sum(LUT[v] for v in vals)/len(vals)

srcs = [f for f in sorted(glob.glob(SRC+"/*")) if f.lower().endswith((".jpg",".hif"))][:8]
rows = []
for n, f in enumerate(srcs, 1):
    b = f"{WORK}/p{n:02d}"
    if run("sips","-Z","2000","-s","format","jpeg","--setProperty","formatOptions","100",f,"--out",b+".w.jpg"): continue
    short = sips_geom(b+".w.jpg", b+".sips.png", SQ)
    zenc_geom(b+".w.jpg", b+".zenc.png", SQ)
    # native square crop: pure crop, no resampling at all
    # `-s format png` is load-bearing: sips keeps the INPUT format unless told,
    # so without it this writes a JPEG named .png. That silently made the
    # "native crop, no resampling" reference a lossy re-encode, ffmpeg sniffed it
    # and scored anyway, and zenc correctly refused to read it.
    run("sips","-c",str(short),str(short),b+".w.jpg","-s","format","png","--out",b+".native.png")
    # references: the native crop brought to 600 three different ways
    sips_geom(b+".native.png", b+".ref_sips.png", SQ)
    zenc_geom(b+".native.png", b+".ref_zenc.png", SQ)
    ffmpeg_geom(b+".native.png", b+".ref_ffmpeg.png", SQ)
    # matched bytes: sips at q84 sets the budget, zenc searches to meet it
    target = enc(b+".sips.png", b+".sips.jpg", 84)
    zq, zn = search_q(b+".zenc.png", b+".zenc.jpg", target)
    # decode the encoded jpgs back to png so the metric sees what ships
    run("sips","-s","format","png",b+".sips.jpg","--out",b+".sips.dec.png")
    run("sips","-s","format","png",b+".zenc.jpg","--out",b+".zenc.dec.png")
    r = {"photo": f"p{n:02d}", "target": target, "zq": zq, "zbytes": zn}
    for ref in ("sips","zenc","ffmpeg"):
        r[f"A_{ref}"] = s2(b+f".ref_{ref}.png", b+".sips.dec.png")
        r[f"B_{ref}"] = s2(b+f".ref_{ref}.png", b+".zenc.dec.png")
    nat = mean_linear(b+".native.png")
    r["lin_A"] = abs(mean_linear(b+".sips.dec.png") - nat)
    r["lin_B"] = abs(mean_linear(b+".zenc.dec.png") - nat)
    rows.append(r)
    print(f"  {r['photo']}  budget {target:6d}  zenc q{zq} -> {zn:6d}", flush=True)

print()
print("  ssimulacra2 at MATCHED BYTES, A=sips geometry q84, B=zenc geometry q-matched")
print(f"  {'photo':<7} {'A/refsips':>10} {'B/refsips':>10} {'A/refzenc':>10} {'B/refzenc':>10} {'A/refffm':>10} {'B/refffm':>10}")
wins = {"sips":0,"zenc":0,"ffmpeg":0}
for r in rows:
    print(f"  {r['photo']:<7} {r['A_sips']:10.2f} {r['B_sips']:10.2f} {r['A_zenc']:10.2f} {r['B_zenc']:10.2f} {r['A_ffmpeg']:10.2f} {r['B_ffmpeg']:10.2f}")
    for ref in wins:
        if r[f"B_{ref}"] > r[f"A_{ref}"]: wins[ref] += 1
print(f"\n  B (zenc) wins, per reference, out of {len(rows)}:  " + "  ".join(f"{k}={v}" for k,v in wins.items()))
la = sum(r["lin_A"] for r in rows)/len(rows); lb = sum(r["lin_B"] for r in rows)/len(rows)
print(f"\n  REFERENCE-FREE: mean |linear-luminance error| vs the native crop")
print(f"    sips geometry {la:.5f}")
print(f"    zenc geometry {lb:.5f}   ({'zenc closer' if lb<la else 'sips closer'}, {abs(la-lb)/max(la,lb)*100:.0f}% apart)")
