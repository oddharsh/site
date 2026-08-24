// shell-data.mjs — authored facts for the shared XP desktop.
//
// This module is build-time only. gen-desktop-partial.mjs projects it into the
// static HTML partial, the icon sprite, and the small runtime tables that need
// to stay in nav.js/nav-run.js. Keeping the facts here means the browser
// runtime is no longer the build system's database.

// The shell's Speculation Rules, and the one authored copy of them. Until
// 2026-08-11 this block was hand-written into 26 documents plus a runtime
// injector in nav.js, and the 27 copies had forked: garage pages excluded
// /whoareyou alone, lwe pages carried a dead prefetch rule, lwe/encoding.html
// carried two exclusions that two earlier commits had deliberately deleted
// site-wide, and only the homepage and nav.js held the full list. See #338.
//
// "moderate" prerenders on hover or pointerdown rather than on load, so a
// visitor who never opens /garage pays nothing for it and a visitor who does
// gets a rendered document. That is why the cross-document View Transition could
// come out: with the document already rendered there is no latency left for an
// animation to cover.
//
// Every exclusion is here for one reason, that prerendering the path cannot
// produce a document the next click will use:
//
//   /whoareyou   a per-request fingerprint, so a speculative render is a lie
//   /run         the Start orb's JavaScript-off floor. This ruleset only exists
//                when JS is on, and with JS on the orb opens the palette instead
//                of navigating, so the render had no reader (#337)
//   /rn          a 302 to Spotify built from a KV read, so the prerender spends
//                a worker invocation and then dies at the cross-origin redirect
//   the others   raw text and images, which are not documents
//
// There is deliberately NO prefetch rule. An eager /garage/* + /lwe/* one lived
// on the 12 lwe pages and was measured fetching NOTHING, twice, by
// tools/speculation-probe.ts: zero documents when /lwe offered it 12 matching
// anchors at load, and zero when the Run palette injected 30 more on /lwe/utf8,
// while the control in the same run (hover a link, moderate) reached the origin.
// The homepage had already deleted its own copy on 2026-07-30 after measuring
// the same nothing. Re-add one only behind a fresh measurement, never because
// the rule reads like it ought to work.
export const SPECULATION = {
  prerender: [{
    where: {
      and: [
        { href_matches: "/*" },
        ...["/whoareyou*", "/run", "/rn*", "/images*", "/index.md", "/llms.txt"]
          .map((href_matches) => ({ not: { href_matches } })),
      ],
    },
    eagerness: "moderate",
  }],
};

export const PROFILES = [
  { label: "GitHub", url: "https://github.com/oddharsh" },
  { label: "Twitter", url: "https://x.com/oddhash", background: "linear-gradient(180deg,oklch(78% 0.12 233),oklch(64% 0.16 240))", glyph: "@" },
  { label: "Photos", icon: "Instagram", hint: "Instagram", url: "https://www.instagram.com/aadharsh.hif", background: "linear-gradient(180deg,oklch(74% 0.08 78),oklch(52% 0.10 52))", glyph: '<i class="cam" aria-hidden="true"></i>' },
  { label: "Curius", url: "https://curius.app/aadharsh-pannirselvam", background: "linear-gradient(180deg,oklch(73% 0.15 145),oklch(60% 0.17 146))", glyph: "C" },
  { label: "Beli", url: "https://beliapp.com/users/aadharsh", background: "linear-gradient(180deg,oklch(81% 0.16 70),oklch(68% 0.18 55))", glyph: "B" },
  { label: "Music", icon: "Spotify", hint: "Spotify", url: "https://open.spotify.com/user/aadharsh2010", background: "linear-gradient(180deg,oklch(75% 0.17 146),oklch(62% 0.19 147))", glyph: "♪" },
];

export const TASKBAR = [
  { label: "garage", path: "/garage", hint: "prototypes + experiments" },
  { label: "lwe", path: "/lwe", hint: "chat-style explainers + live demos" },
  { label: "writing", path: "/writing", hint: "notes, in flux: an editable notepad" },
  { label: "reading", path: "/reading", hint: "what I've been reading, from Curius" },
  { label: "serendipity", path: "/serendipity", hint: "events worth going to" },
  { label: "around", path: "/around", hint: "the crypto-VC neighborhood" },
  { label: "lens", path: "/lens", hint: "the other web: how machines read a URL" },
  { label: "terminal", path: "/terminal", hint: "terminal utilities, drivable by keypress" },
  { label: "pixel peeper", path: "/pixel-peeper", hint: "a compression vision test — whose eye do you have?" },
  { label: "music", path: "/rn", hint: "what I'm listening to right now" },
  { label: "coffee", path: "/coffee", hint: "book a coffee / bagel" },
];

