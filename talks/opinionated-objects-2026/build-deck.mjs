// SCREENGRABS ARE SCRIPTED NOW, and the .pptx still is not.
//
// `screengrabs/` used to be hand-taken, which is why swapping the Reader
// extractor left slide 5 embedding a screenshot that read "Defuddle content
// recovery" beside a score row that read Readability. `capture-screengrabs.mjs`
// retakes them from production and refuses to write a frame that is stale,
// duplicated, or captured while the Browser Run budget is spent.
//
// Retaken 2026-08-14 against the live site: 02 and 03 now show
// "03 Readability content recovery" and a settled 100/100 composite. 01 was
// deliberately LEFT at its original bytes, because it names no extractor (its
// tab reads "Reader's guess") and re-capturing it would have cost a degraded
// Browser Run pane after four iterations exhausted the daily render budget.
//
// STILL STALE: `lens-demo-day-backup.pptx` and `rendered/*.png`, because this
// script needs `@oai/artifact-tool` and only the Codex environment bundles it
// (set LENS_ARTIFACT_TOOL_PATH to run it elsewhere). Rebuild there, then the
// deck and the screengrabs finally agree.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Codex bundles the package; other environments can install it or point this
// variable at its ESM entrypoint without baking a workstation path into source.
const artifactToolSpecifier = process.env.LENS_ARTIFACT_TOOL_PATH || "@oai/artifact-tool";
const { Presentation, PresentationFile } = await import(artifactToolSpecifier);

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "lens-demo-day-backup.pptx");
const overview = await fs.readFile(path.join(here, "screengrabs", "01-lens-overview.png"));
const composite = await fs.readFile(path.join(here, "screengrabs", "03-three-source-evidence.png"));

const deck = Presentation.create({ slideSize: { width: 1280, height: 720 } });

const C = {
  ink: "#181818",
  muted: "#5A5A5A",
  paper: "#FFFFFF",
  panel: "#ECE9D8",
  face: "#ECE9D8",
  faceLight: "#F1EFE2",
  highlight: "#FFFFFF",
  shadow: "#ACA899",
  darkShadow: "#716F64",
  line: "#7F9DB9",
  blue: "#0054E3",
  blueBright: "#3D95FF",
  blueDark: "#003399",
  blueDeep: "#001EA0",
  bluePale: "#E7F0FF",
  teal: "#087C8C",
  tealPale: "#DFF5F5",
  green: "#24713C",
  greenBright: "#3C9A36",
  greenPale: "#E9F7EB",
  sky: "#6DA6E3",
  horizon: "#D9EDF7",
  grass: "#55A947",
  close: "#E45F3E",
};

function addText(slide, value, frame, style = {}) {
  const box = slide.shapes.add({ geometry: "textbox", position: frame });
  box.text.set(value);
  const inferredTypeface = (style.fontSize || 24) >= 35 ? "Trebuchet MS" : "Tahoma";
  const inferredColor = (style.fontSize || 24) >= 35 ? C.blueDark : C.ink;
  box.text.style = {
    typeface: inferredTypeface,
    fontSize: 24,
    color: inferredColor,
    lineSpacing: 1.08,
    ...style,
  };
  box.text.verticalAlignment = style.verticalAlignment || "top";
  return box;
}

// `line: null` draws a borderless rect and `radius` names a rounding token, so
// both are nullable. Left to the defaults they infer `string` and `null`
// respectively, which is backwards from how every bevel helper below calls this.
//
// JSDoc rather than a TypeScript annotation because this is a .mjs file, where
// an annotation is a syntax error (TS8010). The rule is the exact inverse of the
// .ts side of this repo, where JSDoc types are ignored instead.
/**
 * @param {string | null} [line]
 * @param {string | null} [radius]
 */
function addRect(slide, frame, fill, line = C.line, radius = null) {
  return slide.shapes.add({
    geometry: radius ? "roundRect" : "rect",
    position: frame,
    fill,
    borderRadius: radius || undefined,
    line: { style: "solid", width: line ? 1 : 0, fill: line || fill },
  });
}

