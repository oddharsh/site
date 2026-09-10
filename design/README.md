# Design references

- **`DESIGN.md`** defines the Luna appearance and the guardrails against modernizing it.
- **`tokens/`** holds the canonical colors, bevels, fonts, and typography. Change tokens here before updating `src/styles/luna.css`.
- **`styles.css`** imports the four token files for the external `aadhar-sh-design` skill. Its consumer is documented in `docs/MAINTENANCE.md`.

## Retired plans

The July 2026 `GREENFIELD.md`, `PORTING.md`, and `explore-bac-map.md` plans were removed on 2026-09-09. Their budgets and source locations were stale; the 2026-07-26 audit had closed the Greenfield implementation list.

Find their deletion with `git log --diff-filter=D -- design/`. Read a removed file with `git show <deletion-commit>^:design/<filename>`; that revision also contains the full audit in this README.

## Decisions retained from the July audit

- **Keep the shell construction path.** The partial adopted in #97 supplied the desktop for JavaScript-disabled visitors. The remaining construction code measured under 1 KB Brotli; the proposed 88% saving depended on generated content the build still needed.
- **Keep scripted Start and minimize controls.** The server-rendered partial already supplied the static desktop and eliminated its layout shift. The proposed checkbox alternative introduced unusual assistive-technology semantics.
- **Avoid wholesale inline photo metadata.** The July experiment added 2–2.5 KB Brotli for twelve photos, including for mobile visitors whose coarse pointer prevents tooltip loading. Photo metadata baking shipped separately in v139. Later targeted histogram changes have their own measurements.
- **Keep pointer tooltips cursor-following.** Control anchoring was tried and rolled back; keyboard focus still anchors at the control.
- **Keep icon position persistence and the proposed `@layer` cascade out.** Persisted layouts could not always be honored; `src/styles/luna.css` records the cascade decision.

These are dated decisions, not current size measurements. Re-measure before reopening a performance argument.

The July audit also deferred two optional ideas: exclusive changelog years through `details name=`, and a separate scrolling ListView for the tracklist (#101).
