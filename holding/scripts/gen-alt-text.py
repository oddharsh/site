#!/usr/bin/env python3
"""gen-alt-text.py — generate AI alt text for every grid photo via the cf-garage
Workers-AI caption endpoint (?mode=alt) and write holding/images/alt.json
{stem: alt}. Resumable: re-running only fills stems not already captioned, so a
429 (neuron budget) just means run again tomorrow. Strippable — delete alt.json
and the worker/template lookups to revert to empty alt.
"""
import json, os, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
META = os.path.join(ROOT, "images", "metadata.json")
OUT  = os.path.join(ROOT, "images", "alt.json")
ENDPOINT = "https://aadhar.sh/garage/cf/caption?mode=alt&img="

stems = list(json.load(open(META)).keys())
alt = json.load(open(OUT)) if os.path.exists(OUT) else {}
todo = [s for s in stems if not alt.get(s)]
print(f"{len(stems)} photos, {len(alt)} already done, {len(todo)} to generate", flush=True)

done = 0
for i, stem in enumerate(todo):
    try:
        # a real UA — Cloudflare's WAF 403s the default "Python-urllib/*"
        req = urllib.request.Request(ENDPOINT + stem, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 alt-gen",
        })
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.load(r)
        cap = (d.get("caption") or "").strip()
        if not cap:
            print(f"  [{i+1}/{len(todo)}] {stem}: EMPTY ({d.get('error','?')})", flush=True)
            continue
        alt[stem] = cap
        json.dump(alt, open(OUT, "w"), ensure_ascii=False, indent=0, sort_keys=True)
        done += 1
        print(f"  [{i+1}/{len(todo)}] {stem}: {cap}", flush=True)
    except Exception as e:
        msg = str(e)
        print(f"  [{i+1}/{len(todo)}] {stem}: ERROR {msg}", flush=True)
        if "429" in msg:  # neuron budget hit — stop, resume later
            print("  rate-limited (429) — stopping; re-run to resume.", flush=True)
            break
    time.sleep(0.5)

print(f"\ndone this run: {done}.  total captioned: {len(alt)}/{len(stems)} → {OUT}", flush=True)