function addRaised(slide, frame, fill = C.face) {
  addRect(slide, frame, fill, C.darkShadow, null);
  addRect(slide, { left: frame.left + 1, top: frame.top + 1, width: frame.width - 2, height: 1 }, C.highlight, null, null);
  addRect(slide, { left: frame.left + 1, top: frame.top + 1, width: 1, height: frame.height - 2 }, C.highlight, null, null);
  addRect(slide, { left: frame.left + 1, top: frame.top + frame.height - 2, width: frame.width - 2, height: 1 }, C.shadow, null, null);
  addRect(slide, { left: frame.left + frame.width - 2, top: frame.top + 1, width: 1, height: frame.height - 2 }, C.shadow, null, null);
}

function addSunken(slide, frame, fill = C.paper) {
  addRect(slide, frame, fill, C.highlight, null);
  addRect(slide, { left: frame.left, top: frame.top, width: frame.width, height: 1 }, C.darkShadow, null, null);
  addRect(slide, { left: frame.left, top: frame.top, width: 1, height: frame.height }, C.darkShadow, null, null);
  addRect(slide, { left: frame.left + 1, top: frame.top + 1, width: frame.width - 2, height: 1 }, C.shadow, null, null);
  addRect(slide, { left: frame.left + 1, top: frame.top + 1, width: 1, height: frame.height - 2 }, C.shadow, null, null);
  addRect(slide, { left: frame.left + 1, top: frame.top + frame.height - 2, width: frame.width - 2, height: 1 }, C.highlight, null, null);
  addRect(slide, { left: frame.left + frame.width - 2, top: frame.top + 1, width: 1, height: frame.height - 2 }, C.highlight, null, null);
}

function addCaptionButton(slide, left, glyph, close = false) {
  addRect(slide, { left, top: 18, width: 23, height: 21 }, close ? C.close : "#3E73F5", close ? "#AE3110" : "#1045BE", "rounded-sm");
  addRect(slide, { left: left + 2, top: 20, width: 19, height: 4 }, close ? "#E8795F" : "#6C9BFF", null, "rounded-sm");
  addText(slide, glyph, { left, top: close ? 17 : 18, width: 23, height: 20 }, {
    fontSize: close ? 16 : 14,
    bold: true,
    alignment: "center",
    color: C.highlight,
    typeface: "Tahoma",
  });
}

