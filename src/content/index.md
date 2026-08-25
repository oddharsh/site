# Aadharsh Pannirselvam

Researching and investing at [Archetype](https://www.archetype.fund/). Building
[this site](https://aadhar.sh) in the meantime.

**Under construction.**

---

Hey, welcome to my corner of the internet! This site's modeled after the
recent (last decade) wave of resto-mod cars like
[Singer](https://www.google.com/search?q=Singer+Vehicle+Design+Porsche+911) or
[Tuthill](https://www.google.com/search?q=Tuthill+911K) with aircooled
Porsche 911's or the
[HWA AMG EVO](https://www.google.com/search?q=HWA+AMG+EVO) or the
[355 by Evoluto](https://www.google.com/search?q=Evoluto+Automobili+355),
where you take a beloved chassis and formula and modernize it while retaining
its soul.

In this case, this site's largely modern HTML with some cursor following
tooltips and cloudflare workers under CSS skins styled to look like it's ~2006.
It's all a work in progress and a fun way for me to learn about internet tech,
but in the meantime, here are some photos i've made and music that's been in my
head lately.

If you'd like to grab a coffee in NYC, write me at <coffee@aadhar.sh> or pick a
slot at [aadhar.sh/coffee](https://aadhar.sh/coffee). It's a manual opt-in on
my side, so i'll try to get back to you.

## Music I'm listening to right now

The current "rn" Spotify playlist's tracks are served as JSON at
[/rn/tracks](https://aadhar.sh/rn/tracks); the homepage's HTML row fallback is
at [/rn/tracks.html](https://aadhar.sh/rn/tracks.html). Each track includes a
[song.link](https://song.link) URL that forwards to your preferred music
service. The /rn redirect ([aadhar.sh/rn](https://aadhar.sh/rn)) opens the
full playlist on Spotify.

## Photographs

A random nine photos from a curated pool of ~146 are rendered on each page
load. Thumbnails dual-encoded as AVIF (primary, via `<picture>`) and JPG
(universal fallback) at `/images/<stem>.{avif,jpg}`; full-resolution SOOC
originals at `/images/full/<name>.<ext>` via worker-proxied R2. The whole
archive is browsable at `/photos`, and machine-readable at
`/images/manifest.json` (+ `alt.json` captions, `metadata.json` EXIF).

## Links

- Twitter: <https://x.com/oddhash>
- Instagram: <https://www.instagram.com/aadharsh.hif>
- Curius: <https://curius.app/aadharsh-pannirselvam>
- Beli: <https://beliapp.com/users/aadharsh>
- Spotify: <https://open.spotify.com/user/aadharsh2010>
- whoareyou: <https://aadhar.sh/whoareyou> (your request fingerprint;
  shown back to you, never logged)

---

© 2026 Aadharsh Pannirselvam · Best viewed in any browser made since 2001.

*love, aadharsh*
