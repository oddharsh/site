// family-trainer.ts — derives the page-family dictionary from the served pages.
//
// The dictionary is RAW bytes (RFC 9842), so zstd's own trainer output can't
// ship as-is, and its raw content tail was the weaker option anyway. Measured
// 2026-11-21 on the served-page series rebuilt from src/dict/p-dict history
// (137 rolls, 4,829 page versions). The score was held-out served bytes,
// min(frame + 40, q11), on pages 14 days after the cutoff. 25 cells: 5 cutoffs
// times 5 slug splits. Against the four-page concat this replaced:
//   zstd --train, raw tail                     -1.73% median, 20.1 KB br
//   zstd --train-cover=k=1024,d=8, raw tail    -1.67% median, 22.5 KB br
//   this file (8-byte strings, 1 KiB segments) -3.53% median, -1.43% worst,
//                                              25/25 past the noise band, 19.3 KB br
// The gain comes from weighting a string by how many PAGES contain it.
// COVER counts occurrences, so one long page's repeated body text scores like
// shell markup that every page shares. Segment order, 4 weeks of page history
// and swaps scored by real compressed size were all flat or worse. Repeating
// those steps is a waste of time; the table is in the PR that added this file.
//
// Deterministic for a given page list: no randomness, ties go to the earlier
// candidate in heap order, and the caller passes pages in a stable order.

const K = 8; // bytes per string; 6, 10, 12 and 16 all measured worse
const SEGMENT = 1024; // bytes per picked segment; 256, 512, 2 KiB and 4 KiB measured worse
const STRIDE = SEGMENT >> 2;

type Candidate = { page: number; at: number; score: number };

export function trainFamilyDictionary(pages: readonly Uint8Array[], size: number): Buffer {
  const ids = new Map<number, number>();
  const kmerIds = pages.map((page) => {
    const out = new Uint32Array(Math.max(0, page.length - K + 1));
    for (let i = 0; i < out.length; i++) {
      let h = 2166136261;
      for (let j = 0; j < K; j++) h = Math.imul(h ^ page[i + j], 16777619);
      h >>>= 0;
      let id = ids.get(h);
      if (id === undefined) {
        id = ids.size;
        ids.set(h, id);
      }
      out[i] = id;
    }
    return out;
  });

  // A string earns (pages containing it - 1): a string in one page helps no other page.
  const weight = new Float64Array(ids.size);
  const stamp = new Int32Array(ids.size).fill(-1);
  kmerIds.forEach((row, page) => {
    for (const id of row) {
      if (stamp[id] !== page) {
        stamp[id] = page;
        weight[id] += 1;
      }
    }
  });
  for (let i = 0; i < weight.length; i++) weight[i] = weight[i] >= 2 ? weight[i] - 1 : 0;

  const covered = new Uint8Array(ids.size);
  stamp.fill(-1);
  let generation = 0;
  const score = (c: Candidate) => {
    generation++;
    const row = kmerIds[c.page];
    const end = Math.min(c.at + SEGMENT - K + 1, row.length);
    let s = 0;
    for (let i = c.at; i < end; i++) {
      const id = row[i];
      if (covered[id] || stamp[id] === generation) continue;
      stamp[id] = generation;
      s += weight[id];
    }
    return s;
  };

  const candidates: Candidate[] = [];
  pages.forEach((page, index) => {
    for (let at = 0; at + SEGMENT <= page.length; at += STRIDE) candidates.push({ page: index, at, score: 0 });
  });
  for (const c of candidates) c.score = score(c);
  const heap = new MaxHeap(candidates);

  // Lazy greedy: a candidate's score only falls as coverage grows, so the top
  // is re-scored and either taken or pushed back down.
  const picked: Uint8Array[] = [];
  let total = 0;
  while (total < size && heap.size > 0) {
    const top = heap.peek();
    const fresh = score(top);
    if (fresh < top.score) {
      top.score = fresh;
      heap.siftDown(0);
      continue;
    }
    heap.pop();
    if (fresh <= 0) break;
    const row = kmerIds[top.page];
    const end = Math.min(top.at + SEGMENT - K + 1, row.length);
    for (let i = top.at; i < end; i++) covered[row[i]] = 1;
    picked.push(pages[top.page].subarray(top.at, top.at + SEGMENT));
    total += SEGMENT;
  }

  // The first pick sits at the window end, nearest the page being encoded.
  const out = Buffer.concat(picked.reverse());
  if (out.length >= size) return out.subarray(out.length - size);
  // Too few shared segments to fill the window: pad the front with page bytes,
  // so the dictionary always has the contract's size.
  const pad = Buffer.concat(pages).subarray(0, size - out.length);
  if (pad.length + out.length < size) {
    throw new Error(`page-family trainer: ${pages.length} pages hold ${pad.length + out.length} B, short of the ${size} B dictionary`);
  }
  return Buffer.concat([pad, out]);
}

class MaxHeap {
  items: Candidate[];
  constructor(items: Candidate[]) {
    this.items = items;
    for (let i = (items.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }
  get size() {
    return this.items.length;
  }
  peek() {
    return this.items[0];
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (last && this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }
  siftDown(start: number) {
    const a = this.items;
    let i = start;
    for (;;) {
      let max = i;
      const left = 2 * i + 1;
      const right = left + 1;
      if (left < a.length && a[left].score > a[max].score) max = left;
      if (right < a.length && a[right].score > a[max].score) max = right;
      if (max === i) return;
      [a[i], a[max]] = [a[max], a[i]];
      i = max;
    }
  }
}