function addChrome(slide, number, label = "The Other Web") {
  // Bliss desktop: the deck itself becomes one maximized Luna window.
  addRect(slide, { left: 0, top: 0, width: 1280, height: 420 }, C.sky, null, null);
  addRect(slide, { left: 0, top: 420, width: 1280, height: 120 }, C.horizon, null, null);
  addRect(slide, { left: 0, top: 540, width: 1280, height: 180 }, C.grass, null, null);

  // Hard drop, blue frame, white client area.
  addRect(slide, { left: 24, top: 14, width: 1242, height: 670 }, "#315C91", null, "rounded-md");
  addRect(slide, { left: 16, top: 8, width: 1244, height: 674 }, C.blueDeep, C.blueDeep, "rounded-md");
  addRect(slide, { left: 19, top: 11, width: 1238, height: 668 }, C.paper, C.blueBright, "rounded-sm");

  // Five-stop Luna caption, approximated with crisp editable bands.
  addRect(slide, { left: 21, top: 13, width: 1234, height: 34 }, C.blue, null, "rounded-sm");
  addRect(slide, { left: 23, top: 15, width: 1230, height: 5 }, C.blueBright, null, "rounded-sm");
  addRect(slide, { left: 23, top: 20, width: 1230, height: 5 }, "#176AEE", null, null);
  addRect(slide, { left: 23, top: 42, width: 1230, height: 3 }, "#2E7CF2", null, null);

  addRect(slide, { left: 21, top: 47, width: 1234, height: 30 }, C.face, C.shadow, null);
  addSunken(slide, { left: 100, top: 52, width: 1065, height: 20 }, C.paper);
  addText(slide, "Address", { left: 33, top: 55, width: 62, height: 16 }, {
    fontSize: 11,
    color: C.muted,
  });
  addRect(slide, { left: 108, top: 56, width: 12, height: 12 }, C.blueBright, C.blue, "rounded-sm");
  addText(slide, `aadhar.sh  ›  lens  ›  slides  ›  ${String(number).padStart(2, "0")}`, { left: 126, top: 54, width: 1018, height: 17 }, {
    fontSize: 11,
    bold: true,
    color: C.blueDark,
  });
  addRaised(slide, { left: 1172, top: 51, width: 70, height: 22 }, C.faceLight);
  addText(slide, "Go", { left: 1172, top: 54, width: 70, height: 17 }, {
    fontSize: 11,
    alignment: "center",
  });

  // Client area remains flat and readable; the chrome carries the period bit.
  addRect(slide, { left: 22, top: 77, width: 1232, height: 599 }, C.paper, null, null);

  addRect(slide, { left: 29, top: 21, width: 16, height: 16 }, "#F09A33", "#8F4E10", null);
  addRect(slide, { left: 32, top: 24, width: 10, height: 10 }, "#FFE29A", null, null);
  addText(slide, label === "THE OTHER WEB" ? "The Other Web — Lens Demo Day" : label, { left: 52, top: 20, width: 920, height: 22 }, {
    fontSize: 15,
    bold: true,
    color: C.highlight,
    typeface: "Trebuchet MS",
  });
  addCaptionButton(slide, 1174, "—");
  addCaptionButton(slide, 1200, "□");
  addCaptionButton(slide, 1226, "×", true);

  // XP taskbar and active Lens task. It stays behind all content at y=688+.
  addRect(slide, { left: 0, top: 688, width: 1280, height: 32 }, "#245EDC", null, null);
  addRect(slide, { left: 0, top: 688, width: 1280, height: 2 }, "#6EA4F3", null, null);
  addRect(slide, { left: 0, top: 690, width: 110, height: 30 }, "#3C9A36", "#1C6E2A", "rounded-md");
  addText(slide, "start", { left: 24, top: 694, width: 72, height: 20 }, {
    fontSize: 15,
    bold: true,
    italic: true,
    color: C.highlight,
    typeface: "Trebuchet MS",
  });
  addRect(slide, { left: 118, top: 692, width: 174, height: 25 }, "#3F7DE5", "#174EBA", "rounded-sm");
  addText(slide, "▣  lens — demo", { left: 130, top: 696, width: 150, height: 17 }, {
    fontSize: 11,
    bold: true,
    color: C.highlight,
  });
  addText(slide, `${String(number).padStart(2, "0")} / 07`, { left: 1180, top: 696, width: 76, height: 17 }, {
    fontSize: 11,
    alignment: "right",
    color: C.highlight,
  });
}

function setNotes(slide, lines, sources = []) {
  const note = [
    ...lines,
    "",
    "[Sources]",
    ...sources.map((source) => `- ${source}`),
  ].join("\n");
  slide.speakerNotes.textFrame.setText(note);
  slide.speakerNotes.setVisible(true);
}

function addImageFrame(slide, bytes, frame, alt, fit = "contain") {
  addSunken(slide, { left: frame.left - 7, top: frame.top - 7, width: frame.width + 14, height: frame.height + 14 }, C.face);
  addRect(slide, { left: frame.left - 3, top: frame.top - 3, width: frame.width + 6, height: frame.height + 6 }, C.paper, C.line, null);
  return slide.images.add({
    blob: bytes,
    contentType: "image/png",
    alt,
    fit,
    position: frame,
    geometry: "rect",
  });
}

// 1 — Thesis
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 1, "OPINIONATED OBJECTS · AADHAR.SH/LENS");
  addText(slide, "Every page has\ntwo audiences.", { left: 60, top: 130, width: 820, height: 210 }, {
    fontSize: 68,
    bold: true,
    lineSpacing: 0.95,
  });
  addRect(slide, { left: 60, top: 390, width: 1160, height: 1 }, C.ink, null, null);
  addText(slide, "the person looking at it", { left: 60, top: 420, width: 470, height: 46 }, {
    fontSize: 28,
    color: C.blueDark,
  });
  addText(slide, "the machine reading over their shoulder", { left: 590, top: 420, width: 610, height: 72 }, {
    fontSize: 28,
    color: C.teal,
  });
  addText(slide, "Lens makes the disagreement visible.", { left: 60, top: 575, width: 800, height: 55 }, {
    fontSize: 30,
    bold: true,
  });
  addText(slide, "6 MINUTES · LIVE + OFFLINE BACKUP", { left: 840, top: 590, width: 360, height: 24 }, {
    fontSize: 12,
    alignment: "right",
    color: C.muted,
    characterSpacing: 1.5,
  });
  setNotes(slide, [
    "0:00–0:35",
    "Open with the claim, then make it concrete: a page is simultaneously a visual object and a machine-readable object.",
    "Lens is an opinionated object because it takes a side: machine access should be explicit, inspectable, and attributable.",
  ], ["https://aadhar.sh/lens"]);
}

