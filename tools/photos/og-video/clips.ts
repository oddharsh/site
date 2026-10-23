// clips.ts: one record per og:video preview. `setup` runs before recording, so
// frame 0 is the still card's state; `steps` is the recorded timeline, and
// each one ends where it started so the clip loops. Selectors in `hero`/`span`
// are CSS (the recorder scrolls with querySelector); steps take Playwright's.
export type Step = {
  do: string;
  sel?: string;
  value?: string;
  ms?: number;
  from?: number;
  to?: number;
  delay?: number;
  fn?: any;
  arg?: any;
  rx?: number;
  ry?: number;
  dx?: number;
  dy?: number;
  steps?: number;
};
export type Clip = {
  id: string;
  path: string;
  section?: string;
  fav?: string;
  hero: string[];
  span?: [string, string];
  maxH?: number;
  pad?: { top?: number; right?: number; bottom?: number; left?: number };
  seed?: number;
  experimental?: boolean;
  viewport?: { width: number; height: number };
  settle?: number;
  setup?: Step[];
  steps: Step[];
  tail?: number;
  maxMs?: number;
  // A clip that ships: bake.ts writes public/og/video/<card>.hevc.mp4 and
  // <card>.av1.webm at these knobs, the cheapest compare.ts found reaching
  // SSIMULACRA2 80 (VideoToolbox quality 0..1, aomenc cq-level).
  ship?: { card: string; hevc: number; av1: number };
};

const wait = (ms: number): Step => ({ do: "wait", ms });
const imgsReady = (sel: string, min = 1): Step => ({
  do: "waitFor",
  fn: ([sel, min]) => {
    const im = [...document.querySelectorAll(sel)] as HTMLImageElement[];
    return im.length >= min && im.slice(0, Math.max(min, 1)).every((i) => i.complete && i.naturalWidth > 0);
  },
  arg: [sel, min],
});

// The encoding loupe, walked up the quality ladder on one spot of the photo.
// Card order is the grid's nth: JPEG q62, q84, q95, AVIF q40, q63, q85, PNG.
const encCard = (n: number) => `.enc-grid >> nth=0 >> .enc-card img >> nth=${n - 1}`;
const encSweep = [3, 4, 5, 8, 9, 10, 1].flatMap((n): Step[] => [
  { do: "mouseTo", sel: encCard(n), rx: 0.55, ry: 0.5 },
  { do: "mouseTo", sel: encCard(n), rx: 0.6, ry: 0.55, steps: 15 },
  wait(420),
]);

const peep = (n: number) => `.tile img >> nth=${n}`;
const balloon = (n: number): Step[] => [
  { do: "mouseTo", sel: `#balloon-row li:nth-child(${n})`, rx: 0.15, ry: 0.5, steps: 8 },
  { do: "mouseTo", sel: `#balloon-row li:nth-child(${n})`, rx: 0.15, ry: 0.5, dx: 60, steps: 20 },
  wait(500),
  { do: "mouseTo", sel: "#balloon-row", rx: 0.3, ry: 1, dy: 40, steps: 6 },
  wait(400),
];

