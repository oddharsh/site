#!/usr/bin/env python3
"""Rebuild the /pixel-peeper trial set from the canonical photo source.

The first trial set was cut by hand and never committed a generator, which is
exactly how its encoder trials ended up comparing encodes at different file
sizes: `sips` was handed 23-43% more bytes than its rivals and then "won" the
metrics for it. A trial that does not hold bytes constant teaches the wrong
lesson, so the byte budget is enforced here by search rather than by hope.

Three rules this script exists to enforce:

  1. ENCODER trials share ONE byte budget. Every encoder's quality knob is
     binary-searched until its output lands inside BUDGET_TOL of the target,
     and an encoder that cannot reach the budget is dropped from the trial
     rather than shipped as an unequal comparison.
  2. QUALITY trials are picked for a WIDE, visible spread. The ladder is
     encoded and measured first, then three rungs are chosen by their
     ssimulacra2 distance from the top rung, so every quality call has a
     clearly-worst option no matter how forgiving the crop turns out to be.
  3. Trials that fail their axis's legibility threshold are REJECTED and
     reported, not quietly shipped. A call nobody can see is not a test.

Usage:
    python3 holding/scripts/gen-pixel-peeper.py            # full rebuild
    python3 holding/scripts/gen-pixel-peeper.py --dry-run  # measure, write nothing

Needs: zenc (cargo build in scripts/zenc), cjpegli, mozjpeg's cjpeg, sips,
ssimulacra2, butteraugli_main, and Pillow.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

# ---------------------------------------------------------------- paths + tools

REPO = Path(__file__).resolve().parents[2]
SRC_DIR = Path("/Users/aadharsh/Downloads/to post (from ssd)")
OUT_DIR = REPO / "holding" / "pixel-peeper"
TILES_DIR = OUT_DIR / "tiles"

ZENC = REPO / "holding" / "scripts" / "zenc" / "target" / "release" / "zenc"
CJPEGLI = shutil.which("cjpegli") or str(Path.home() / ".local/bin/cjpegli")
CJPEG = "/opt/homebrew/opt/mozjpeg/bin/cjpeg"
SSIMULACRA2 = shutil.which("ssimulacra2") or "/opt/zerobrew/prefix/bin/ssimulacra2"
BUTTERAUGLI = shutil.which("butteraugli_main") or "/opt/zerobrew/prefix/bin/butteraugli_main"

TILE = 320         # tile edge, cropped at NATIVE resolution — 1:1 pixels is the point
BUDGET_TOL = 0.02  # equal-budget trials: every option within +/-2% of the target
# 2% is the floor an INTEGER quality knob can actually hold. The knob moves size in
# jumps of 2-5% near the working range, so demanding tighter than this just throws
# away good trials to no benefit. For scale, the hand-cut set this replaces ran
# 23-43% apart and called it an encoder comparison.

# --------------------------------------------------------------- the trial plan
#
# The mix is deliberately lopsided AWAY from chroma. The old set ran 9 of 18
# trials on chroma (3 "chroma" + 6 "tradeoff"), and chroma is the axis human
# eyes are worst at: the test read as brutal because half of it was asking
# people to see something their visual system does not resolve. Chroma is still
# worth teaching, so it stays — as a minority, on the most saturated crops
# available, where the effect is actually visible.

# Candidates are OVER-PROVISIONED and then ranked: every one is built and measured,
# and only the most legible `keep` survive per axis. That way the shipped set is
# chosen on measured visibility rather than on which photo I happened to like.
CANDIDATES = {
    # axis: (crop intent, keep, [source stems])
    "quality": ("detail", 8, [
        "XT507494",   # chrome grille — fine mesh
        "XT509278",   # red grille, black mesh
        "XT507955",   # metal staircase, yellow stripes
        "XT509986",   # subway signage — text edges
        "XT508055",   # mountain road sign
        "XT507517",   # license plate lettering
        "XT509535",   # Coca-Cola livery — text on a curve
        "XT509509",   # train livery lettering
        "XT509965",   # pier sign
        "XT507940",   # framed painting
        "XT509488",   # hand + pen, skin detail
    ]),
    "encoder": ("detail", 6, [
        "XT509794",   # brick road texture
        "XT509848",   # brick + paint
        "XT509388",   # coat of arms
        "XT509540",   # motorcycle number plate
        "XT508890",   # blossom — foliage is encoder-hard
        "XT509276",   # red car, white wheel
        "XT509446",   # staircase, yellow line
        "XT509892",   # two cars, mixed texture
        "XT507343",   # yellow/black sticker on glass
        "XT509721",   # shirt + cap weave
        "XT508756",   # knit + jacket texture
        "XT509698",   # jersey mesh
        "XT508790",   # roofline against sky
    ]),
    # Chroma is the axis where candidates die. The survivors all look the same:
    # a HIGH-CONTRAST TWO-TONE boundary (livery stripes, signage, a painted edge
    # against chrome), never a big saturated panel. Feed it accordingly, and
    # expect most of this list to be rejected — that rejection IS the finding.
    "chroma": ("color", 3, [
        "XT509540",   # red/white motorcycle — livery stripes
        "XT507343",   # yellow/black sticker on glass
        "XT509814",   # blue car, yellow stripe
        "XT509839",   # red car, yellow sticker
        "XT509779",   # blue car beside a yellow taxi
        "XT509276",   # red car, white wheel
        "XT509085",   # yellow building, two figures
        "XT509446",   # staircase, yellow line
        "XT509892",   # black car beside a yellow one
        "XT509794",   # yellow car on brick
        "XT508947",   # beer crates, three saturated hues
        "XT508890",   # pink blossom against sky
        "XT509535",   # Coca-Cola red on white
        "XT509987",   # wings sign
    ]),
    "tradeoff": ("color", 3, [
        "XT509987",   # wings sign
        "XT509315",   # colourful umbrella
        "XT509534",   # yellow car, red seat
        "XT509535",   # Coca-Cola red
        "XT508947",   # beer crates
        "XT509509",   # train livery
        "XT509809",   # yellow car, red interior
        "XT509346",   # orange mirror
    ]),
}

# How each axis ranks its survivors — bigger sorts first, so ships first.
#
# The two colour axes rank differently ON PURPOSE. `chroma` teaches a visible
# lesson, so it ranks on how much 4:2:0 actually costs. `tradeoff` exists to
# FEED the metric-alignment needle, which only reads calls where the two metrics
# disagree, so a tradeoff trial that splits them beats one that does not however
# pretty its numbers are.
RANK = {
    "quality":  lambda t: t["spread"],
    "encoder":  lambda t: t["spread"],
    "chroma":   lambda t: t["spread"],   # structural damage is what a person can SEE
    "tradeoff": lambda t: (1 if t["disagree"] else 0, t.get("penalty", 0)),
}

# Legibility thresholds. A trial that cannot clear these is dropped, because a
# call whose options are indistinguishable teaches nothing and just feels hard.
QUALITY_MID_GAP = 10.0   # ssimulacra2 points between top rung and middle rung
QUALITY_LOW_GAP = 26.0   # ...and between top rung and bottom rung
QUALITY_MIN_SPREAD = 18.0
ENCODER_MIN_SPREAD = 3.5   # s2 points between the best and worst encoder at equal bytes
CHROMA_MIN_BUTTER = 0.25   # butteraugli penalty 4:2:0 must take over 4:2:2
# ...and it has to cost STRUCTURE too. 1.2 was the first guess and it was too
# loose: it passed a flat orange panel whose two encodes are indistinguishable
# side by side, because at that margin the "gap" is measuring grain. 3.0 is where
# a contact sheet starts showing a difference a person can point at.
CHROMA_MIN_S2 = 3.0
COLOR_MIN_SAT = 34.0       # mean 0-255 saturation a 'color' crop must carry to qualify
# Large-scale contrast a 'detail' crop must have, so pure grain is excluded.
# Measured rather than guessed, and the gap is wide: the one ambiguous crop in
# the shipped set (flat grainy sky) scores 0.95, while every crop that made a
# legible call scores 16 to 58. Anywhere in between works; 12 keeps margin.
DETAIL_MIN_STRUCT = 12.0

QUALITY_LADDER = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 88, 91, 94, 96]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def run(cmd, **kw):
    return subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)


# ------------------------------------------------------------------ source load

def load_source(stem, tmp):
    """Decode a source frame to RGB. HIF goes through sips; everything else Pillow."""
    matches = [p for p in SRC_DIR.iterdir() if p.stem == stem]
    if not matches:
        raise FileNotFoundError(f"{stem} not in {SRC_DIR}")
    path = matches[0]
    if path.suffix.lower() in (".hif", ".heic"):
        png = tmp / f"{stem}-src.png"
        r = run(["sips", "-s", "format", "png", path, "--out", png])
        if r.returncode != 0 or not png.exists():
            raise RuntimeError(f"sips could not decode {path.name}: {r.stderr.strip()}")
        im = Image.open(png)
    else:
        im = Image.open(path)
        im = ImageOps.exif_transpose(im)   # camera writes a rotation hint, not rotated pixels
    return im.convert("RGB")


# ---------------------------------------------------------------- crop choosing

def _saturation(im):
    r, g, b = im.split()
    mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
    mn = ImageChops.darker(ImageChops.darker(r, g), b)
    return ImageChops.subtract(mx, mn)


def _structure(win):
    """How much large-scale light/dark SHAPE the window has. Grain scores ~0.

    Every edge-energy measure tried here is really a grain meter, and grain is
    the thing that makes a call unanswerable: three encodes of a flat noisy sky
    differ only in how much grain survived, and "which looks best" then has no
    honest answer — some people prefer the smoother one. Both FIND_EDGES stddev
    and its downsampled variant ranked that sky ABOVE a two-tone racing livery
    whose lettering visibly softens at every quality step.

    Collapsing to 16x16 throws away all texture and leaves only the big regions.
    A livery (dark panel against pale lettering) keeps a wide spread; uniform
    grain averages to a flat field and scores near zero. That is the distinction
    that matters, because shapes are what a person can actually judge.
    """
    return ImageStat.Stat(win.convert("L").resize((16, 16), Image.LANCZOS)).stddev[0]


def score_window(win, intent):
    """Higher is a better tile: SHAPES for 'detail', colour-EDGY for 'color'."""
    edges = win.convert("L").filter(ImageFilter.FIND_EDGES)
    detail = ImageStat.Stat(edges).stddev[0]
    if intent == "detail":
        # Fine detail RANKS (it is what falling quality destroys, and it reliably
        # finds grilles, brickwork and lettering). Structure only GATES. Ranking
        # on structure instead was tried and was worse across the board: it
        # picked big soft out-of-focus panels with one smooth boundary, which
        # have almost no fine detail for quality to take away. The narrow failure
        # being fixed is a crop of pure grain, nothing more.
        if _structure(win) < DETAIL_MIN_STRUCT:
            return -1e6
        return detail
    # 4:2:0 does not damage saturated FLAT areas — halving the resolution of a
    # field of solid red loses nothing. It damages saturated BOUNDARIES, where a
    # hue changes faster than the halved chroma plane can carry.
    #
    # Two wrong cuts of this got shipped to a contact sheet before this one.
    # Ranking by mean saturation picked big flat red panels (nothing to see).
    # Ranking by full-resolution chroma gradient was worse and sneakier: it
    # picked grey speckled STONE, because per-pixel colour noise has enormous
    # chroma gradient. That crop scored a 4.45 ssimulacra2 gap between 4:2:2 and
    # 4:2:0 — a real number, measuring damage to noise nobody can see.
    #
    # Windows arrive here already downscaled ~5x by best_crop's proxy, which is
    # what suppresses the pixel noise; the fix that mattered is the SATURATION
    # GATE below. Grey stone has huge chroma gradient and almost no saturation,
    # so gating on saturation is what tells the two apart.
    r, g, b = win.split()
    sat = _saturation(win)
    mean_sat = ImageStat.Stat(sat).mean[0]
    if mean_sat < COLOR_MIN_SAT:
        return -1e6           # not a colour crop at all, whatever its gradients say
    # Saturation is a GATE, never a multiplier. Multiplying by it (the third wrong
    # cut) ranked a flat orange panel top of the pool: maximum saturation, no
    # boundary, nothing for 4:2:0 to damage. The boundary term has to lead.
    coarse = (ImageStat.Stat(sat.filter(ImageFilter.FIND_EDGES)).stddev[0]
              + ImageStat.Stat(ImageChops.difference(r, b).filter(ImageFilter.FIND_EDGES)).stddev[0])
    return coarse + detail * 0.05


def best_crop(im, intent):
    """Scan candidate windows on a coarse proxy, then cut the winner at native res."""
    W, H = im.size
    if W < TILE or H < TILE:
        raise RuntimeError(f"source smaller than a tile: {W}x{H}")
    # Score on a downscaled proxy so the scan is cheap, then map the window back.
    scale = min(1.0, 1400 / max(W, H))
    proxy = im.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    pw, ph = proxy.size
    box = max(8, int(TILE * scale))
    if box > min(pw, ph):
        box = min(pw, ph)
    stride = max(4, box // 3)
    best, best_s = None, -1e9
    for y in range(0, ph - box + 1, stride):
        for x in range(0, pw - box + 1, stride):
            s = score_window(proxy.crop((x, y, x + box, y + box)), intent)
            if s > best_s:
                best_s, best = s, (x, y)
    if best_s <= -1e5:
        raise RuntimeError(f"no window carries enough colour (mean sat < {COLOR_MIN_SAT})")
    # Map proxy coords back to native, clamped so the tile stays inside the frame.
    nx = min(W - TILE, max(0, int(best[0] / scale)))
    ny = min(H - TILE, max(0, int(best[1] / scale)))
    return im.crop((nx, ny, nx + TILE, ny + TILE)), best_s


# -------------------------------------------------------------------- encoders

MOZ_SAMPLE = {"444": "1x1", "422": "2x1", "420": "2x2"}


def encode(kind, srcs, out, q, chroma="420"):
    """One encode. `srcs` carries the crop in each form an encoder can read."""
    out = Path(out)
    if kind == "zenc":
        r = run([ZENC, srcs["png"], out, "-q", str(q), "--yuv", chroma])
    elif kind == "jpegli":
        r = run([CJPEGLI, srcs["png"], out, "-q", str(q),
                 f"--chroma_subsampling={chroma}"])
    elif kind == "mozjpeg":
        r = run([CJPEG, "-quality", str(q), "-sample", MOZ_SAMPLE[chroma],
                 "-outfile", out, srcs["ppm"]])
    elif kind == "sips":
        # sips exposes no chroma control at all — it picks its own subsampling per
        # quality. That is a real property of the macOS encoder, not a gap in the
        # harness, and the encoder axis asks what you get for N bytes.
        if out.exists():
            out.unlink()
        r = run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(q),
                 srcs["png"], "--out", out])
    else:
        raise ValueError(kind)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(f"{kind} q={q} produced nothing: {r.stderr.strip()[:200]}")
    return out.stat().st_size


def search_quality(kind, srcs, tmp, target, chroma="420", lo=5, hi=100):
    """Binary-search the quality knob until the output lands on `target` bytes.

    Returns (q, bytes, path) for the closest attempt, whether or not it made
    tolerance — the caller decides whether to keep it.
    """
    out = tmp / f"search-{kind}.jpg"
    best = None
    seen = {}
    while lo <= hi:
        mid = (lo + hi) // 2
        if mid in seen:
            break
        size = encode(kind, srcs, out, mid, chroma)
        seen[mid] = size
        keep = tmp / f"cand-{kind}-{mid}.jpg"
        shutil.copyfile(out, keep)
        if best is None or abs(size - target) < abs(best[1] - target):
            best = (mid, size, keep)
        if size > target:
            hi = mid - 1
        elif size < target:
            lo = mid + 1
        else:
            break
    return best


# --------------------------------------------------------------------- metrics

def to_png(jpg, png):
    Image.open(jpg).convert("RGB").save(png)
    return png


def ssim2(ref_png, test_png):
    r = run([SSIMULACRA2, ref_png, test_png])
    m = re.search(r"-?\d+\.\d+", r.stdout)
    if not m:
        raise RuntimeError(f"ssimulacra2 said: {r.stdout.strip()} {r.stderr.strip()}")
    return round(float(m.group()), 2)


def butter(ref_png, test_png):
    r = run([BUTTERAUGLI, ref_png, test_png])
    m = re.search(r"-?\d+\.\d+", r.stdout)
    if not m:
        raise RuntimeError(f"butteraugli said: {r.stdout.strip()} {r.stderr.strip()}")
    return round(float(m.group()), 3)


def measure(ref_png, jpg, tmp, both=True):
    png = to_png(jpg, tmp / (Path(jpg).stem + "-dec.png"))
    s2 = ssim2(ref_png, png)
    bu = butter(ref_png, png) if both else None
    return s2, bu


# ------------------------------------------------------------- trial builders

def mark_winners(options):
    """Tag each metric's favourite and say whether the two of them split."""
    best_s2 = max(o["s2"] for o in options)
    best_bu = min(o["butter"] for o in options)      # butteraugli: lower is better
    for o in options:
        o["s2best"] = o["s2"] == best_s2
        o["butterbest"] = o["butter"] == best_bu
    s2_pick = next(o for o in options if o["s2best"])
    bu_pick = next(o for o in options if o["butterbest"])
    return s2_pick is not bu_pick


