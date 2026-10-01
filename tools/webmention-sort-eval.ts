// Does Clef sort a verified webmention correctly? The measurement behind
// src/worker/webmention-sort.ts, committed so the next change to the sort (a
// model bump, a reworded criterion, a field added to the input) is scored the
// same way.
//
//   bun run webmention:eval              # 20 source pages, 3-way accuracy and spam calls
//   bun run webmention:eval -- --swap    # the host-swap control below
//
// The production table held no mentions when this was written, so the corpus is
// 20 source pages written to resemble the traffic the endpoint will see, by the
// person building the sort. Read a win as a strong signal rather than a
// benchmark. What keeps it honest is that every page goes through the REAL
// linksTo and parseSource, so Clef reads exactly the fields production hands it,
// and a page that would fail verification refuses to run.
//
// Measured 2026-10-01: 3-way 19/20, spam at 0.5 caught 7 of 8 with 0 genuine
// mentions called spam, identical across two runs, median 0.69 s. The miss is
// the scraped copy, read as genuine.
//
// --swap is the control that decides how the verdict may be used. It moves four
// source hosts: two spam pages onto github.com and lobste.rs, and two genuine
// posts onto a casino and a pharmacy domain. Measured the same day: the spam
// stayed spam (0.97, 0.96) and the genuine blog post crossed to spam (0.87,
// and 0.53 in the scratch probe that preceded this file). A host
// can push a verdict toward spam and cannot launder one, which is why the sort
// labels the email and never acts on its own.
//
// Workstation-only: it spends Workers AI through the REST API, with
// CLOUDFLARE_API_TOKEN when set and wrangler's own login otherwise. It writes
// nothing.

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { linksTo, parseSource } from "../src/worker/webmention.ts";
import { SORT_LABELS, SORT_MODEL, buildSortRequest, type SortLabel } from "../src/worker/webmention-sort.ts";
import { siteConfig } from "./lib/site-config.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

const T = (p: string) => `https://aadhar.sh${p}`;
const page = (body: string, title = "") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const links = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `<li><a href="https://${seed}${i}.example/">${seed} resource ${i}</a></li>`).join("");

type Sample = { id: string, label: SortLabel, source: string, target: string, html: string };