// 2 — Audience site request
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 2);
  addText(slide, "Give me a website.", { left: 60, top: 100, width: 920, height: 105 }, {
    fontSize: 62,
    bold: true,
  });
  addText(slide, "One you actually use.", { left: 64, top: 205, width: 800, height: 52 }, {
    fontSize: 28,
    color: C.muted,
  });
  addSunken(slide, { left: 60, top: 300, width: 1160, height: 88 }, C.paper);
  addText(slide, "https://", { left: 90, top: 326, width: 140, height: 35 }, {
    fontSize: 25,
    color: C.muted,
    typeface: "Courier New",
  });
  addText(slide, "your answer goes here", { left: 225, top: 326, width: 780, height: 35 }, {
    fontSize: 25,
    typeface: "Courier New",
  });
  addRaised(slide, { left: 1050, top: 315, width: 140, height: 58 }, C.faceLight);
  addText(slide, "GO", { left: 1050, top: 330, width: 140, height: 28 }, {
    fontSize: 22,
    bold: true,
    alignment: "center",
    color: C.ink,
  });
  const chips = ["a local publication", "a favorite blog", "a useful tool"];
  chips.forEach((chip, index) => {
    const left = 60 + index * 310;
    addRaised(slide, { left, top: 430, width: 280, height: 54 }, C.face);
    addText(slide, chip, { left: left + 16, top: 446, width: 248, height: 24 }, {
      fontSize: 17,
      alignment: "center",
      color: C.blueDark,
    });
  });
  addText(slide, "If it refuses us, that is part of the measurement.", { left: 60, top: 560, width: 980, height: 48 }, {
    fontSize: 30,
    bold: true,
  });
  addText(slide, "BACKUPS: aadhar.sh · stripe.com · en.wikipedia.org/wiki/Semantic_Web", { left: 60, top: 640, width: 1120, height: 22 }, {
    fontSize: 12,
    color: C.muted,
    typeface: "Courier New",
  });
  setNotes(slide, [
    "0:35–1:05",
    "Ask for exactly one site. Repeat the URL aloud while entering it.",
    "Do not apologize if it blocks framing, bots, or rendering. Say: refusal is evidence too.",
    "If the room stalls, use aadhar.sh. If network or live execution fails, continue to the next slide without explaining the machinery.",
  ], ["https://aadhar.sh/lens"]);
}

// 3 — Three readers screenshot
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 3);
  addText(slide, "One URL. Three readers.", { left: 60, top: 82, width: 760, height: 62 }, {
    fontSize: 42,
    bold: true,
  });
  addText(slide, "human page  ·  HTTP response  ·  rendered browser", { left: 60, top: 140, width: 960, height: 32 }, {
    fontSize: 20,
    color: C.muted,
    typeface: "Courier New",
  });
  addImageFrame(slide, overview, { left: 60, top: 190, width: 1160, height: 472 }, "Lens comparing the human page, HTTP machine view, and Browser Run result for aadhar.sh", "cover");
  setNotes(slide, [
    "1:05–2:10",
    "This is the live-demo backup frame. Point left to right: what a person sees, what an identified HTTP client receives, and what survives after JavaScript runs.",
    "Ask the audience to predict whether the machine version is smaller, cleaner, or more permissive before revealing the panes.",
    "The point is not that one renderer is correct. The disagreement is the object.",
  ], ["https://aadhar.sh/lens"]);
}

