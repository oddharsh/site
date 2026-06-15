# Maintenance runbook

For future me. Every recurring chore on aadhar.sh, organized by "I want to ___",
with the exact command and the gotcha that bit me last time. Deep design notes
and the full conventions list live in [CLAUDE.md](CLAUDE.md); this is the ops sheet.

Three deploy targets:
- **holding/** (the Pages site, aadhar.sh): `wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true` (run from the repo root, never from a subdir, or wrangler ENOENTs scanning `images/holding/`).
- **serendipity/** (separate Worker, aadhar.sh/serendipity): `cd serendipity && wrangler deploy`.
- **cal/** (coffee booker): source-complete, NOT deployed. Needs secrets first (see [cal/README.md](cal/README.md)).

Key facts (don't hardcode these elsewhere, they drift):
- RN_KV namespace id: `3cb8a107c58e47dc9244e75b33401f36`
- R2 bucket: `aadhar-photos` (SOOC originals + full-res JPGs)
- `THUMB_VERSION` lives at the top of `holding/_worker.js` (the `?v=N` on every thumbnail).
- `CACHE_VERSION` lives at `holding/sw.js` line ~28 (the service-worker cache key).
- Canonical photo source folder: `/Users/aadharsh/Downloads/to post (from ssd)/`. Privacy rule: nothing else from elsewhere on disk feeds the pipeline.

---

## One-time setup

```bash
brew install exiftool jq mozjpeg libavif cmake ninja   # mozjpeg = jpegtran; libavif = avifenc (optional, sips falls back)
./holding/scripts/build-jpegli.sh                      # builds cjpegli -> ~/.local/bin (Google's JPEG encoder)
wrangler login                                         # Cloudflare auth (deploys + KV + R2 all use it)
```
`sips` is macOS-native (no install). The pipeline is macOS-only as written.

---

## Add photos (the common one)

```bash
# does everything: resize -> EXIF-rotate -> encode AVIF+JPG squares -> upload R2 ->
# regenerate metadata.json (calls extract-photo-metadata.sh) -> bust the manifest KV keys.
./holding/scripts/add-photos.sh "/path/to/photo.HIF" [more files...]
# then it prints the deploy line; run it:
wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true
```
- Accepts JPG/PNG/HEIF/HIF. For HEIF it also uploads a visually-lossless JPG export as the `/images/full/<stem>.jpg` click target.
- It busts `manifest:images`, `idx:images`, `idx:imagesfull` so the worker re-derives the grid from R2 on the next request.
- If a thumbnail looks stale after deploy, bump `THUMB_VERSION` (see below). It does NOT auto-bump it (one new photo doesn't need it; a whole re-encode does).

### Regenerate just the EXIF metadata (photos already uploaded)
```bash
./holding/scripts/extract-photo-metadata.sh "/Users/aadharsh/Downloads/to post (from ssd)"
```
Writes `holding/images/metadata.json` (keyed by stem) + per-photo `holding/images/meta/<stem>.json` (what the hover tooltip fetches). Every field is nullable; the tooltip skips nulls rather than guess. Then deploy.

### Re-encode ALL thumbnails (e.g. a new resolution/quality)
```bash
./holding/scripts/reencode-thumbnails.sh           # re-encodes every grid thumb as pre-cropped center squares
# bump THUMB_VERSION in holding/_worker.js, then deploy
```
`SQ_SM` (mobile tier) must match `THUMB_SMALL_PX` in `_worker.js` (the `-<N>.avif` suffix). add-photos.sh mirrors this script's two encode paths; keep them in sync.

### Add a car reference photo (homepage tooltip)
```bash
./holding/scripts/add-car-photo.sh <stem> <input-image>   # stem: singer | tuthill | hwa-evo | f355
```
Outputs `holding/cars/<stem>.{avif,jpg}` (no EXIF, no R2). Bump the `?v=` on that car image in `index.html` if you replace one in place, then deploy.

### Generate AI alt text for the grid
```bash
python3 holding/scripts/gen-alt-text.py     # writes holding/images/alt.json {stem: alt}
```
Resumable: only fills uncaptioned stems, so a 429 (Workers-AI neuron budget) just means run again later. Deploy after.

### Regenerate the /garage/encoding study samples
```bash
./holding/scripts/gen-encoding-samples.sh [STEM] [SRC_DIR]
```
Prints byte counts + bytes-per-pixel so the figcaptions on `/garage/encoding` can be updated to match. The grayscale (`g-*`) set is generated separately and is not touched.

---

## Change the now-playing playlist

The homepage scrapes a Spotify playlist; `playlist-id` in KV points at it. To swap it
(this is the sequence that actually works, the `/rn/set` endpoint needs `RN_BUST_SECRET`):

```bash
NS="3cb8a107c58e47dc9244e75b33401f36"
OLD=$(wrangler kv key get --namespace-id="$NS" playlist-id --remote)   # save the current id
wrangler kv key put --namespace-id="$NS" playlist-id "<NEW_22_CHAR_ID>" --remote
# clear the old playlist's two-key SWR cache (value + freshness sentinel):
wrangler kv key delete --namespace-id="$NS" "tracks:${OLD}" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:${OLD}:fresh" --remote
curl -s "https://aadhar.sh/rn/tracks" >/dev/null                       # warms tracks:<new> by scraping
wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true
```
- The id is the 22 chars after `/playlist/` in the share URL (drop `?si=...`).
- **Why the redeploy:** the worker caches `playlist-id` in a module variable (`_playlistId`) per warm isolate. A redeploy recycles isolates so the homepage *prerenders* the new list immediately instead of waiting for them to age out.
- **zsh gotcha:** write `"tracks:${OLD}:fresh"` with braces. Bare `tracks:$OLD:fresh` triggers a zsh history modifier (`:r` etc.) and silently mangles the key.
- One-shot alternative once you have the secret: `curl "https://aadhar.sh/rn/set?secret=$RN_BUST_SECRET&url=<playlist-url>"`.

---

## Bust a cache

```bash
NS="3cb8a107c58e47dc9244e75b33401f36"
# photo manifest (forces re-derive from R2; the value is two-key SWR, deleting the value is enough):
wrangler kv key delete --namespace-id="$NS" "manifest:images" --remote
# directory-listing indexes:
wrangler kv key delete --namespace-id="$NS" "idx:images" --remote
wrangler kv key delete --namespace-id="$NS" "idx:imagesfull" --remote
# a specific playlist's tracks (delete both keys):
wrangler kv key delete --namespace-id="$NS" "tracks:<id>" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:<id>:fresh" --remote
```

### Bump THUMB_VERSION
Edit `const THUMB_VERSION` at the top of `holding/_worker.js`, deploy. Do this when you re-encode thumbnails, or when you suspect edge cache poisoning (Cloudflare caches a transient 404/HTML at a thumb URL for up to 4h; a fresh `?v=N` is a fresh edge lookup that routes around it).

### Bump CACHE_VERSION (service worker)
Edit `const CACHE_VERSION` in `holding/sw.js` (line ~28), deploy. **Required on every change to `nav.js` or `notepad.js`** (they are SWR-cached by the SW), and on any SW behavior change. The bump sweeps old caches in the `activate` event.

---

## Verify things

```bash
dig _index._agents.aadhar.sh SVCB +dnssec +short          # DNS-AID agent-discovery record
curl -s https://aadhar.sh/.well-known/http-message-signatures-directory | jq .   # AadharshBot JWKS (Web Bot Auth)
curl -sD- -o /dev/null "https://aadhar.sh/images/<stem>.avif?v=<N>"  # a thumb: expect 200 image/avif, 1yr immutable
curl -s "https://aadhar.sh/images/manifest.json" | jq length          # photo count
```

---

## The scripts (`holding/scripts/`)

| script | what it does |
|---|---|
| `add-photos.sh` | Full pipeline for new photos: resize, EXIF-rotate, encode AVIF+JPG center-square thumbs, upload originals to R2, regenerate metadata, bust the manifest KV keys. Prints the deploy line. |
| `extract-photo-metadata.sh` | Read EXIF from the SOOC folder, emit `images/metadata.json` + per-photo `images/meta/<stem>.json`. Pulls the Fuji recipe fields too. Requires exiftool + jq. |
| `reencode-thumbnails.sh` | Re-encode every published grid thumb from the source folder at a new resolution (pre-cropped squares, two tiers). Pair with a THUMB_VERSION bump. |
| `add-car-photo.sh` | One resto-mod reference photo -> `cars/<stem>.{avif,jpg}` for the homepage car tooltips. No EXIF, no R2. |
| `build-jpegli.sh` | Build Google's `cjpegli`/`djpegli` from source to `~/.local/bin`. Idempotent; re-run to update. ~90s first build. Requires cmake + ninja + clang. |
| `gen-alt-text.py` | AI alt text for grid photos via the Workers-AI caption endpoint -> `images/alt.json`. Resumable. |
| `gen-encoding-samples.sh` | Regenerate the color sample set for `/garage/encoding` through every encoder; prints byte counts. |
| `photo-histograms.py` | **Vestigial.** Its header says it feeds `metadata.json`, but histograms are computed client-side in the tooltip now. Kept on disk, not wired into anything. Safe to ignore (or delete).

---

## Gotchas that have bitten me

- **Cloudflare edge caches 404s for ~4 hours.** A transient miss at a thumb URL during a deploy gets pinned. Mitigations: `THUMB_VERSION` bump (fresh URLs) + the worker rewrites cache-control on non-image responses to uncacheable.
- **zsh eats `${var}:something`.** Brace-quote KV key names with colons (`"tracks:${OLD}:fresh"`), and use `${=flag}` if you need word-splitting in ad-hoc snippets (the scripts use `#!/usr/bin/env bash` so they are safe internally).
- **`jpegtran` / mozjpeg strip EXIF.** Rotate losslessly with `jpegtran -copy none -rotate N` *before* recompressing, and send its binary stdout to a file (`2>/dev/null > out.jpg`), not through a pipe that could mix in stderr.
- **`wrangler pages deploy` runs from the repo root**, never from inside `holding/images/` etc.
- **`_playlistId` is module-cached per isolate.** After changing `playlist-id`, redeploy to flush it (see the playlist section).
- **A worker change is committed, not deployed.** `git commit` does not push to Cloudflare; run the deploy command. Live can lag the repo otherwise.
