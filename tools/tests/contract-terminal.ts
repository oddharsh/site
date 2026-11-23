// contract-terminal.ts: stub assets and a request helper for the terminal
// programs, apart from contract-shared.ts because terminalGet calls the
// Worker's terminal.ts. Only the tests that drive a terminal program load it.

import { handleTool } from "../../src/worker/terminal.ts";
import { context, staticAssets } from "./contract-shared.ts";

const TERMINAL_ASSETS = {
  "/writing/posts.json": [
    { slug: "one", title: "The first note", date: "2026-01-02" },
    { slug: "two", title: "The second note", date: "2026-02-03" },
    { slug: "three", title: "The third note", date: "2026-03-04" },
  ],
  "/images/metadata.json": {
    A_1: {
      camera: "FUJIFILM X-T50",
      lens: "XF27mmF2.8",
      film: "Classic Chrome",
      date: "2026:01:02",
      iso: 640,
      recipe: { "Film Simulation": "Classic Chrome", "Dynamic Range": "DR400" },
    },
    A_2: { camera: "FUJIFILM X-T50", lens: "XF23mmF1.4", film: "Acros", date: "2025:05:06" },
    A_3: { camera: "LEICA M11", lens: "Summicron 35", film: "", date: "2025:07:08" },
  },
  "/images/alt.json": { A_1: "A quiet corner", A_2: "Rain on glass", A_3: "A doorway" },
  "/images/hashes.json": { A_1: { a: "1a1a1a1a", j: "2b2b2b2b", s: "3c3c3c3c" }, A_2: {}, A_3: {} },
  "/search-index.json": { records: [{ url: "/writing/one", title: "The first note", description: "d", text: "lattice", kind: "writing" }] },
};

const terminalEnv = () => ({ ASSETS: staticAssets(TERMINAL_ASSETS) });

const terminalReq = (path) => new Request(`https://aadhar.sh${path}`);

const terminalGet = (path) => handleTool(terminalReq(path), terminalEnv(), context());

export { TERMINAL_ASSETS, terminalEnv, terminalGet, terminalReq };
