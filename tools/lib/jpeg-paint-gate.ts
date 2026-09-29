// jpeg-paint-gate.ts — where Chromium's first paint of a progressive JPEG lands.
//
// Chromium draws nothing from a progressive JPEG until Y, Cb and Cr have each
// begun a scan, and the gate is exact to the byte: the first entropy-coded byte of
// the scan that completes the component set (measured in Chromium 152, see the
// "Chrome paints nothing until every channel has started" section of
// /garage/encoding). So the gate is readable from marker headers alone, without
// decoding anything, and from a PREFIX of the file: parsing stops the moment the
// set completes, which is what lets `archive:gate` sweep 258 archives of ~20 MB
// each by fetching 3 MB apiece.
//
// Pure: bytes in, verdict out. No I/O, so the contract suite can pin it against
// the committed /garage/enc fixtures whose gates that page quotes.

export type PaintGate = {
  /** 0xc0 baseline, 0xc2 progressive, and so on; null before any SOF was seen */
  sof: number | null;
  components: number;
  /** offset of the first entropy byte of the scan that starts the last channel; null if the prefix ran out first */
  gate: number | null;
  /** one entry per scan header read, "<component ids>:<Ss>-<Se>" */
  scans: string[];
};

const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

export function paintGate(b: Uint8Array): PaintGate {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a JPEG: no SOI");
  const out: PaintGate = { sof: null, components: 0, gate: null, scans: [] };
  const ids: number[] = [];
  const started = new Set<number>();
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error(`lost marker sync at byte ${i}`);
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }  // fill byte
    const len = (b[i + 2] << 8) | b[i + 3];
    if (i + 2 + len > b.length) return out;  // header cut off by the prefix
    if (isSof(m)) {
      out.sof = m;
      out.components = b[i + 9];
      for (let k = 0; k < out.components; k++) ids.push(b[i + 10 + k * 3]);
    }
    if (m === 0xda) {
      const ns = b[i + 4];
      const inScan: number[] = [];
      for (let k = 0; k < ns; k++) { inScan.push(b[i + 5 + k * 2]); started.add(b[i + 5 + k * 2]); }
      const p = i + 5 + ns * 2;
      out.scans.push(`${inScan.join(",")}:${b[p]}-${b[p + 1]}`);
      const data = i + 2 + len;
      if (ids.length && ids.every((c) => started.has(c))) { out.gate = data; return out; }
      // Skip entropy-coded data: a 0xff there is followed by a stuffed 0x00 or
      // an RSTn, and any other marker ends the scan.
      let j = data;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) return out;
      i = j;
      continue;
    }
    i += 2 + len;
  }
  return out;
}

/** The scan-order family a gate belongs to, for grouping a sweep. */
export function gateClass(g: PaintGate): string {
  if (g.components === 1) return "grayscale";
  if (g.sof === 0xc0 || g.sof === 0xc1) return "baseline";
  if (g.gate === null) return "colour, no paint within the prefix";
  return g.scans[0]?.includes(",") ? "colour, interleaved DC" : "colour, separate DC";
}