// 4 — Past / present / future
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 4);
  addText(slide, "The web keeps changing its answer\nto “what is this page for?”", { left: 60, top: 86, width: 1050, height: 120 }, {
    fontSize: 43,
    bold: true,
    lineSpacing: 1.0,
  });
  const cards = [
    {
      n: "01",
      title: "PAST",
      claim: "describe meaning",
      body: "semantic HTML\nRDF + linked data\nmicroformats",
      fill: C.bluePale,
      color: C.blueDark,
    },
    {
      n: "02",
      title: "PRESENT",
      claim: "scrape presentation",
      body: "HTML + JavaScript\nrobots + terms\nexpensive cleanup",
      fill: C.panel,
      color: C.ink,
    },
    {
      n: "03",
      title: "FUTURE",
      claim: "negotiate action",
      body: "tools + permissions\nauth + payment\nintent + provenance",
      fill: C.tealPale,
      color: C.teal,
    },
  ];
  cards.forEach((card, index) => {
    const left = 60 + index * 395;
    addSunken(slide, { left, top: 250, width: 365, height: 360 }, card.fill);
    addRaised(slide, { left: left + 12, top: 304, width: 341, height: 48 }, C.faceLight);
    addText(slide, card.n, { left: left + 24, top: 274, width: 50, height: 22 }, {
      fontSize: 13,
      bold: true,
      color: card.color,
    });
    addText(slide, card.title, { left: left + 24, top: 318, width: 310, height: 28 }, {
      fontSize: 17,
      bold: true,
      color: card.color,
      characterSpacing: 1.5,
    });
    addText(slide, card.claim, { left: left + 24, top: 365, width: 310, height: 72 }, {
      fontSize: 31,
      bold: true,
      lineSpacing: 1.0,
    });
    addText(slide, card.body, { left: left + 24, top: 470, width: 310, height: 110 }, {
      fontSize: 21,
      color: C.muted,
      lineSpacing: 1.25,
    });
  });
  setNotes(slide, [
    "2:10–3:00",
    "The early semantic-web wager was that publishers could describe meaning in machine-readable form.",
    "The current agent web often recovers meaning after the fact from interfaces built for eyes.",
    "The future question is more demanding: what may a machine do, for whom, under which terms, and with what proof?",
  ], ["https://www.w3.org/2001/sw/", "https://blog.cloudflare.com/agent-readiness/"]);
}

// 5 — Aggregate score screenshot
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 5);
  addText(slide, "A useful score must expose its opinion.", { left: 60, top: 82, width: 940, height: 62 }, {
    fontSize: 42,
    bold: true,
  });
  addText(slide, "No hidden reweighting. No single vendor as oracle.", { left: 60, top: 142, width: 940, height: 32 }, {
    fontSize: 20,
    color: C.muted,
  });
  addImageFrame(slide, composite, { left: 60, top: 195, width: 700, height: 450 }, "Lens composite score with Cloudflare, Lens field evidence, and Readability recovery", "cover");
  addSunken(slide, { left: 800, top: 200, width: 380, height: 160 }, C.face);
  addText(slide, "100", { left: 830, top: 215, width: 310, height: 110 }, {
    fontSize: 86,
    bold: true,
    color: C.blueDark,
    alignment: "center",
  });
  addText(slide, "COMPOSITE AGENT ACCESS", { left: 830, top: 318, width: 310, height: 28 }, {
    fontSize: 14,
    bold: true,
    alignment: "center",
    color: C.muted,
    characterSpacing: 1.1,
  });
  const scoreRows = [
    ["Cloudflare standards", "100"],
    ["Lens field evidence", "100"],
    ["Readability recovery", "100"],
  ];
  scoreRows.forEach(([label, value], index) => {
    const top = 380 + index * 58;
    addSunken(slide, { left: 810, top, width: 360, height: 46 }, index === 2 ? C.tealPale : C.bluePale);
    addText(slide, label, { left: 826, top: top + 13, width: 250, height: 20 }, { fontSize: 16, bold: true });
    addText(slide, value, { left: 1090, top: top + 10, width: 62, height: 24 }, { fontSize: 20, bold: true, alignment: "right", color: C.green });
  });
  addText(slide, "equal thirds  ·  missing input = unfinished", { left: 810, top: 575, width: 360, height: 38 }, {
    fontSize: 16,
    alignment: "center",
    color: C.muted,
    typeface: "Courier New",
  });
  setNotes(slide, [
    "3:00–4:15",
    "This is the criticism-preemption slide. The Cloudflare score is one input, not the product.",
    "Lens adds an observed field score, and Readability provides an independent extraction whose output Lens evaluates with four published binary checks.",
    "Each source gets exactly one third. If any source fails, the result says unfinished instead of silently moving the goalposts.",
  ], [
    "https://blog.cloudflare.com/agent-readiness/",
    "https://isitagentready.com/",
    "https://github.com/mozilla/readability",
    "https://aadhar.sh/lens",
  ]);
}