export const CLIPS: Clip[] = [
  {
    id: "encoding-loupe",
    path: "/garage/encoding",
    ship: { card: "garage-encoding", hevc: 0.75, av1: 42 },
    section: "garage",
    hero: [".enc-grid"],
    pad: { top: 110, left: 92, right: 92, bottom: 16 },
    setup: [{ do: "scroll", sel: ".enc-grid" }, imgsReady(".enc-grid .enc-card img", 11)],
    steps: [...encSweep, { do: "mouseTo", sel: ".enc-grid", rx: 0.5, ry: 0, dy: -100, steps: 4 }, wait(300)],
  },
  {
    id: "pixel-peeper-ab",
    path: "/pixel-peeper",
    seed: 7,
    hero: [".gb"],
    span: [".row.spread", ".gb"],
    setup: [
      { do: "click", sel: "#go" },
      {
        do: "waitFor",
        ms: 40000,
        fn: () => {
          const im = [...document.querySelectorAll(".tile img")] as HTMLImageElement[];
          return im.length >= 2 && im.every((i) => i.complete && i.naturalWidth > 0) && !/decoding/i.test(document.querySelector(".hint")?.textContent ?? "");
        },
      },
    ],
    steps: [
      wait(400),
      ...[0, 1, 0, 1, 0, 1].flatMap((n): Step[] => [{ do: "mouseTo", sel: peep(n), rx: 0.4, ry: 0.45 }, wait(650)]),
      { do: "unhover" },
      wait(300),
    ],
  },
  {
    id: "av2-flip",
    path: "/garage/av2",
    section: "garage",
    hero: ["#fig-1"],
    setup: [{ do: "scroll", sel: "#fig-1" }, imgsReady("#fig-1 img", 2)],
    steps: [wait(500), ...Array.from({ length: 6 }, (): Step[] => [{ do: "click", sel: "#fig-1 .av2-stack" }, wait(700)]).flat()],
  },
  {
    id: "masonry-reflow",
    path: "/garage/masonry",
    section: "garage",
    experimental: true,
    seed: 3,
    hero: ["#sheet"],
    maxH: 450,
    setup: [
      imgsReady("#sheet .tile img", 12),
      { do: "eval", fn: () => ((document.querySelector("#sheet") as HTMLElement).style.maxWidth = "740px") },
      wait(400),
    ],
    steps: [740, 600, 450, 600, 740].flatMap((w): Step[] => [
      { do: "eval", fn: (w) => ((document.querySelector("#sheet") as HTMLElement).style.maxWidth = `${w}px`), arg: w },
      wait(900),
    ]),
  },
  {
    id: "tooltips-balloon",
    path: "/garage/tooltips",
    section: "garage",
    hero: ["#balloon-row"],
    pad: { top: 20, left: 20, right: 250, bottom: 110 },
    setup: [{ do: "scroll", sel: "#balloon-row" }],
    steps: [...balloon(1), ...balloon(2), ...balloon(3)],
  },
  {
    id: "vigenere-k1",
    path: "/lwe/vigenere",
    section: "lwe",
    hero: ["#demo-crank"],
    steps: [
      wait(400),
      { do: "fill", sel: "#cr-in", value: "" },
      wait(300),
      { do: "type", sel: "#cr-in", value: "EMUFPHZLRFAXYUSDJKZLDKRNSHGNFIVJ", delay: 110 },
      wait(1200),
    ],
  },
  {
    id: "utf8-bytes",
    path: "/lwe/utf8",
    section: "lwe",
    hero: ["#demo-anat"],
    setup: [{ do: "click", sel: '[data-anat="A"]' }, wait(300)],
    steps: [wait(600), ...["é", "中", "😀", "A"].flatMap((ch): Step[] => [{ do: "click", sel: `[data-anat="${ch}"]` }, wait(1100)])],
  },
  {
    id: "utf8-typing",
    path: "/lwe/utf8",
    section: "lwe",
    hero: ["#demo-enc"],
    steps: [wait(400), { do: "fill", sel: "#enc-input", value: "" }, wait(300), { do: "type", sel: "#enc-input", value: "A é 中 😀", delay: 450 }, wait(1500)],
  },
  {
    id: "dotfiles-script",
    path: "/dotfiles",
    hero: [".sheet:has(#df-list)"],
    span: [".sheet:has(#df-list)", ".sheet:has(#df-out)"],
    maxH: 600,
    steps: [
      wait(400),
      { do: "click", sel: "#df-none" },
      wait(500),
      ...[0, 1, 2, 3, 4].flatMap((n): Step[] => [{ do: "click", sel: `#df-list .df-row >> nth=${n}` }, wait(450)]),
      wait(700),
      { do: "click", sel: "#df-all" },
      wait(600),
    ],
  },
];
