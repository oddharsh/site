#!/usr/bin/env python3
"""gen-alt-text.py — alt text for every grid photo, written to
assets/photos/data/alt.json as {stem: alt}. The compiler bakes it into the photo
archive and the Worker returns it from photo queries, so a stem with no entry
would ship an unlabelled image.

The script reads the committed square thumbnail and posts those exact bytes to
the Workers AI REST API. Because it never asks production for anything, it can
caption a photograph in the same run that encodes it.

Resumable either way: a re-run only fills stems that have no caption, so a 429
(the free 10k neurons/day) just means run again later.

  export CLOUDFLARE_API_TOKEN=...   # Account · Workers AI · Read
  export CLOUDFLARE_AI_GATEWAY=""   # opt OUT of gateway routing (defaults to "default")
  npm run captions                  # or: python3 tools/media/gen-alt-text.py

Strippable: delete alt.json plus the worker/template lookups to revert to
empty alt.
"""
import json, os, sys, time, urllib.error, urllib.request

ROOT   = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
META   = os.path.join(ROOT, "assets", "photos", "data", "metadata.json")
HASHES = os.path.join(ROOT, "assets", "photos", "data", "hashes.json")
HASHED = os.path.join(ROOT, "assets", "photos", "thumbs")
OUT    = os.path.join(ROOT, "assets", "photos", "data", "alt.json")

PROMPT = ("Write alt text for this photo: one plain, factual sentence naming only "
          "what is clearly visible (main subject and setting). No mood, no "
          "interpretation, no guessing, no 'image of'. Under 16 words.")

MODEL    = "@cf/llava-hf/llava-1.5-7b-hf"
ACCOUNT  = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "1c99acdb6141579023fb97d24261ea58")
TOKEN    = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
AI_RUN   = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/{MODEL}"
# Route through AI Gateway so this script's spend lands in a per-model log instead
# of showing up only as an unattributed dent in the daily neuron budget. Empty
# string disables it; a nonexistent gateway is a hard error, never a passthrough.
GATEWAY  = os.environ.get("CLOUDFLARE_AI_GATEWAY", "default").strip()
# a real UA — Cloudflare's WAF 403s the default "Python-urllib/*"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 alt-gen"

DRY_RUN = "--dry-run" in sys.argv


def clean(caption):
    """Match the worker's post-processing so both routes emit the same shape."""
    import re
    cap = re.sub(r"^(an? |the )?(image|photo|photograph|picture) (of|shows|depicts|captures)\s*",
                 "", caption.strip(), flags=re.I)
    cap = re.sub(r"\s+", " ", cap).strip()
    return cap[0].upper() + cap[1:] if cap else ""


def thumb_path(stem, hashes):
    entry = hashes.get(stem) or {}
    if not entry.get("j"):
        raise FileNotFoundError(f"{stem} missing from hashes.json (half-run pipeline?)")
    return os.path.join(HASHED, f"{stem}.{entry['j']}.jpg")


def caption_local(stem, hashes):
    """POST the committed thumbnail bytes straight to Workers AI."""
    with open(thumb_path(stem, hashes), "rb") as fh:
        image = list(fh.read())
    body = json.dumps({"image": image, "prompt": PROMPT, "max_tokens": 64}).encode()
    if DRY_RUN:
        # Intent without the endpoint: that URL embeds the account id from the
        # environment, and dry-run output is what gets pasted into issues.
        print(f"      would POST {len(body)}B to Workers AI ({MODEL})", flush=True)
        return ""
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": UA,
    }
    # observability only — no cf-aig-cache-ttl. This script is resumable and gets
    # re-run to REPLACE a caption the model got wrong, and a cache keyed on the
    # request would hand back the wrong one forever, since the request is identical.
    if GATEWAY:
        headers["cf-aig-gateway-id"] = GATEWAY
    req = urllib.request.Request(AI_RUN, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    result = d.get("result") or {}
    return clean(result.get("description") or result.get("response") or "")


stems  = list(json.load(open(META)).keys())
hashes = json.load(open(HASHES))
alt    = json.load(open(OUT)) if os.path.exists(OUT) else {}
todo   = [s for s in stems if not alt.get(s)]

print(f"{len(stems)} photos, {len(alt)} already done, {len(todo)} to generate", flush=True)
print("route: committed bytes -> Workers AI REST", flush=True)
if not TOKEN and todo and not DRY_RUN:
    print("  CLOUDFLARE_API_TOKEN is required (Account · Workers AI · Read).", flush=True)
    sys.exit(1)

done = 0
for i, stem in enumerate(todo):
    try:
        cap = caption_local(stem, hashes)
        if not cap:
            if not DRY_RUN:
                print(f"  [{i+1}/{len(todo)}] {stem}: EMPTY (model returned nothing)", flush=True)
            continue
        alt[stem] = cap
        json.dump(alt, open(OUT, "w"), ensure_ascii=False, indent=0, sort_keys=True)
        done += 1
        print(f"  [{i+1}/{len(todo)}] {stem}: {cap}", flush=True)
    except Exception as e:
        msg = str(e)
        if isinstance(e, urllib.error.HTTPError):
            msg = f"HTTP {e.code} {e.reason}"
            if e.code in (401, 403):
                print(f"  [{i+1}/{len(todo)}] {stem}: {msg} — check CLOUDFLARE_API_TOKEN "
                      f"(needs Account · Workers AI · Read on {ACCOUNT}).", flush=True)
                break
        print(f"  [{i+1}/{len(todo)}] {stem}: ERROR {msg}", flush=True)
        if "429" in msg:  # neuron budget hit — stop, resume later
            print("  rate-limited (429) — stopping; re-run to resume.", flush=True)
            break
    time.sleep(0.5)

total  = len([s for s in stems if alt.get(s)])
gaps   = [s for s in stems if not alt.get(s)]
print(f"\ndone this run: {done}.  total captioned: {total}/{len(stems)} → {OUT}", flush=True)
if gaps:
    print(f"still missing ({len(gaps)}): {', '.join(gaps[:8])}"
          f"{' …' if len(gaps) > 8 else ''}", flush=True)
    sys.exit(1)