def build_quality(crop_id, srcs, ref_png, tmp):
    """Encode the ladder, then pick three rungs spread far enough apart to SEE."""
    rungs = []
    for q in QUALITY_LADDER:
        p = tmp / f"q{q}.jpg"
        size = encode("zenc", srcs, p, q, "420")
        s2 = ssim2(ref_png, to_png(p, tmp / f"q{q}.png"))
        rungs.append({"q": q, "bytes": size, "s2": s2, "path": p})
    top = max(rungs, key=lambda r: r["s2"])
    pick = lambda gap: min(rungs, key=lambda r: abs((top["s2"] - r["s2"]) - gap))
    mid, low = pick(QUALITY_MID_GAP), pick(QUALITY_LOW_GAP)
    chosen = []
    for r in (low, mid, top):
        if any(c["q"] == r["q"] for c in chosen):
            continue
        chosen.append(r)
    if len(chosen) < 3:
        return None, "ladder collapsed — fewer than 3 distinct rungs"
    spread = chosen[-1]["s2"] - chosen[0]["s2"]
    if spread < QUALITY_MIN_SPREAD:
        return None, f"spread only {spread:.1f} s2 (want {QUALITY_MIN_SPREAD})"
    options = []
    for r in chosen:
        s2, bu = measure(ref_png, r["path"], tmp)
        options.append({"label": f"quality {r['q']}", "bytes": r["bytes"],
                        "s2": s2, "butter": bu, "q": r["q"], "path": r["path"]})
    disagree = mark_winners(options)
    return {"axis": "quality", "crop": crop_id, "options": options,
            "disagree": disagree, "spread": round(spread, 1)}, None


