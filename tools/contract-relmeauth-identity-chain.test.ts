// ── the rel=me identity chain ───────────────────────────────────────────────
// This site can already prove it owns its own domain, and nothing in the tree
// said so. Found 2026-08-28 while scoping IndieAuth for the webmention.rocks
// receiver suite, which turned out to need no IndieAuth at all:
//
//   webmention.rocks /auth/start  ->  302 indielogin.com/auth?me=https://aadhar.sh/
//   indielogin.com                ->  302 github.com/login/oauth/authorize
//
// indielogin went straight to GitHub with no provider chooser, which it can only
// do after reading a rel=me link off this homepage AND finding the matching link
// back on that GitHub profile. That is RelMeAuth (rel=me both ways), not
// IndieAuth: this site advertises no authorization_endpoint and no
// rel=indieauth-metadata, so a client doing real IndieAuth discovery still finds
// nothing. What it has is the older mechanism, and that is the one indielogin
// uses, so the receiver suite is reachable today.
//
// Both halves are load-bearing and only one of them is in this repository. The
// half that is here is pinned below. The other half is the "https://aadhar.sh"
// link on github.com/oddharsh's profile: drop it and this chain breaks silently,
// with no diff anywhere and no error until somebody tries to sign in.
//
// The failure is quiet in the usual direction. `rel="noopener external"` renders
// and behaves exactly like `rel="noopener me external"`, so losing the token
// costs nothing visible and takes the domain's identity with it.
import { DESKTOP_CHROME, PROFILES, assert, test } from "./contract-shared.ts";

// rel is a space-separated token list, so "me" has to BE one of the tokens —
// the same rule webmention endpoint discovery applies to rel=webmention.
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
  // the floor, because a PROFILES that emptied would pass the loop above
  // without checking anything, which is this repo's most repeated failure.
  assert.ok(checked >= 6, `only ${checked} profile links checked`);
});

test("GitHub is among them, because it is the provider indielogin actually resolved", () => {
  // Measured rather than assumed: of the six profiles, GitHub is the one
  // indielogin chose, so it is the one whose rel=me is doing real work today.
  // The others are candidates that would take over if it went away.
  const github = PROFILES.find((p) => p.url.startsWith("https://github.com/"));
  assert.ok(github, "the GitHub profile link is the live half of the identity chain");
  assert.ok(DESKTOP_CHROME.includes(`href="${github.url}"`));
});
