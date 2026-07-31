// csp-hashes.js — the per-document sha256 allowlist for inline <script> blocks,
// so `script-src` can drop 'unsafe-inline' and start doing real work.
//
// Same shape as shell-assets.js: this file is COMMITTED readable with an empty
// map, and build.mjs overwrites the marked line in the staged .build/ copy with
// hashes derived from the final bytes it just wrote. Keep the
// `// build:csp-hashes` marker — the build replaces that whole line.
//
// Empty here on purpose. `npm run dev` (wrangler.dev.jsonc) serves the readable
// unminified holding/ tree, whose inline blocks hash differently from the staged
// ones, so a committed map would be wrong for exactly the surface it claims to
// protect. An empty map means every path falls back to the loose policy, which is
// what dev wants and what production must never silently get — build.mjs hard-fails
// if the map it emits does not cover essentially every staged document.
//
// Keys are canonical REQUEST paths (no trailing slash, no .html), because that is
// what withSecurityHeaders() is handed. Values are bare base64 digests; the
// 'sha256-' prefix and quoting are added when the policy is assembled.
export const PAGE_SCRIPT_HASHES = {"/bot":[],"/garage/blueprint":["YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/chunks":["WNjDCHHxvO+vRYSAgSmP9k6ErdhILRSGUvdCtLTyhuU=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/cloudflare":["/LsOJWgeszY3evT/bkVcy2UM+EDLgVEhIOJEOBSmUGc=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/compression":[],"/garage/encoding":["BP+P2kCNFPDclr0SKKgz6iXMkurqOPJhKH9e7cidcxw=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/gpt56":["YAnWpTGp//95wvZsOy4+Jxx4WrJGc5caEIYF1nyMf8U="],"/garage/horizon":["ItCaTcvhFbZD7Df5TDcZsFQw37AMjZeO0pFls3GKMWM=","Fd5WS1maKrzBntkhnrul8U7+K8gbofvy7EGZzqhLIis=","JM5iaMvZaCue1QuM3bTg9sji7kFVsFPnAUgrYHWLNxk=","2cjh/Ao7gt3U/Y0fFKYGumLvO6x5fGAP+UE1SskAV48=","r46uYdEdjWPjxSRGk2oSBeHDZhQVrP+ecVnbZmtLcgI=","QzwcqxDo9IgyVPxOcWTzwpS85lGDEnn6Z3PLuFjfOoQ=","oXh082WybmX4Px1CG8tgWyMdK+yZlF+miARlugq9xiQ=","E040NNLv6HLBthKSjUnw80QgYTr8Mitl0gJHNQp9/dI=","eClizaArfkcdydcYoBL6no45Fstz2MsL6ZHSdjLf21g=","xYOxaRPncP4SBgFbMHCLoj+5cXsPuk+3uDYQqr/Q/T8=","Ehq+YOICTnLCi+NmqCF0SrGrCAytOPksQf15zhhdX7U=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage":["YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/iroh":["T/cD9C7DadzeT5vutzkT07eUKbA01FtAtl7OSouDnDI=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/masonry":["SsVmoy38DdC9IjDp2WN+cdBqljQXsne2YoUXJGm0vD0="],"/garage/pqc":["mE7WihG6m/dUh8lKlZvuXjjzK7d1TCaz1QZ+Fl1VuDc="],"/garage/pretext":["hJkwX7oO/YohGzldyVTQ7++0MJYUY8vzLTQpUbZxQc0=","qNMsafrYt3r8sVu27Ji6tCUxn4Xi99mTk817mmSM1Bc="],"/garage/safari27":["UkL5YhprQ/7KOnkZqysLxQE9UVr16qUXWjREq29nDlA="],"/garage/scroll":["LjWsa3VztwoI6HCNVqiOP0EcUEhV8okh3ggK39TGs3s=","QiB0on/atgktwMgbAQ6tc9XJj6EuCWwr8O7wzcO45m0="],"/garage/teardown":["YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/tooltips":["WW8QlKK/7n4Pg9U6mUIpl+nBJAZHaaLWNr+i4JS5vq0=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/vt-b":["JcdVOghaFhoTxExErZh5TiL1NYj6jYuKWn4uUwe5O2Y=","bgAU7o1wTf3NQDSSPoDt/Cbna8Ac/HIQ1aY9o/qfC2g="],"/garage/vt-check":["DFyk5hfiUekGazzemt+bF7YtQqhXuE9R+NHnQoCuLf8="],"/garage/wire":["XuNd2T8JR2frIcAS1OiYl48xHeOHjZbJp0y/b50uBPI=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/garage/workers":["YkXvayG3aj1qQzqN10Z6q7L5+1s6jVvrI8fEADzOn1Q=","YfhifiIFn+utolbgMw0FsvaEaG1znQjo1Qxtd4pIs1A="],"/":["IsIosgp1hHW/0ZPimGke94oxypG6aQ4EgTdhkfVzysk=","qQzuU4KQUQZY6bCvRaZ8MH4WMyMmfOX2EkEuVPBC4H8=","bdHsz/7C/EHX7yUaqvWM89TL6IG7/8jyXSwwu/QzExA=","2AwetMMevv2Dw1qmYXklMV8CxqN/8aoXWB6iZslz1/4=","Rcc9s6/FvXNoyEwXkqDuJhQNJy2ags5Vr+EDkJRJdwM=","tVeAtB4+5g+msbQKZ/+nY8l+FBR/6Ap1OfC+ow2Mh48=","mYF/IIrIwo30Xf1pBlDltwUAoWswA6t52rKHxkPMqls=","hKLk+OBLm7lHbvpkZk7SAKpIXWSYPKK/HV1TFJ+sihw="],"/lens":[],"/lwe/dac":["2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo=","6WuAIRRT6hjtQZT/kcTqFcEVgavmIoiCxh+DNWJpxBc="],"/lwe/drivers":["2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo=","V7aR9IyzAJe4L/dww/m0nKbD0Wt6LJBCGSqruOgvumg="],"/lwe/encoding":["UpPgAAAREBUZOjSu+eAOuVTz5yhx+Vs1v7uktBBKCx0=","40IV/+dwf7YkDRDEf8fwTfwSQhjv6vXDdsSQdsaLSbs=","1dGA5rrs7U5urlMqdSqTUZ9Sjje5n3KVa2B1W0jw0KE="],"/lwe/fhe":["HNYbZrEp+tSxM1k2vESoSP94K1nRU96npwgDQl1hufU=","gbVYxXQzSrmHEn5qt8Bw2iXfE4O5IJEK6VOQHAkHvio="],"/lwe":["gbVYxXQzSrmHEn5qt8Bw2iXfE4O5IJEK6VOQHAkHvio="],"/lwe/knots":["2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo=","yOThghFjJ25wuRR/c4BxnjEuSJvGFpHjsk5M9rbhIC4="],"/lwe/mpc":["/1+KgB4jVCGY7MpmmsAJK+ewZpdS0a0lUfjQO3P+o0o=","2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo="],"/lwe/pcrypto":["2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo=","VaeBFkiAFA0Jl73IZayIHEdSMP/yiE7zZhfk39Ty+rw="],"/lwe/tee":["DrwzqV1f92OekpAJFOBXjFm8phCclUII9/EI3kQNP9Q=","2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo="],"/lwe/utf8":["9mzJWORjg1Xo18GUF2YCYTGt8Xn6xtHnJhL+wfTYkzQ=","2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo="],"/lwe/vigenere":["B8ybzfGqTLzHg7o2AoxyPgCWtC+9svf4gG6w+5yQRVk=","kbcOIIlA6/uJ63IqQ4Xq/4dUgYqMPzljgcJm+ab4ni4=","2QIx6TCcWUoqOdBYrS02zdWDE1xA7Zc7eZ8xnHWJVYo="],"/photos":[],"/pixel-peeper":["n0vyn067LWDR1b/7Le4f9kN9ivCArQx85FxQP6w9y9k="],"/restore":["Af2S8yWpBMTtsMtOunc444fhXZuhPxg03+QwRtkkFeE="],"/updates":[],"/writing/big-screens-and-small-screens":[],"/writing/colophon":[],"/writing/education-in-tech":[],"/writing/in-flux":[],"/writing":[]}; // build:csp-hashes

// Live worker-rendered documents (/whoareyou, /around, /coffee, /search, /ledger,
// /rn/admin, /serendipity) are NOT in the map and keep the loose policy. Their HTML
// is assembled per request from template literals, so no build-time hash can be
// right. The honest fix for those is a per-response nonce, which they can take
// precisely BECAUSE they are not precompressed — see the PR notes. Until then the
// fallback keeps them exactly as secure as they are today, and no less.
//
// The staged documents (43 of them: the homepage, garage, lwe, pixel-peeper,
// /lens, /writing/*, /photos, /bot, /updates, /restore) are all deterministic
// build output, which is what makes a build-time hash the correct mechanism
// rather than a convenient one.

// A request path can arrive in several equivalent spellings. Canonical URLs on
// this site carry no trailing slash (wrangler's drop-trailing-slash html_handling
// and both rel=canonical tags agree), so fold the variants onto that form before
// looking a document up.
export function canonicalPath(pathname) {
  if (!pathname) return "/";
  let p = pathname;
  if (p.endsWith(".html")) p = p.slice(0, -5);
  if (p.endsWith("/index")) p = p.slice(0, -6) || "/";
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

// No pathname means the caller could not name this document (the /lens self-scan
// passes none). That must NOT canonicalize to "/" and hand some other response the
// homepage's hashes, so it returns null and takes the loose policy.
export function scriptHashesFor(pathname) {
  if (!pathname) return null;
  return PAGE_SCRIPT_HASHES[canonicalPath(pathname)] || null;
}