def build_encoder(crop_id, srcs, ref_png, tmp):
    """One byte budget, four encoders, each searched onto it. This is the fix."""
    # The budget is whatever zenc spends at a middling quality — a real-world
    # web-export size for this crop rather than a number picked out of the air.
    probe = tmp / "budget-probe.jpg"
    target = encode("zenc", srcs, probe, 72, "420")

    options, rejected = [], []
    for kind in ("zenc", "jpegli", "mozjpeg", "sips"):
        try:
            got = search_quality(kind, srcs, tmp, target, "420")
        except Exception as e:                      # noqa: BLE001 — report, don't crash the run
            rejected.append(f"{kind}: {e}")
            continue
        if got is None:
            rejected.append(f"{kind}: search found nothing")
            continue
        q, size, path = got
        drift = abs(size - target) / target
        if drift > BUDGET_TOL:
            rejected.append(f"{kind}: closest was {size}B, {drift*100:.1f}% off budget")
            continue
        s2, bu = measure(ref_png, path, tmp)
        options.append({"label": kind, "bytes": size, "s2": s2, "butter": bu,
                        "q": q, "path": path})

    if len(options) < 2:
        return None, f"only {len(options)} encoder(s) hit the budget; {rejected}"
    # Three tiles is the widest the UI lays out, so keep the most separated set:
    # the s2 winner, the s2 loser, and whichever middle option sits furthest from
    # both, which is what makes the call readable instead of a three-way tie.
    options.sort(key=lambda o: o["s2"])
    if len(options) > 3:
        lo, hi = options[0], options[-1]
        mids = options[1:-1]
        mid = max(mids, key=lambda o: min(abs(o["s2"] - lo["s2"]), abs(o["s2"] - hi["s2"])))
        options = [lo, mid, hi]
    spread = options[-1]["s2"] - options[0]["s2"]
    if spread < ENCODER_MIN_SPREAD:
        return None, f"encoders within {spread:.1f} s2 at equal bytes — nothing to see"
    budget_drift = max(abs(o["bytes"] - target) for o in options) / target
    disagree = mark_winners(options)
    return {"axis": "encoder", "crop": crop_id, "options": options,
            "disagree": disagree, "spread": round(spread, 1),
            "budget": target, "budget_drift": round(budget_drift * 100, 2),
            "rejected": rejected}, None