export const WEBMENTION_EVAL: readonly Sample[] = [
  { id: "blog-encoding", label: "genuine", source: "https://jkm.dev/notes/avif-444", target: T("/garage/encoding"),
    html: page(`<article class="h-entry"><h1 class="p-name">Chroma subsampling is a downscale problem</h1><a class="p-author h-card" href="https://jkm.dev">Jules Kim</a><div class="e-content"><p>I had always assumed 4:2:0 was free for photos. Then I read <a href="https://aadhar.sh/garage/encoding">the encoding study</a>, which measures 4:4:4 at matched bytes instead of at a fixed quality knob, and the argument flips: once a 600px tile is cut from a 7728px frame, each pixel already averages several chroma samples. I reran it on my own 40 photos and got a similar +0.4 ssimulacra2.</p></div></article>`) },
  { id: "reply-colophon", label: "genuine", source: "https://maya.blog/2026/10/xp", target: T("/writing/colophon"),
    html: page(`<div class="h-entry"><a class="u-in-reply-to" href="https://aadhar.sh/writing/colophon">In reply to aadhar.sh</a><span class="p-author h-card"><a href="https://maya.blog">Maya R</a></span><div class="e-content">The Luna title bars got me. I spent an hour dragging windows around before reading anything. One question: why Tahoma before Verdana for UI text?</div></div>`, "Re: colophon") },
  { id: "bridgy-reply", label: "genuine", source: "https://brid.gy/comment/mastodon/@x@hachyderm.io/1132/1132-9", target: T("/lens"),
    html: page(`<article class="h-entry"><span class="p-author h-card"><a class="u-url" href="https://hachyderm.io/@x">ximena</a></span><div class="e-content p-name">@aadharsh this is a genuinely useful tool, ran it on our docs site and found we 403 every AI crawler without knowing it</div><a class="u-in-reply-to" href="https://aadhar.sh/lens"></a></article>`) },
  { id: "bridgy-like", label: "genuine", source: "https://brid.gy/like/mastodon/@y@mas.to/2244/sam", target: T("/garage/horizon"),
    html: page(`<article class="h-entry"><span class="p-author h-card"><a class="u-url" href="https://mas.to/@sam">sam</a></span><a class="u-like-of" href="https://aadhar.sh/garage/horizon"></a></article>`) },
  { id: "bookmark", label: "genuine", source: "https://tom.page/bookmarks/2026-10-01", target: T("/garage/resample"),
    html: page(`<div class="h-entry"><a class="u-bookmark-of" href="https://aadhar.sh/garage/resample">Resampling in linear light</a><div class="e-content">Good explainer on why gamma-space downscales darken fine detail. Saving for the image pipeline rewrite.</div><a class="p-author h-card" href="https://tom.page">Tom</a></div>`) },
  { id: "github-issue", label: "genuine", source: "https://github.com/someorg/imgtool/issues/412", target: T("/garage/resample"),
    html: page(`<div class="comment-body markdown-body"><p>Our thumbnailer resizes in sRGB and it visibly darkens high-frequency texture. There is a measured writeup here: <a href="https://aadhar.sh/garage/resample">https://aadhar.sh/garage/resample</a>. Proposal: convert to linear before the Lanczos pass, behind a flag at first.</p></div>`, "Resize in linear light · Issue #412 · someorg/imgtool") },
  { id: "newsletter-blurb", label: "genuine", source: "https://webperf.news/issue-88", target: T("/garage/pqc"),
    html: page(`<h1>WebPerf Weekly #88</h1><h2>Deep dive</h2><p><a href="https://aadhar.sh/garage/pqc">What post-quantum signatures cost on Workers Free</a>. A careful piece measuring ML-DSA signing at 8.58ms and then multiplying it by fan-out, which is the step everyone skips. Worth reading in full.</p><h2>Also</h2><ul>${links(6, "perf")}</ul>`, "WebPerf Weekly #88") },
  { id: "forum-post", label: "genuine", source: "https://lobste.rs/s/abc123/the_other_web", target: T("/lens"),
    html: page(`<div class="story"><a href="https://aadhar.sh/lens">The Other Web: what a machine sees at any URL</a></div><div class="comment"><div class="comment_text"><p>The control rows are the smart part. A 403 to GPTBot means nothing until you know Chrome from the same IP gets a 200.</p></div></div>`, "The Other Web | Lobsters") },

  { id: "links-roundup", label: "listing", source: "https://linkdump.io/2026/w40", target: T("/garage/htmx"),
    html: page(`<h1>Links, week 40</h1><ul>${links(14, "dump")}<li><a href="https://aadhar.sh/garage/htmx">Is htmx worth it</a></li>${links(14, "dump2")}</ul>`, "Links, week 40") },
  { id: "directory", label: "listing", source: "https://personalsit.es/", target: T("/"),
    html: page(`<h1>personalsit.es</h1><p>A list of personal websites.</p><ul>${links(20, "person")}<li><a href="https://aadhar.sh/">aadhar.sh</a></li>${links(20, "person2")}</ul>`, "Personal Sites") },
  { id: "webring", label: "listing", source: "https://xpring.net/members", target: T("/"),
    html: page(`<h1>The XP Webring</h1><p>Sites that look like 2003.</p><table><tr><td><a href="https://aadhar.sh/">aadhar.sh</a></td><td>Luna desktop, photos</td></tr><tr><td><a href="https://neo.example/">neo</a></td><td>Geocities revival</td></tr><tr><td><a href="https://w98.example/">w98</a></td><td>Win98 blog</td></tr></table>`, "The XP Webring") },
  { id: "planet-feed", label: "listing", source: "https://planet.indieweb.example/", target: T("/writing/colophon"),
    html: page(`<h1>Planet IndieWeb</h1><div class="entry"><h2><a href="https://aadhar.sh/writing/colophon">Colophon</a></h2><p>by aadhar.sh · 2026-09-30</p><p>Why the site looks like Windows XP, and what it costs in bytes.</p></div><div class="entry"><h2><a href="https://b.example/p">Owning your notes</a></h2><p>by b.example</p></div>`, "Planet IndieWeb") },

  { id: "casino", label: "spam", source: "https://best-slots-review.click/top-10", target: T("/"),
    html: page(`<h1>Top 10 Online Casinos 2026 - Instant Payouts!</h1><p>Claim 500 free spins today. Our experts tested every bonus code. Play slots, roulette and live dealer games with crypto deposits.</p><footer><p>Partners: <a href="https://aadhar.sh/">aadhar sh</a> <a href="https://x1.example">payday loans</a> <a href="https://x2.example">cheap viagra</a></p></footer>`, "Top 10 Online Casinos 2026") },
  { id: "seo-vpn", label: "spam", source: "https://techguidez.net/best-vpn", target: T("/garage/pqc"),
    html: page(`<article><h1>Best VPN for Streaming in 2026 (Tested)</h1><p>Looking for the best VPN? In this ultimate guide we compare speeds, prices and features. For more about <a href="https://aadhar.sh/garage/pqc">quantum security</a> see resources. NordVPN offers 70% off with our link. Click here to get the deal now. Limited time offer!</p></article>`, "Best VPN for Streaming in 2026") },
  { id: "scraped-copy", label: "spam", source: "https://content-hub-24.xyz/encoding-study-12", target: T("/garage/encoding"),
    html: page(`<h1>encoding study</h1><p>Source: <a href="https://aadhar.sh/garage/encoding">aadhar.sh</a></p><p>the colour avif tiers are 4 4 4 since and the camera recording 4 2 2 is not an argument against it 4 2 2 describes the frame a 600px tier is that frame s square reduced so every tier pixel averages chroma samples across and down</p><div class="ads">ADVERTISEMENT</div>`, "encoding study | Content Hub 24") },
  { id: "crypto-airdrop", label: "spam", source: "https://airdrop-claim.app/aadhar", target: T("/serendipity"),
    html: page(`<h1>$NOODL Airdrop is LIVE</h1><p>Connect your wallet to claim 10,000 $NOODL. Featured on <a href="https://aadhar.sh/serendipity">aadhar.sh events</a>! Only 500 spots left. Presale ends in 2 hours.</p>`, "Claim your airdrop") },
  { id: "link-farm", label: "spam", source: "https://web-resources-directory.biz/page/4471", target: T("/garage/htmx"),
    html: page(`<h1>Useful Web Resources page 4471</h1><ul>${links(30, "farm")}<li><a href="https://aadhar.sh/garage/htmx">htmx</a></li><li><a href="https://cbd.example">best cbd gummies</a></li><li><a href="https://essay.example">buy essay online</a></li>${links(30, "farm2")}</ul>`, "Web Resources Directory p.4471") },
  { id: "comment-spam", label: "spam", source: "https://oldforum.example/thread/88?page=31", target: T("/writing/colophon"),
    html: page(`<div class="post"><b>seo_master_99</b><p>Great post!! Very informative, thanks for sharing. Check my site for more <a href="https://aadhar.sh/writing/colophon">info</a> and also <a href="https://loans.example">fast loans no credit check</a>.</p></div>`, "Thread 88 - page 31") },
  { id: "ai-filler", label: "spam", source: "https://trendvault.blog/personal-websites-landscape", target: T("/"),
    html: page(`<article><h1>Exploring the Landscape of Personal Websites in 2026</h1><p>In today's digital landscape, personal websites remain a robust way to unlock your online presence. Sites like <a href="https://aadhar.sh/">aadhar.sh</a> leverage cutting-edge design. Furthermore, a website is a game-changer. Buy our SEO package today.</p></article>`, "Exploring the Landscape of Personal Websites") },
  { id: "pharmacy", label: "spam", source: "https://rx-online-store.top/", target: T("/lens"),
    html: page(`<h1>Online Pharmacy - No Prescription Needed</h1><p>Generic pills shipped worldwide, 80% off. <a href="https://aadhar.sh/lens">lens</a> discreet packaging, bitcoin accepted.</p>`, "Online Pharmacy") },
];

