// ── the rel=me identity chain ───────────────────────────────────────────────
// This site can already prove it owns its own domain, and nothing in the tree
// said so. Found 2026-08-28 while scoping IndieAuth for the webmention.rocks
// receiver suite, which turned out to need no IndieAuth at all:
//
// Both halves are load-bearing and only one of them is in this repository. The
// half that is here is pinned below. The other half is the "https://aadhar.sh"
// link on github.com/oddharsh's profile: drop it and this chain breaks silently,
// with no diff anywhere and no error until somebody tries to sign in.
import { DESKTOP_CHROME, PROFILES, assert, test } from "./contract-shared.ts";

function relTokens(tag) {
  const m = tag.match(/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
  return m ? m[1].replace(/^["']|["']$/g, "").trim().split(/\s+/).map((t) => t.toLowerCase()) : [];
}

test("every desktop profile link carries rel=me, which is how this domain proves it is ours", () => {
  const anchors = DESKTOP_CHROME.match(/<a\b[^>]*>/gi) || [];
  assert.ok(anchors.length >= 10, `the shell scanner found ${anchors.length} anchors; it has stopped matching`);

  let checked = 0;
  for (const profile of PROFILES) {
    const tag = anchors.find((a) => a.includes(`href="${profile.url}"`));
    assert.ok(tag, `the desktop shell no longer links ${profile.label} (${profile.url})`);
    assert.ok(
      relTokens(tag).includes("me"),
      `${profile.label} lost rel=me. indielogin.com reads these to decide which provider can vouch for aadhar.sh, ` +
      `so dropping the token silently removes this site's ability to sign in as itself.`
    );
    checked++;
  }
  assert.ok(checked >= 6, `only ${checked} profile links checked`);
});

test("GitHub is among them, because it is the provider indielogin actually resolved", () => {
  const github = PROFILES.find((p) => p.url.startsWith("https://github.com/"));
  assert.ok(github, "the GitHub profile link is the live half of the identity chain");
  assert.ok(DESKTOP_CHROME.includes(`href="${github.url}"`));
});