def build_chroma(crop_id, srcs, ref_png, tmp):
    """Same quality setting, full colour vs halved. Bytes differ — that IS the axis."""
    Q = 80
    out = []
    for chroma, label in (("422", "4:2:2 · full source color"),
                          ("420", "4:2:0 · color halved")):
        p = tmp / f"chroma-{chroma}.jpg"
        size = encode("zenc", srcs, p, Q, chroma)
        s2, bu = measure(ref_png, p, tmp)
        out.append({"label": label, "bytes": size, "s2": s2, "butter": bu,
                    "q": Q, "chroma": chroma, "path": p})
    penalty = out[1]["butter"] - out[0]["butter"]
    if penalty < CHROMA_MIN_BUTTER:
        return None, f"4:2:0 only costs {penalty:.3f} butteraugli — invisible, skip it"
    spread = abs(out[0]["s2"] - out[1]["s2"])
    if spread < CHROMA_MIN_S2:
        return None, f"4:2:0 costs only {spread:.2f} s2 — the colour tell is not visible"
    disagree = mark_winners(out)
    return {"axis": "chroma", "crop": crop_id, "options": out, "disagree": disagree,
            "penalty": round(penalty, 3), "spread": round(spread, 2)}, None


def build_tradeoff(crop_id, srcs, ref_png, tmp):
    """Equal bytes, forced trade: 4:2:0 buys sharpness with the colour budget."""
    Q422 = 80
    p422 = tmp / "trade-422.jpg"
    target = encode("zenc", srcs, p422, Q422, "422")
    got = search_quality("zenc", srcs, tmp, target, "420")
    if got is None:
        return None, "no 4:2:0 quality hits the 4:2:2 budget"
    q420, size420, p420 = got
    drift = abs(size420 - target) / target
    if drift > BUDGET_TOL:
        return None, f"4:2:0 closest was {size420}B vs {target}B ({drift*100:.1f}% off)"
    options = []
    for path, label, q, chroma, size in (
        (p420, "4:2:0 · sharper, color halved", q420, "420", size420),
        (p422, "4:2:2 · full source color, softer", Q422, "422", target),
    ):
        s2, bu = measure(ref_png, path, tmp)
        options.append({"label": label, "bytes": size, "s2": s2, "butter": bu,
                        "q": q, "chroma": chroma, "path": path})
    disagree = mark_winners(options)
    drift = abs(options[0]["bytes"] - options[1]["bytes"]) / target
    return {"axis": "tradeoff", "crop": crop_id, "options": options,
            "disagree": disagree, "budget": target,
            "budget_drift": round(drift * 100, 2),
            # how hard the two sides pull apart: the colour cost of 4:2:0 against
            # the sharpness it bought. A trade nobody can feel ranks last.
            "penalty": round(abs(options[0]["butter"] - options[1]["butter"]), 3)}, None


