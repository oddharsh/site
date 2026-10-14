// av2-decode.js: an AV2 still decoder for /garage/av2 and /pixel-peeper's AV2
// tiles, run as a module Worker.
//
// No browser decodes AV2, so the page hands this worker an AVIF file whose
// image item is av02 and gets RGBA back. The decoder is AOM's own reference,
// AVM 1.0.0, compiled to WebAssembly by tools/photos/av2-wasm/build.sh, which
// also says how it was checked: decoded planes are bit-exact against native
// avifdec, and RGBA matches avifdec's full-depth decode to within 1.
//
// This file does two jobs the WebAssembly can't: it reads the container
// (ISOBMFF boxes, to find the item's bytes and its colr signalling) and it
// stands in for the five functions the module imports, all of which are
// stdio and memory plumbing a still decode never really needs.
//
// The worker's response carries its own Content-Security-Policy with
// 'wasm-unsafe-eval' (public/_headers). A dedicated worker enforces the policy
// on its own script, never the page's, so the page itself keeps the strict
// hashed policy every other document has. Measured in Chrome 152, 2026-10-13.
//
// Protocol: post {id, buf}; receive {id, width, height, rgba, depth,
// subsampling, decodeMs} with rgba's ArrayBuffer transferred, or {id, error}.

// The decoder, content-addressed by the first 8 hex of its sha256.
const WASM_URL = "/garage/av2/av2dec.90fc76df.wasm";

// Find the primary item's bytes and colour signalling in an ISOBMFF file.
function parseAvif(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  const str = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const boxes = (start, end) => {
    const out = [];
    for (let o = start; o + 8 <= end; ) {
      let size = dv.getUint32(o), hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
      if (size === 0) size = end - o;
      if (size < hdr || o + size > end) throw new Error("malformed box at byte " + o);
      out.push({ type: str(o + 4), d: o + hdr, e: o + size });
      o += size;
    }
    return out;
  };
  const meta = boxes(0, b.length).find((x) => x.type === "meta");
  if (!meta) throw new Error("not an AVIF file: no meta box");
  const kids = boxes(meta.d + 4, meta.e), get = (t) => kids.find((k) => k.type === t);
  const pitm = get("pitm"), iinf = get("iinf"), iloc = get("iloc");
  if (!pitm || !iinf || !iloc) throw new Error("not an AVIF file: no primary item");
  const primary = b[pitm.d] === 0 ? dv.getUint16(pitm.d + 4) : dv.getUint32(pitm.d + 4);

  let type = "";
  for (const e of boxes(iinf.d + 4 + (b[iinf.d] === 0 ? 2 : 4), iinf.e)) {
    const wide = b[e.d] >= 3, id = wide ? dv.getUint32(e.d + 4) : dv.getUint16(e.d + 4);
    if (id === primary) type = str(e.d + 4 + (wide ? 4 : 2) + 2);
  }
  if (type !== "av02") throw new Error(`the image item is ${type || "missing"}, not av02 (AV2)`);

  // iloc: the primary item's extents, concatenated.
  let o = iloc.d;
  const v = b[o];
  o += 4;
  const os = b[o] >> 4, ls = b[o] & 15, bs = b[o + 1] >> 4, is = v >= 1 ? b[o + 1] & 15 : 0;
  o += 2;
  const rd = (n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + b[o++]; return x; };
  const parts = [];
  for (let i = 0, count = v < 2 ? rd(2) : rd(4); i < count; i++) {
    const id = v < 2 ? rd(2) : rd(4);
    if (v >= 1) rd(2);
    rd(2);
    const base = rd(bs);
    for (let j = 0, n = rd(2); j < n; j++) {
      if (v >= 1 && is) rd(is);
      const off = rd(os), len = rd(ls);
      if (id === primary) parts.push(b.subarray(base + off, base + off + len));
    }
  }
  const data = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);

  // colr nclx, when present. A single-image file has one, so the property
  // association table isn't needed to pick it.
  /** @type {number | null} */
  let matrix = null;
  /** @type {boolean | null} */
  let fullRange = null;
  const iprp = get("iprp"), ipco = iprp && boxes(iprp.d, iprp.e).find((x) => x.type === "ipco");
  for (const p of ipco ? boxes(ipco.d, ipco.e) : []) {
    if (p.type === "colr" && str(p.d) === "nclx") {
      matrix = dv.getUint16(p.d + 8);
      fullRange = (b[p.d + 10] & 0x80) !== 0;
    }
  }
  return { data, matrix, fullRange };
}

/**
 * The module's exports, by name (the C surface is tools/photos/av2-wasm/av2dec.c).
 * @typedef {{ memory: WebAssembly.Memory, _initialize(): void, malloc(n: number): number, free(p: number): void,
 *   av2_decode(p: number, n: number): number, av2_rgba(mc: number, full: number): number,
 *   av2_plane(i: number): number, av2_stride(i: number): number } & Record<"av2_width" | "av2_height" | "av2_depth"
 *   | "av2_x_shift" | "av2_y_shift" | "av2_monochrome" | "av2_highbd" | "av2_matrix" | "av2_full_range", () => number>} Av2Exports
 */