// TUPLES: each entry is spread into sectionTile(prefix, colors, art), and a
// widened (string | string[])[] has no arity for the spread to satisfy.
const ICON_DEFS: Record<string, [prefix: string, colors: string[], art: string]> = {
  garage: ["garage", ["#ffb45a", "#ef8f24", "#c2660a", "#8f4d06"], '<g fill="#fff"><rect x="14" y="5" width="4" height="22" rx="1.5"/><rect x="5" y="14" width="22" height="4" rx="1.5"/><rect x="14" y="5" width="4" height="22" rx="1.5" transform="rotate(45 16 16)"/><rect x="14" y="5" width="4" height="22" rx="1.5" transform="rotate(-45 16 16)"/><circle cx="16" cy="16" r="6.5"/></g><circle cx="16" cy="16" r="2.8" fill="#ef8f24"/>'],
  writing: ["writing", ["#6fa0ee", "#2f6bd6", "#1a4ba8", "#143c86"], '<g fill="#fff"><rect x="8" y="8" width="16" height="2.6" rx="1.3"/><rect x="8" y="14.7" width="16" height="2.6" rx="1.3"/><rect x="8" y="21.4" width="10" height="2.6" rx="1.3"/></g>'],
  reading: ["reading", ["#de8186", "#c1545a", "#93333a", "#732830"], '<g fill="#fff"><path d="M16 9 C13 7.2 9 7 6 7.6 V24 C9 23.4 13 23.6 16 25 Z"/><path d="M16 9 C19 7.2 23 7 26 7.6 V24 C23 23.4 19 23.6 16 25 Z" opacity=".82"/></g><path d="M16 9 V25" stroke="#c1545a" stroke-width="1.4"/>'],
  serendipity: ["serendipity", ["#a886e8", "#7c4dd6", "#5a32a8", "#482788"], '<rect x="6" y="8" width="20" height="18" rx="2" fill="#fff"/><rect x="6" y="8" width="20" height="5" rx="2" fill="#e7e7ef"/><g fill="#7c4dd6"><rect x="9" y="16" width="3.4" height="3.4"/><rect x="14.3" y="16" width="3.4" height="3.4"/><rect x="19.6" y="16" width="3.4" height="3.4"/><rect x="9" y="21" width="3.4" height="3.4"/><rect x="14.3" y="21" width="3.4" height="3.4"/></g>'],
  around: ["around", ["#5cc6ba", "#1f9b8e", "#137468", "#0d5a50"], '<path d="M16 6 C11.6 6 8 9.3 8 13.6 C8 19 16 26 16 26 C16 26 24 19 24 13.6 C24 9.3 20.4 6 16 6 Z" fill="#fff"/><circle cx="16" cy="13.6" r="3.2" fill="#1f9b8e"/>'],
  whoareyou: ["whoareyou", ["#8190e6", "#4a5bd0", "#3140a4", "#263286"], '<rect x="15" y="4" width="2" height="4" fill="#fff"/><circle cx="16" cy="4" r="2" fill="#fff"/><rect x="8" y="9" width="16" height="14" rx="3.5" fill="#fff"/><circle cx="12.5" cy="15" r="2.1" fill="#4a5bd0"/><circle cx="19.5" cy="15" r="2.1" fill="#4a5bd0"/><rect x="12" y="19" width="8" height="1.8" rx="0.9" fill="#4a5bd0"/>'],
  music: ["music", ["#6fcd8a", "#2faa55", "#1d8040", "#156030"], '<g fill="#fff"><rect x="17" y="7" width="2.6" height="14"/><path d="M19.6 7 C23 8 25 10 24.4 13.6 C23 11 21 11 19.6 11.8 Z"/><ellipse cx="14" cy="21" rx="4.4" ry="3.5"/></g>'],
  coffee: ["coffee", ["#b08858", "#875c34", "#5e3c1e", "#472d16"], '<path d="M8 12 h13 v6 a6.5 6.5 0 0 1-13 0 Z" fill="#fff"/><path d="M21 13 h3 a2.6 2.6 0 0 1 0 5.2 h-3" fill="none" stroke="#fff" stroke-width="2.2"/><g stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M11 5.5 v3"/><path d="M14.5 5 v3.5"/></g>'],
  lwe: ["lwe", ["#838ae6", "#4b53c9", "#333aa0", "#272d82"], '<path d="M6 9 h20 a2 2 0 0 1 2 2 v9 a2 2 0 0 1-2 2 H14 l-5 4 v-4 H6 a2 2 0 0 1-2-2 v-9 a2 2 0 0 1 2-2 Z" fill="#fff"/><g stroke="#4b53c9" stroke-width="1.7" stroke-linecap="round" fill="none"><path d="M8.5 13.5 q2 -2.4 4 0 t4 0 t4 0"/><path d="M8.5 18 q2 -2.4 4 0 t4 0"/></g>'],
  lens: ["lens", ["#79c7e6", "#2f9fc4", "#1d7895", "#145d73"], '<rect x="5.5" y="5" width="15" height="19" rx="2" fill="#fff"/><g fill="#2f9fc4"><rect x="8.5" y="9.5" width="9" height="1.7" rx=".6"/><rect x="8.5" y="13" width="9" height="1.7" rx=".6"/><rect x="8.5" y="16.5" width="6" height="1.7" rx=".6"/></g><circle cx="20.5" cy="20.5" r="6" fill="#2f9fc4" stroke="#fff" stroke-width="2.2"/><circle cx="18.6" cy="18.6" r="1.5" fill="#fff" opacity=".85"/><path d="M24.8 24.8 L28.5 28.5" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>'],
  terminal: ["terminal", ["#4a6ea8", "#22497f", "#012456", "#001633"], '<rect x="4" y="6.5" width="24" height="19" rx="2" fill="#fff"/><rect x="4" y="6.5" width="24" height="4.2" rx="2" fill="#dfe3ee"/><g stroke="#012456" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M9 15 l3.4 2.9 L9 20.8"/></g><rect x="15.2" y="19.2" width="7.6" height="2" rx="1" fill="#012456"/>'],
  "pixel peeper": ["peeper", ["#f19ad0", "#d24d9c", "#a32d73", "#82205a"], '<path d="M2.6 16 C7 9.6 11.4 7.1 16 7.1 C20.6 7.1 25 9.6 29.4 16 C25 22.4 20.6 24.9 16 24.9 C11.4 24.9 7 22.4 2.6 16 Z" fill="#fff"/><rect x="11.1" y="11.1" width="9.8" height="9.8" rx="1" fill="#a32d73"/><rect x="12.9" y="12.9" width="3.1" height="3.1" rx=".5" fill="#fff" opacity=".92"/>'],
};