BUILDERS = {"quality": build_quality, "encoder": build_encoder,
            "chroma": build_chroma, "tradeoff": build_tradeoff}


# ------------------------------------------------------------------------ main

def describe(t):
    bits = " ".join(f"{o['label'].split(' · ')[0]}={o['bytes']}B/s2 {o['s2']}"
                    for o in t["options"])
    if "budget_drift" in t:
        bits += f" [budget {t['budget']}B, drift {t['budget_drift']}%]"
    if "spread" in t:
        bits += f" spread {t['spread']}"
    if "penalty" in t:
        bits += f" penalty {t['penalty']}"
    if t["disagree"]:
        bits += " SPLIT"
    return bits


def write_sheet(trials, path):
    """Lay every trial's options side by side at 1:1 so a HUMAN can check them.

    This exists because the metrics lie about visibility in a specific way: a
    crop of grey speckled stone scored a 4.45 ssimulacra2 gap between 4:2:2 and
    4:2:0, a big honest number measuring damage to colour noise that nobody can
    see. Numbers pick the candidates; the sheet is how you find out whether the
    call is winnable. Look at it before shipping a threshold change.
    """
    if not trials:
        return
    pad, lbl = 10, 20
    cols = max(len(t["options"]) for t in trials)
    W = pad + cols * (TILE + pad)
    H = pad + len(trials) * (TILE + lbl + pad)
    sheet = Image.new("RGB", (W, H), "#ECE9D8")
    dr = ImageDraw.Draw(sheet)
    y = pad
    for t in trials:
        x = pad
        for o in t["options"]:
            sheet.paste(Image.open(o["path"]), (x, y + lbl))
            dr.text((x, y + 5),
                    f'{t["axis"]}/{t["crop"]} {o["label"].split(" · ")[0]} '
                    f'{o["bytes"]}B s2={o["s2"]} bu={o["butter"]}', fill="#1a1a1a")
            x += TILE + pad
        y += TILE + lbl + pad
    sheet.save(path)
    log(f"contact sheet: {path}")