/** @type {Promise<{ x: Av2Exports, stderr: () => string }> | undefined} */
let decoder;
/** @param {string | BufferSource} wasm the module's URL, or its bytes (the contract test passes bytes) */
function load(wasm = WASM_URL) {
  decoder ??= (async () => {
    /** @type {WebAssembly.Memory} */
    let memory;
    let stderr = "";
    const imports = {
      env: { emscripten_notify_memory_growth() {} },
      wasi_snapshot_preview1: {
        /** @param {number} code */
        proc_exit(code) { throw new Error("decoder exited with " + code); },
        fd_close: () => 0,
        fd_seek: () => 70,
        // stderr carries the decoder's error text; keep it for the message
        /** @param {number} _fd @param {number} iov @param {number} iovcnt @param {number} nwritten */
        fd_write(_fd, iov, iovcnt, nwritten) {
          const dv = new DataView(memory.buffer), u8 = new Uint8Array(memory.buffer);
          let n = 0;
          for (let i = 0; i < iovcnt; i++) {
            const p = dv.getUint32(iov + i * 8, true), len = dv.getUint32(iov + i * 8 + 4, true);
            stderr = (stderr + new TextDecoder().decode(u8.subarray(p, p + len))).slice(-500);
            n += len;
          }
          dv.setUint32(nwritten, n, true);
          return 0;
        },
      },
    };
    const { instance } = ArrayBuffer.isView(wasm) || wasm instanceof ArrayBuffer
      ? await WebAssembly.instantiate(wasm, imports)
      : await WebAssembly.instantiateStreaming(fetch(wasm), imports);
    const x = /** @type {Av2Exports} */ (/** @type {unknown} */ (instance.exports));
    memory = x.memory;
    x._initialize();
    return { x, stderr: () => stderr };
  })();
  return decoder;
}

// `planes: true` also returns the decoder's own Y, U and V samples (2 bytes
// each above 8-bit), which is what the contract test compares with native AVM.
/**
 * @param {ArrayBuffer} buf an AVIF file whose image item is av02
 * @param {{ wasm?: string | BufferSource, planes?: boolean }} [opts]
 */
export async function decode(buf, { wasm = WASM_URL, planes = false } = {}) {
  const item = parseAvif(buf);
  const { x, stderr } = await load(wasm);
  const t0 = performance.now();
  const p = x.malloc(item.data.length);
  new Uint8Array(x.memory.buffer).set(item.data, p);
  const err = x.av2_decode(p, item.data.length);
  x.free(p);
  if (err) throw new Error(`AV2 decode failed (${err}) ${stderr()}`.trim());
  const decodeMs = performance.now() - t0;
  const w = x.av2_width(), h = x.av2_height();
  const mc = item.matrix ?? x.av2_matrix();
  const full = item.fullRange ?? x.av2_full_range() === 1;
  const px = x.av2_rgba(mc, full ? 1 : 0);
  // memory.buffer can be replaced by growth inside av2_rgba, so read it after
  const rgba = new Uint8Array(x.memory.buffer, px, w * h * 4).slice().buffer;
  const sx = x.av2_x_shift(), sy = x.av2_y_shift();
  const sub = ["4:4:4", "4:2:2", "", "4:2:0"][sx + 2 * sy];
  /** @type {{ width: number, height: number, rgba: ArrayBuffer, depth: number, subsampling: string, decodeMs: number, planes?: Uint8Array[] }} */
  const out = { width: w, height: h, rgba, depth: x.av2_depth(), subsampling: x.av2_monochrome() ? "4:0:0" : sub, decodeMs };
  if (planes) {
    // AVM holds 8-bit content in 16-bit buffers too; narrow those to one byte a
    // sample, the layout avifdec writes, so a comparison reads like for like.
    const hbd = x.av2_highbd(), narrow = hbd && out.depth === 8, u8 = new Uint8Array(x.memory.buffer);
    const bps = hbd && !narrow ? 2 : 1, n = x.av2_monochrome() ? 1 : 3;
    out.planes = Array.from({ length: n }, (_, i) => {
      const pw = i ? (w + sx) >> sx : w, ph = i ? (h + sy) >> sy : h;
      const base = x.av2_plane(i), stride = x.av2_stride(i), plane = new Uint8Array(pw * ph * bps);
      for (let y = 0; y < ph; y++) {
        const row = u8.subarray(base + y * stride, base + y * stride + pw * (hbd ? 2 : 1));
        if (narrow) for (let k = 0; k < pw; k++) plane[y * pw + k] = row[2 * k];
        else plane.set(row, y * pw * bps);
      }
      return plane;
    });
  }
  return out;
}

// Only inside a worker. The contract suite imports this file under bun and
// node, where self is undefined (node) or an onmessage handler holds the event
// loop open so the process never exits (bun, measured 2026-10-13).
if ("WorkerGlobalScope" in globalThis) {
  /** @type {{ onmessage: ((e: MessageEvent<{ id: number, buf: ArrayBuffer }>) => void) | null, postMessage(msg: unknown, transfer?: Transferable[]): void }} */
  const scope = /** @type {any} */ (globalThis);
  scope.onmessage = ({ data: { id, buf } }) => {
    decode(buf).then(
      (r) => scope.postMessage({ id, ...r }, [r.rgba]),
      (e) => scope.postMessage({ id, error: String(e instanceof Error ? e.message : e) }),
    );
  };
}