// The four hosts --swap moves, each onto the other population's kind of domain.
const SWAP: Record<string, string> = {
  casino: "https://github.com/x", pharmacy: "https://lobste.rs/x",
  "blog-encoding": "https://best-slots-review.click/x", "reply-colophon": "https://rx-online-store.top/x",
};

async function workersAiAuth(): Promise<{ token: string, account: string }> {
  const account = String((await siteConfig()).account_id);
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, account };
  const { stdout } = await run(...wranglerCommand(["auth", "token", "--json"]), { cwd: ROOT });
  const token = JSON.parse(stdout)?.token;
  if (!token) throw new Error("no CLOUDFLARE_API_TOKEN and wrangler auth token returned none; run `bun run wrangler login`");
  return { token, account };
}

if (import.meta.main) {
  const swap = process.argv.includes("--swap");
  for (const s of WEBMENTION_EVAL) {
    if (!linksTo(s.html, s.target, s.source)) throw new Error(`${s.id} does not link to ${s.target}, so it would never reach the sort`);
  }
  const { token, account } = await workersAiAuth();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${SORT_MODEL}`;

  let right = 0, caught = 0, spams = 0, falseSpam = 0, failed = 0;
  const ms: number[] = [];
  for (const s of WEBMENTION_EVAL) {
    if (swap && !SWAP[s.id]) continue;
    const parsed = parseSource(s.html, s.source, s.target);
    const request = buildSortRequest({ ...parsed, source: swap ? SWAP[s.id] : s.source });
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    const body: any = res ? await res.json().catch(() => null) : null;
    const p = body?.success ? body.result.answers?.sort?.probabilities : null;
    if (!p) { failed++; console.log(`  FAILED   ${s.id}`); continue; }
    ms.push(performance.now() - t0);
    const verdict = SORT_LABELS.reduce((a, b) => (Number(p[b]) > Number(p[a]) ? b : a));
    if (verdict === s.label) right++;
    if (s.label === "spam") { spams++; if (Number(p.spam) >= 0.5) caught++; } else if (Number(p.spam) >= 0.5) falseSpam++;
    const probs = SORT_LABELS.map((l) => `${l[0]}${Number(p[l]).toFixed(2)}`).join(" ");
    console.log(`${verdict === s.label ? " " : "X"} ${s.label.padEnd(8)}-> ${verdict.padEnd(8)}${probs}  ${s.id}`);
  }
  const n = WEBMENTION_EVAL.filter((s) => !swap || SWAP[s.id]).length - failed;
  ms.sort((a, b) => a - b);
  console.log(`\n${swap ? "host-swapped " : ""}3-way ${right}/${n}; spam at 0.5 caught ${caught}/${spams}, ${falseSpam} non-spam called spam; failed ${failed}; median ${ms.length ? Math.round(ms[ms.length >> 1]) : "-"} ms`);
}
