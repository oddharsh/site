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
  block?: string[];
  // A scene file instead of a site page (scenes/), recorded at card size and
  // laid over the whole card rather than floated on Bliss.
  url?: string;
  fullBleed?: boolean;
  clockFromSteps?: boolean;
  hypercam?: boolean;
  viewport?: { width: number; height: number };
  settle?: number;
  setup?: Step[];
  steps: Step[];
  tail?: number;
  maxMs?: number;
  // A clip that ships: bake.ts writes public/og/video/<card>.hevc.mp4 and
  // <card>.av1.webm at these knobs, the cheapest compare.ts found reaching
  // SSIMULACRA2 80 unless the clip says otherwise (VideoToolbox quality 0..1,
  // aomenc cq-level).
  // poster: also write frame 0 as public/og/<card>.jpg, the page's og:image,
  // so the still a fetcher shows before playing is the clip's own first frame.
  ship?: { card: string; hevc: number; av1: number; poster?: boolean };
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

// The homepage's hover demos (src/client/tooltip.ts). Each prewarms its
// hovers in setup, so the recorded pass shows loaded images rather than a
// tooltip frame waiting on the network.
const homePhoto = (n: number) => `.photos a >> nth=${n}`;
const car = (n: number) => `.car-link >> nth=${n}`;
const track = (n: number) => `#np-list li[data-track-title] >> nth=${n}`;
// `ry` is where on the target the pointer rests: the photo tooltip is about
// 330px tall and hangs below the cursor, so photos are toured near their top.
const hoverTour = (sel: (n: number) => string, ns: number[], dwell: number, ry = 0.45): Step[] =>
  ns.flatMap((n): Step[] => [
    { do: "mouseTo", sel: sel(n), rx: 0.35, ry, steps: 10 },
    { do: "mouseTo", sel: sel(n), rx: 0.6, ry: ry + 0.1, steps: 14 },
    wait(dwell),
  ]);
const prewarm = (sel: (n: number) => string, ns: number[]): Step[] => [
  ...ns.flatMap((n): Step[] => [{ do: "mouseTo", sel: sel(n), steps: 2 }, wait(700)]),
  { do: "unhover" },
  wait(400),
];

const scene = (name: string) => new URL(`./scenes/${name}.html`, import.meta.url).href;
const play: Step[] = [{ do: "eval", fn: () => document.body.classList.add("go") }];

export const CLIPS: Clip[] = [
  {
    // Loops on the boot screen alone (the owner's call, 2026-10-23): no card,
    // no desktop. maxMs is exactly three 1.5 s sweeps, so frame 135 is frame 0.
    id: "home-boot",
    path: "/",
    url: scene("boot"),
    hero: ["#scene"],
    viewport: { width: 1200, height: 630 },
    fullBleed: true,
    hypercam: false,
    steps: [...play, wait(4700)],
    clockFromSteps: true,
    tail: 0,
    maxMs: 4500,
    // at SSIMULACRA2 88 rather than 80: mostly black, so near-ceiling costs 32 KB and 11 KB
    ship: { card: "home", hevc: 0.63, av1: 50, poster: true },
  },
  {
    id: "home-bsod",
    path: "/",
    url: scene("bsod"),
    hero: ["#scene"],
    viewport: { width: 1200, height: 630 },
    fullBleed: true,
    hypercam: false,
    steps: [wait(200), ...play, wait(6600)],
    tail: 0,
  },
  {
    id: "home-photos",
    path: "/",
    block: ["**/hit*"],
    hero: [".photos"],
    pad: { top: 8, left: 8, right: 8, bottom: 8 },
    maxH: 600,
    settle: 2000,
    setup: [{ do: "scroll", sel: ".photos" }, imgsReady(".photos a img", 12), ...prewarm(homePhoto, [0, 1, 3, 4])],
    steps: [wait(300), ...hoverTour(homePhoto, [0, 1, 4, 3], 900, 0.18), { do: "unhover" }, wait(400)],
  },
  {
    id: "home-cars",
    path: "/",
    block: ["**/hit*"],
    hero: ["p:has(.car-link)"],
    pad: { top: 8, left: 8, right: 8, bottom: 230 },
    settle: 1500,
    setup: [{ do: "scroll", sel: "p:has(.car-link)" }, ...prewarm(car, [0, 1, 2, 3])],
    steps: [wait(300), ...hoverTour(car, [0, 1, 2, 3], 850), { do: "unhover" }, wait(400)],
  },
  {
    id: "home-tracks",
    path: "/",
    block: ["**/hit*"],
    hero: ["section.now-playing"],
    pad: { top: 8, left: 8, right: 8, bottom: 8 },
    maxH: 420,
    settle: 2000,
    setup: [
      { do: "scroll", sel: "section.now-playing" },
      { do: "waitFor", fn: () => document.querySelectorAll("#np-list li[data-track-title]").length >= 4, ms: 20000 },
      ...prewarm(track, [0, 1, 2, 3]),
    ],
    steps: [wait(300), ...hoverTour(track, [0, 1, 2, 3], 850), { do: "unhover" }, wait(400)],
  },
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
