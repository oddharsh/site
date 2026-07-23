# `design/` — what is canon and what is history

Three kinds of file live here and they carry very different authority. Read this
before treating anything below as a spec.

## Canon (current, load-bearing)

- **`DESIGN.md`** — the Luna brief. The canonical reference plus the
  DON'T-modernize guardrails. CLAUDE.md points here.
- **`tokens/`** — the canonical token set (colors, bevels, fonts, typography;
  115 custom properties). `holding/luna.css` derives from these and never
  redefines them. Change a token here first, then flow it into luna.css.
- **`styles.css`** — the entry point that `@import`s the four token files.
  Nothing the site serves links it; the `aadhar-sh-design` skill package does.
  See "Files whose only consumer lives outside this repo" in MAINTENANCE.md.

## History (a record of decisions, NOT a spec to implement)

These were produced by design passes in early July 2026 and are kept because the
reasoning in them is worth having. **The site did not converge on them, and the
numbers in them are stale.** Do not read a byte budget or an architecture out of
these files and treat it as a target.

- **`GREENFIELD.md`** (2026-07-02) — the blank-slate blueprint from a 4-design,
  4-judge pass. Specifies a `shell.js` at ~3.3KB brotli and a shared
  `icons.svg`. Neither exists: the shell is still `nav.js` at ~80KB raw, and the
  icons are inline SVG in nav.js and lib/desktop.js. Its luna.css bet DID ship
  (2026-07-21), which is the part that landed.
- **`PORTING.md`** (2026-07-02) — the companion manifest of which tricks and
  which copy survive that rewrite. Its file:line citations point at a tree that
  has since moved.
- **`explore-bac-map.md`** (2026-07-05) — the four-quadrant map for the B/A/C
  cleanup-and-guard program. Its "known knowns" section is still a decent
  orientation to the request path and caching model; its build plan is spent.

If one of these ever becomes the plan again, move it back up to Canon and
re-measure everything it asserts first.