// 6 — Distinct value
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 6);
  addText(slide, "Not a wrapper.\nA disagreement detector.", { left: 60, top: 90, width: 660, height: 150 }, {
    fontSize: 48,
    bold: true,
    lineSpacing: 0.98,
  });
  const rows = [
    ["STANDARDS", "Did the publisher declare machine interfaces?", C.bluePale, C.blueDark],
    ["BEHAVIOR", "What happened when identified bots actually tried?", C.panel, C.ink],
    ["RECOVERY", "Did the response resolve into useful content?", C.tealPale, C.teal],
  ];
  rows.forEach(([label, question, fill, color], index) => {
    const top = 275 + index * 106;
    addSunken(slide, { left: 60, top, width: 1160, height: 84 }, fill);
    addRaised(slide, { left: 72, top: top + 10, width: 180, height: 64 }, C.faceLight);
    addText(slide, label, { left: 84, top: top + 18, width: 170, height: 26 }, {
      fontSize: 15,
      bold: true,
      color,
      characterSpacing: 1.5,
    });
    addText(slide, question, { left: 270, top: top + 16, width: 890, height: 50 }, {
      fontSize: 26,
      bold: true,
    });
  });
  addText(slide, "The score is the compact view. The evidence remains inspectable.", { left: 60, top: 635, width: 1110, height: 30 }, {
    fontSize: 22,
    bold: true,
  });
  setNotes(slide, [
    "4:15–5:10",
    "Cloudflare measures declared readiness. Lens measures observed behavior. Readability gives us a separate content-recovery result.",
    "A disagreement is more interesting than a perfect score: it tells the publisher where standards, enforcement, and actual legibility diverge.",
    "The aggregate is a summary. Every component remains visible and falsifiable below it.",
  ], [
    "https://blog.cloudflare.com/agent-readiness/",
    "https://github.com/mozilla/readability",
    "https://aadhar.sh/lens",
  ]);
}

// 7 — Close
{
  const slide = deck.slides.add();
  slide.background.fill = C.paper;
  addChrome(slide, 7, "THE OTHER WEB · AADHAR.SH/LENS");
  addText(slide, "Machine legibility\nis a design choice.", { left: 60, top: 135, width: 1040, height: 170 }, {
    fontSize: 64,
    bold: true,
    lineSpacing: 0.96,
  });
  addText(slide, "What view does your object express—\nand who is allowed to act on it?", { left: 60, top: 370, width: 880, height: 105 }, {
    fontSize: 34,
    color: C.muted,
    lineSpacing: 1.1,
  });
  addSunken(slide, { left: 60, top: 565, width: 960, height: 72 }, C.paper);
  addText(slide, "https://aadhar.sh/lens", { left: 90, top: 584, width: 890, height: 34 }, {
    fontSize: 30,
    bold: true,
    color: C.blueDark,
    alignment: "left",
    typeface: "Courier New",
  });
  addRaised(slide, { left: 1040, top: 565, width: 180, height: 72 }, C.faceLight);
  addText(slide, "Open", { left: 1040, top: 585, width: 180, height: 30 }, {
    fontSize: 22,
    bold: true,
    alignment: "center",
    color: C.ink,
  });
  setNotes(slide, [
    "5:10–6:00",
    "Return to the event prompt: this object expresses a view from somewhere. It believes access should be explicit, evidence-backed, and legible to both sides.",
    "Invite questions about the score, the fetch identity, refusal as evidence, or what publishers might expose next.",
    "If the live site failed, end here without apology: the static proof has already shown the interaction and the result.",
  ], ["https://aadhar.sh/lens"]);
}

const file = await PresentationFile.exportPptx(deck);
await file.save(out);
await fs.rm(`${out}.inspect.ndjson`, { force: true });
console.log(out);