def preflight():
    missing = [name for name, path in (
        ("zenc", ZENC), ("cjpegli", CJPEGLI), ("mozjpeg cjpeg", CJPEG),
        ("ssimulacra2", SSIMULACRA2), ("butteraugli_main", BUTTERAUGLI),
    ) if not Path(path).exists()]
    if not SRC_DIR.is_dir():
        missing.append(f"source photos at {SRC_DIR}")
    if missing:
        log("missing: " + ", ".join(missing))
        log("  zenc:  cargo build --release --manifest-path holding/scripts/zenc/Cargo.toml")
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="measure and report, write no tiles or manifest")
    ap.add_argument("--sheet", metavar="PATH",
                    help="write a 1:1 contact sheet of the kept trials, to eyeball "
                         "whether each call is actually winnable")
    ap.add_argument("--only", choices=sorted(CANDIDATES),
                    help="build one axis only, to iterate on its thresholds. "
                         "Implies --dry-run: a partial set must never be written, "
                         "because the manifest is all-or-nothing.")
    args = ap.parse_args()
    if args.only:
        args.dry_run = True
    preflight()

    built, dropped = [], []
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)

        for axis, (intent, keep, stems) in CANDIDATES.items():
            if args.only and axis != args.only:
                continue
            for stem in dict.fromkeys(stems):        # dedupe, keep author order
                tmp = work / f"{axis}-{stem}"
                tmp.mkdir()
                try:
                    src = load_source(stem, tmp)
                    crop, cscore = best_crop(src, intent)
                except Exception as e:              # noqa: BLE001
                    dropped.append((axis, stem, f"source: {e}"))
                    log(f"  ✗ {axis:9s} {stem}  source: {e}")
                    continue

                srcs = {"png": tmp / "crop.png", "ppm": tmp / "crop.ppm"}
                crop.save(srcs["png"])
                crop.save(srcs["ppm"])

                try:
                    trial, why = BUILDERS[axis](stem, srcs, srcs["png"], tmp)
                except Exception as e:              # noqa: BLE001
                    trial, why = None, f"{type(e).__name__}: {e}"
                if trial is None:
                    dropped.append((axis, stem, why))
                    log(f"  ✗ {axis:9s} {stem}  {why}")
                    continue

                trial["crop_score"] = round(cscore, 1)
                built.append(trial)
                log(f"  · {axis:9s} {stem}  {describe(trial)}")

        # ---- rank within each axis, keep the most legible
        trials = []
        for axis, (_intent, keep, _stems) in CANDIDATES.items():
            pool = sorted((t for t in built if t["axis"] == axis),
                          key=RANK[axis], reverse=True)
            for t in pool[keep:]:
                dropped.append((axis, t["crop"],
                                f"ranked {RANK[axis](t)} — below the top {keep} on this axis"))
            trials.extend(pool[:keep])

        # ---- report
        log("")
        by_axis = {}
        for t in trials:
            by_axis[t["axis"]] = by_axis.get(t["axis"], 0) + 1
        log(f"kept {len(trials)} of {len(built)} built: " +
            ", ".join(f"{k} {v}" for k, v in sorted(by_axis.items())))
        chroma_ish = by_axis.get("chroma", 0) + by_axis.get("tradeoff", 0)
        log(f"chroma-flavoured: {chroma_ish} of {len(trials)}")
        enc = [t for t in trials if "budget_drift" in t]
        if enc:
            log(f"worst equal-budget drift shipped: {max(t['budget_drift'] for t in enc)}%")
        if dropped:
            log(f"dropped {len(dropped)}:")
            for axis, stem, why in dropped:
                log(f"   {axis}/{stem}: {why}")

        if args.sheet:
            write_sheet(trials, args.sheet)

        if args.dry_run:
            log("\n--dry-run: no tiles or manifest written")
            return

        if len(trials) < 12:
            log(f"\nrefusing to write: only {len(trials)} trials survived, want >= 12")
            sys.exit(1)

        # ---- write (only now that the whole set is known good)
        staged = {}
        for t in trials:
            for o in t["options"]:
                data = Path(o.pop("path")).read_bytes()
                h = hashlib.sha256(data).hexdigest()[:12]
                staged[h] = data
                o["src"] = f"/pixel-peeper/tiles/{h}.jpg"
            t.pop("rejected", None)

        if TILES_DIR.exists():
            shutil.rmtree(TILES_DIR)
        TILES_DIR.mkdir(parents=True)
        for h, data in staged.items():
            (TILES_DIR / f"{h}.jpg").write_bytes(data)

        manifest = {"tile": TILE, "trials": trials}
        (OUT_DIR / "manifest.json").write_text(
            json.dumps(manifest, separators=(",", ":")) + "\n")
        total = sum(len(d) for d in staged.values())
        log(f"\nwrote {len(staged)} tiles ({total // 1024} KB) + manifest.json "
            f"({(OUT_DIR / 'manifest.json').stat().st_size} B)")


if __name__ == "__main__":
    main()
