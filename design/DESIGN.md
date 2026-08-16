# aadhar.sh — design brief (Windows XP "Luna", Blue)

**Read this before touching any visual code.** This is a *resto-mod* of the
Windows XP **Luna** theme (the Blue / default scheme). It is **not** a redesign
target — the goal is to stay tight and consistent with Luna, not to "modernize,"
"polish," or "clean up" the aesthetic. If a change makes the site look more like
a 2020s SaaS app (rounded cards, soft blurred shadows, Inter/system-ui,
flat-design gradients), it is **wrong by definition** here.

Canonical token values live in [`tokens/`](./tokens/) (colors, typography,
bevels, fonts — one file each). Reusable class
vocabulary (`.title-bar`, `.window`, `.content`, …) is documented in the root
`CLAUDE.md` "XP visual vocabulary" section.

---

## Philosophy: period-correct render, modern in source

- **Render like 2003, author like 2026.** Colors are encoded in **OKLCH** so the
  source reads modern and we get wide-gamut depth on P3 displays — but they
  resolve to period-correct Luna blues/beiges. Low-chroma chrome (the beige
  control face, greys) stays in plain hex; saturated accents (the title-bar
  blue) use OKLCH. Don't "simplify" OKLCH back to hex, and don't add gratuitous
  OKLCH to flat greys.
- **Native-available fonts only.** No web fonts, no `@font-face`. The stacks are
  ordered so the *first reliably-present* font on the author's macOS and on
  visitors' machines is what actually renders (see Typography).
- **Honesty rule (carried from the rest of the project).** Don't fabricate UI
  that implies capability the site doesn't have. Don't invent metadata, states,
  or affordances to fill space.

---

## Canonical Luna reference (ground truth)