function sectionTile(prefix, colors, art) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>`
    + `<linearGradient id="${prefix}F" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset=".5" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/></linearGradient>`
    + `<linearGradient id="${prefix}G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + `<filter id="${prefix}S" x="-20%" y="-15%" width="140%" height="145%"><feDropShadow dx="0" dy=".6" stdDeviation=".7" flood-color="#000" flood-opacity=".32"/></filter>`
    + `</defs><g filter="url(#${prefix}S)"><rect x="1" y="1" width="30" height="30" rx="7" fill="url(#${prefix}F)" stroke="${colors[3]}" stroke-width="1"/>`
    + `<rect x="2.3" y="2.3" width="27.4" height="27.4" rx="5.8" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1"/>`
    + `<path d="M3 9 Q3 3 9 3 H23 Q29 3 29 9 V12.5 Q16 18 3 12.5 Z" fill="url(#${prefix}G)"/>`
    + `<g style="filter:drop-shadow(0 .5px .4px rgba(0,0,0,.35))">${art}</g></g></svg>`;
}

export const SECTION_ICONS = Object.fromEntries(
  Object.entries(ICON_DEFS).map(([name, args]) => [name, sectionTile(...args)]),
);

// These three SVGs are the authored tray art. The generator crops them into the
// shared immutable sprite; the HTML keeps real links as its no-JS behavior.
export const TRAY_ITEMS = [
  {
    id: "axp-sysprop", kind: "sysprop", href: "/whoareyou",
    title: "System Properties · what one request reveals", label: "System Properties",
    svg: '<svg viewBox="0 0 24 24"><defs><filter id="spSh" x="-30%" y="-20%" width="160%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><linearGradient id="spBez" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3efe4"></stop><stop offset=".5" stop-color="#d6d0be"></stop><stop offset="1" stop-color="#b1aa94"></stop></linearGradient><linearGradient id="spScr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fb0e8"></stop><stop offset=".5" stop-color="#2f72b6"></stop><stop offset="1" stop-color="#16548f"></stop></linearGradient><linearGradient id="spGl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".5"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs><g filter="url(#spSh)"><ellipse cx="12" cy="21.3" rx="5.2" ry="1" fill="#8f876f" opacity=".5"></ellipse><rect x="10.4" y="17.2" width="3.2" height="2.8" fill="#c3bca6"></rect><path d="M7 21 Q7 19.7 8.6 19.7 H15.4 Q17 19.7 17 21 Z" fill="url(#spBez)" stroke="#897f66" stroke-width=".4"></path><rect x="2.3" y="2.7" width="19.4" height="14.9" rx="2" fill="url(#spBez)" stroke="#857c63" stroke-width=".5"></rect><rect x="2.95" y="3.3" width="18.1" height="13.7" rx="1.5" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width=".5"></rect><rect x="4.2" y="4.7" width="15.6" height="11" rx=".8" fill="#0f3d63"></rect><rect x="4.6" y="5.1" width="14.8" height="10.2" rx=".6" fill="url(#spScr)"></rect><path d="M4.6 5.1 H19.4 V7.9 Q12 11.8 4.6 9.1 Z" fill="url(#spGl)"></path><circle cx="20" cy="15.9" r=".8" fill="#84e85a" stroke="#3f7a2a" stroke-width=".3"></circle></g></svg>',
  },
  {
    id: "axp-security", kind: "security", href: "/security",
    title: "Security Center · what guards this site", label: "Security Center",
    svg: '<svg viewBox="0 0 24 24"><defs><filter id="seSh" x="-30%" y="-15%" width="160%" height="150%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><linearGradient id="seF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ed24f"></stop><stop offset=".5" stop-color="#3f9c24"></stop><stop offset="1" stop-color="#297818"></stop></linearGradient><linearGradient id="seGl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></linearGradient></defs><g filter="url(#seSh)"><path d="M12 2.2 L4.4 4.9 V11.4 C4.4 16.2 8 19.7 12 21.6 C16 19.7 19.6 16.2 19.6 11.4 V4.9 Z" fill="url(#seF)" stroke="#1f5f12" stroke-width=".7"></path><path d="M12 3.4 L5.6 5.7 V11.3 C5.6 15.3 8.6 18.4 12 20.1 C15.4 18.4 18.4 15.3 18.4 11.3 V5.7 Z" fill="none" stroke="#c6f2a6" stroke-opacity=".5" stroke-width=".6"></path><path d="M12 3.4 L5.6 5.7 V8.8 Q12 10.8 18.4 8.8 V5.7 Z" fill="url(#seGl)"></path><path d="M8 11.5 L11 14.5 L16.2 8.4" fill="none" stroke="#103f08" stroke-opacity=".35" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"></path><path d="M8 11.2 L11 14.2 L16.2 8.1" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></g></svg>',
  },
  {
    id: "axp-updates", kind: "updates", href: "/updates",
    title: "Windows Update · what shipped lately", label: "Windows Update",
    svg: '<svg viewBox="0 0 24 24"><defs><filter id="upSh" x="-25%" y="-20%" width="150%" height="155%"><feDropShadow dx="0" dy=".5" stdDeviation=".5" flood-color="#000" flood-opacity=".28"></feDropShadow></filter><radialGradient id="upG" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="#8eccf2"></stop><stop offset=".55" stop-color="#3f8fd0"></stop><stop offset="1" stop-color="#175a98"></stop></radialGradient><linearGradient id="upB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#74cf52"></stop><stop offset="1" stop-color="#2c861d"></stop></linearGradient><radialGradient id="upGl" cx=".35" cy=".3" r=".5"><stop offset="0" stop-color="#ffffff" stop-opacity=".7"></stop><stop offset="1" stop-color="#ffffff" stop-opacity="0"></stop></radialGradient></defs><g filter="url(#upSh)"><circle cx="10.6" cy="10.6" r="8.2" fill="url(#upG)" stroke="#114e7d" stroke-width=".6"></circle><g fill="none" stroke="#dcefff" stroke-width=".55" opacity=".7"><path d="M2.5 10.6 H18.7"></path><path d="M3.6 7.1 H17.6"></path><path d="M3.6 14.1 H17.6"></path><path d="M10.6 2.4 V18.8"></path><ellipse cx="10.6" cy="10.6" rx="3.1" ry="8.2"></ellipse></g><ellipse cx="7.4" cy="7" rx="3.4" ry="2.2" fill="url(#upGl)"></ellipse><circle cx="17.8" cy="17.8" r="4.5" fill="url(#upB)" stroke="#ffffff" stroke-width=".9"></circle><path d="M17.8 15.6 A2.2 2.2 0 1 1 15.7 18.4" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round"></path><path d="M16.9 14.9 L18.8 15.3 L17.5 16.8 Z" fill="#ffffff"></path></g></svg>',
  },
];

export const DESKTOP = [
  { label: "Notepad", path: "/writing", kind: "note", hint: "writing, in flux" },
  ...PROFILES.map((profile) => ({ ...profile, path: profile.url, kind: "profile" })),
];
