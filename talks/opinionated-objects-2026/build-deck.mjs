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
  ink: "#111318",
  muted: "#606878",
  paper: "#FAFBFD",
  panel: "#F0F3F8",
  line: "#C7CEDA",
  blue: "#2456D6",
  blueDark: "#163A9A",
  bluePale: "#E8F0FF",
  teal: "#0A788A",
  tealPale: "#E5F7F8",
  green: "#24713C",
  greenPale: "#E9F7EB",
};

function addText(slide, value, frame, style = {}) {
  const box = slide.shapes.add({ geometry: "textbox", position: frame });
  box.text.set(value);
  box.text.style = {
    typeface: "Helvetica Neue",
    fontSize: 24,
    color: C.ink,
    lineSpacing: 1.08,
    ...style,
  };
  box.text.verticalAlignment = style.verticalAlignment || "top";
  return box;
}

function addRect(slide, frame, fill, line = C.line, radius = "rounded-md") {
  return slide.shapes.add({
    geometry: radius ? "roundRect" : "rect",
    position: frame,
    fill,
    borderRadius: radius || undefined,
    line: { style: "solid", width: line ? 1 : 0, fill: line || fill },
  });
}

function addRule(slide, y, color = C.line) {
  addRect(slide, { left: 42, top: y, width: 1196, height: 2 }, color, null, null);
}

function addChrome(slide, number, label = "THE OTHER WEB") {
  addText(slide, label, { left: 42, top: 26, width: 700, height: 22 }, {
    fontSize: 13,
    bold: true,
    color: C.blueDark,
    characterSpacing: 2,
  });
  addText(slide, String(number).padStart(2, "0"), { left: 1180, top: 26, width: 58, height: 22 }, {
    fontSize: 13,
    alignment: "right",
    color: C.muted,
  });
  addRule(slide, 58, C.blue);
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
  addRect(slide, { left: frame.left - 6, top: frame.top - 6, width: frame.width + 12, height: frame.height + 12 }, "#FFFFFF", C.line, "rounded-md");
  return slide.images.add({
    blob: bytes,
    contentType: "image/png",
    alt,
    fit,
    position: frame,
    geometry: "roundRect",
    borderRadius: "rounded-sm",
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
  addRect(slide, { left: 60, top: 300, width: 1160, height: 88 }, "#FFFFFF", C.ink, "rounded-sm");
  addText(slide, "https://", { left: 90, top: 326, width: 140, height: 35 }, {
    fontSize: 25,
    color: C.muted,
    typeface: "Courier New",
  });
  addText(slide, "your answer goes here", { left: 225, top: 326, width: 780, height: 35 }, {
    fontSize: 25,
    typeface: "Courier New",
  });
  addRect(slide, { left: 1050, top: 315, width: 140, height: 58 }, C.blue, C.blueDark, "rounded-sm");
  addText(slide, "GO", { left: 1050, top: 330, width: 140, height: 28 }, {
    fontSize: 22,
    bold: true,
    alignment: "center",
    color: "#FFFFFF",
  });
  const chips = ["a local publication", "a favorite blog", "a useful tool"];
  chips.forEach((chip, index) => {
    const left = 60 + index * 310;
    addRect(slide, { left, top: 430, width: 280, height: 54 }, C.bluePale, C.line, "rounded-sm");
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
    addRect(slide, { left, top: 250, width: 365, height: 360 }, card.fill, C.line, "rounded-md");
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
  addImageFrame(slide, composite, { left: 60, top: 195, width: 700, height: 450 }, "Lens composite score with Cloudflare, Lens field evidence, and Defuddle recovery", "cover");
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
    ["Defuddle recovery", "100"],
  ];
  scoreRows.forEach(([label, value], index) => {
    const top = 380 + index * 58;
    addRect(slide, { left: 810, top, width: 360, height: 46 }, index === 2 ? C.tealPale : C.bluePale, C.line, "rounded-sm");
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
    "Lens adds an observed field score, and Defuddle provides an independent extraction whose output Lens evaluates with four published binary checks.",
    "Each source gets exactly one third. If any source fails, the result says unfinished instead of silently moving the goalposts.",
  ], [
    "https://blog.cloudflare.com/agent-readiness/",
    "https://isitagentready.com/",
    "https://github.com/kepano/defuddle",
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
    addRect(slide, { left: 60, top, width: 1160, height: 84 }, fill, C.line, "rounded-sm");
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
    "Cloudflare measures declared readiness. Lens measures observed behavior. Defuddle gives us a separate content-recovery result.",
    "A disagreement is more interesting than a perfect score: it tells the publisher where standards, enforcement, and actual legibility diverge.",
    "The aggregate is a summary. Every component remains visible and falsifiable below it.",
  ], [
    "https://blog.cloudflare.com/agent-readiness/",
    "https://github.com/kepano/defuddle",
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
  addRect(slide, { left: 60, top: 565, width: 1160, height: 72 }, C.blue, C.blueDark, "rounded-sm");
  addText(slide, "aadhar.sh/lens", { left: 90, top: 584, width: 1100, height: 34 }, {
    fontSize: 30,
    bold: true,
    color: "#FFFFFF",
    alignment: "center",
    typeface: "Courier New",
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