The real Luna **Blue** scheme, for conformance. The site is *inspired by* these,
rendered slightly brighter/more saturated (Luna itself was "saturated colors and
bitmaps" — leaning vivid is in-spirit, not a violation).

### System palette

| Role | Canonical hex | RGB |
|---|---|---|
| Active title (caption) | `#0054E3` | 0, 84, 227 |
| Active title gradient end | `#3D95FF` | 61, 149, 255 |
| Inactive title | `#7A96DF` | 122, 150, 223 |
| **Control / window chrome (ButtonFace)** | `#ECE9D8` | 236, 233, 216 |
| Control light (ButtonLight) | `#F1EFE2` | 241, 239, 226 |
| 3D highlight (ButtonHighlight) | `#FFFFFF` | 255, 255, 255 |
| Control shadow (ButtonShadow) | `#ACA899` | 172, 168, 153 |
| 3D dark shadow | `#716F64` | 113, 111, 100 |
| Window / field background | `#FFFFFF` | 255, 255, 255 |
| Window text | `#000000` | 0, 0, 0 |
| Selection (Highlight) | `#316AC5` | 49, 106, 197 |

### Fonts (canonical)

- **Title bars / captions → Trebuchet MS** (bold). This is the *defining* Luna
  caption face.
- **Everything else (menus, buttons, labels, dialog/body text) → Tahoma**
  (MS Sans Serif in legacy fallbacks).
- Luna does **not** use Franklin Gothic, Verdana, Georgia, Inter, or any
  `ui-monospace`/SF font. (Verdana appears in *our* stacks only as the
  macOS-native stand-in for Tahoma — see below.)

### Other canonical traits

- Title bars round their **top two corners only** (~3px); everything else is
  squared with 1px 3D bevels.
- **Close button is red**; minimize/maximize are theme-colored (blue).
- Buttons are **raised** 3D (light top-left, dark bottom-right). Text fields and
  wells are **sunken** (the inverse).
- Three Luna schemes exist — Blue (default), Olive Green ("Homestead"), Silver
  ("Metallic"). **We use Blue only.** Don't introduce the others.

*Sources: [Windows XP visual styles (Wikipedia)](https://en.wikipedia.org/wiki/Windows_XP_visual_styles),
the [XP system-colours reference](https://gist.github.com/zaxbux/64b5a88e2e390fb8f8d24eb1736f71e0),
[Luna (BetaWiki)](https://betawiki.net/wiki/Luna).*

---

## Typography (the site's canonical stacks)

Use these three, and **only** these three. They're defined as tokens
(`--font-caption`, `--font-ui`, `--font-mono`).

| Token | Stack | Used for |
|---|---|---|
| `--font-caption` | `"Trebuchet MS", Verdana, Geneva, sans-serif` | title bars, headings (`h1`–`h3`) |
| `--font-ui` | `Tahoma, Verdana, Geneva, sans-serif` | body, controls, labels, tooltips |
| `--font-mono` | `"Courier New", Courier, monospace` | numerics, EXIF readouts, `/source`, code |

**Why this order (native availability):** Tahoma is the canonical UI font but is
**not reliably installed on macOS**, so the UI stack falls through to **Verdana**
(which *is* macOS-native and metrically close) — that's the intended render on
the author's machine, and Tahoma proper on Windows. Trebuchet MS *is* present on
macOS, so captions render Trebuchet on both. Every stack ends in a generic so it
never face-plants onto Arial/Helvetica.

**Normalization decisions (apply during the consistency pass):**
- The ~15 headings that lead with **`Franklin Gothic Medium`** are **drift** —
  Franklin Gothic is not a Luna face and isn't macOS-native (it silently renders
  as Trebuchet on the author's mac anyway). **Collapse them to `--font-caption`.**
- The one **`ui-monospace, "SF Mono", …`** stack is non-period. **Collapse to
  `--font-mono`.**
- Body stacks currently vary (`Tahoma, Verdana, Geneva` / `Tahoma, Verdana` /
  `Tahoma, "Microsoft Sans Serif", Verdana` / `Verdana, Tahoma, …`). **Unify to
  `--font-ui`.** Drop the stray `"Microsoft Sans Serif"` (Windows-only, adds
  nothing on mac).
- `"Georgia", "Times New Roman", serif` — only keep if a specific element is
  *intentionally* a serif pull-quote; otherwise remove. Luna is sans throughout.

---

## Bevels — the 3D rule

XP's whole look is 1px 3D bevels. Two directions, never mix them up:

- **Raised (buttons, the title-bar window frame, raised chrome):** highlight on
  the **top-left**, shadow on the **bottom-right**. → `--bevel-raised`
- **Sunken (text inputs, wells, the histogram band, group-box insets):** the
  **inverse** — shadow top-left, highlight bottom-right. → `--bevel-sunken`

A "depressed/active button" swaps to sunken while held. Selected slot buttons
(e.g. the coffee picker) depress **and** tint blue.

---

## Title-bar anatomy

```
┌─────────────────────────────────────────────┐  ← top corners ~3px rounded
│ [icon] Title text (Trebuchet, white)   _ □ × │  ← --luna-title-grad, boxed controls
├─────────────────────────────────────────────┤  ← raised frame bevel
│ .content … (Tahoma/Verdana on #fff/#ece9d8)  │
└─────────────────────────────────────────────┘
```

- Background: `--luna-title-grad` (vertical, vivid blue). Text: `--luna-title-text` (`#fff`).
- Controls `_ □ ×` are small **boxed** glyphs; the close (`×`) tints **red** on
  hover, the others tint a lighter blue.
- The whole window is a **raised** card on a `--luna-face` (`#ece9d8`) workspace.

---

## DON'T (the modernization guardrails)

- ❌ `border-radius` > 3px on anything, and **>0 on buttons/inputs/cards**. Only
  the title-bar *top* corners round (~3px). No pills (`11px`), no circles (`50%`).
- ❌ Modern shadows — no large soft/blurred drop shadows, no colored glows. 3D
  depth comes from the **1px bevels**, not `box-shadow: 0 8px 24px …`. (A small
  flat drop shadow under a floating tooltip/popover is fine.)
- ❌ Non-period fonts: no Inter, system-ui, SF Pro/Mono, `ui-monospace`, Segoe,
  Helvetica/Arial as a *named* choice.
- ❌ Flat-design / single-flat-color fills where Luna uses a gradient (title
  bars, buttons, the taskbar idiom). And vice-versa — don't gradient a flat well.
- ❌ Smooth modern easing / long transitions. XP is instant or near-instant.
- ❌ The Olive Green or Silver schemes. Blue only.

## DO

- ✅ Pull every color/font/bevel from `tokens.css`; don't re-hardcode literals.
- ✅ Keep CSS **inline per page** (CSP + the one-request perf design) — tokens
  get inlined into each page's `:root`, not loaded as an external sheet.
- ✅ Reuse the `.title-bar` / `.window` / `.content` / `.xp-tooltip` vocabulary.
- ✅ Saturated, vivid, slightly-plasticky is correct. Luna was never subtle.

---

## Per-surface notes

- **Homepage (`src/pages/index.html`)** — the canonical reference. When two
  surfaces disagree, the homepage's Luna usually wins (then promote it to a token).
- **Garage (`public/garage/*`)** — deliberate **development mules**: testbeds
  for ideas. They share the chrome (title-bar caption buttons, 720px width) but
  are *allowed* to be experimental inside. Don't homogenize their content; do
  keep their chrome on-token.
- **Serendipity (`serendipity/serendipity.js`)** — an embedded route module in
  the same site Worker, with its own HTML/CSS policy; it **mirrors** these
  tokens by hand (keep in sync).
  Known drift to fix: `border-radius: 11px` / `50%` → squared (or ≤3px).
- **Coffee/cal (`cal/src/templates.js`)** — XP reskin; cleanest of the bunch,
  use it as a secondary reference. Mirrors tokens by hand like serendipity.
