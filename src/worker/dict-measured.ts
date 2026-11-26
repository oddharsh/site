// The dcb vs dcz measurement, read from its one record, dict-measured.json.
//
// Three places quote it: the MEASURED rows in dict.ts, the figures table on
// /garage/compression, and that page's prose and quiz. On 2026-11-26 all three
// still said zstd decodes 8.3x faster, four months after a matched re-measure
// put it at 2.0x, because each copy had been typed by hand (PR 1877). Now
// tools/measure-dict-encodings.ts writes the record, the table is rendered from
// it, and contract-dict-measured-matches-the-page fails when the prose or the
// quiz stops quoting it.
//
// Everything here is pure, with no import of the record itself, so the
// generator can load it before a record exists; dict.ts binds the record. It
// runs at module load in the Worker, so numbers are grouped by hand:
// toLocaleString would load ICU on a cold isolate.
import { asNumber, asRecord, asText } from "./lib/parse.ts";

export interface DictMeasured {
  measured: string;
  machine: string;
  decoders: { brotli: string; zstd: string };
  pairs: { total: number; shell: number; pages: number; rawBytes: number };
  size: {
    dcbBytes: number;
    dczBytes: number;
    dcbSmallerOn: number;
    widest: { file: string; dcbBytes: number; dczBytes: number };
  };
  decode: { dcbUs: number; dczUs: number };
  assumed: { linkMbps: number; phoneDecodeSlowdown: number };
}

function field(value: unknown, path: string): number {
  const n = asNumber(value);
  if (n === null || n < 0) throw new Error(`dict-measured.json: ${path} is not a non-negative number`);
  return n;
}

function text(value: unknown, path: string): string {
  const s = asText(value);
  if (s === null) throw new Error(`dict-measured.json: ${path} is not a string`);
  return s;
}

function object(value: unknown, path: string): Record<string, unknown> {
  const r = asRecord(value);
  if (r === null) throw new Error(`dict-measured.json: ${path} is not an object`);
  return r;
}

/** Parse the record once, at the boundary, and check what the figures rely on. */
export function parseDictMeasured(value: unknown): DictMeasured {
  const root = object(value, "record");
  const decoders = object(root.decoders, "decoders");
  const pairs = object(root.pairs, "pairs");
  const size = object(root.size, "size");
  const widest = object(size.widest, "size.widest");
  const decode = object(root.decode, "decode");
  const assumed = object(root.assumed, "assumed");
  const parsed: DictMeasured = {
    measured: text(root.measured, "measured"),
    machine: text(root.machine, "machine"),
    decoders: { brotli: text(decoders.brotli, "decoders.brotli"), zstd: text(decoders.zstd, "decoders.zstd") },
    pairs: {
      total: field(pairs.total, "pairs.total"),
      shell: field(pairs.shell, "pairs.shell"),
      pages: field(pairs.pages, "pairs.pages"),
      rawBytes: field(pairs.rawBytes, "pairs.rawBytes"),
    },
    size: {
      dcbBytes: field(size.dcbBytes, "size.dcbBytes"),
      dczBytes: field(size.dczBytes, "size.dczBytes"),
      dcbSmallerOn: field(size.dcbSmallerOn, "size.dcbSmallerOn"),
      widest: {
        file: text(widest.file, "size.widest.file"),
        dcbBytes: field(widest.dcbBytes, "size.widest.dcbBytes"),
        dczBytes: field(widest.dczBytes, "size.widest.dczBytes"),
      },
    },
    decode: { dcbUs: field(decode.dcbUs, "decode.dcbUs"), dczUs: field(decode.dczUs, "decode.dczUs") },
    assumed: {
      linkMbps: field(assumed.linkMbps, "assumed.linkMbps"),
      phoneDecodeSlowdown: field(assumed.phoneDecodeSlowdown, "assumed.phoneDecodeSlowdown"),
    },
  };
  // The figures below divide by these and compare them, so a record that breaks
  // them is a generator bug rather than a measurement.
  if (parsed.pairs.total === 0) throw new Error("dict-measured.json: no pairs");
  if (parsed.pairs.shell + parsed.pairs.pages !== parsed.pairs.total) throw new Error("dict-measured.json: shell + pages != total");
  if (parsed.size.dcbSmallerOn > parsed.pairs.total) throw new Error("dict-measured.json: dcbSmallerOn exceeds total");
  if (parsed.decode.dcbUs <= parsed.decode.dczUs) throw new Error("dict-measured.json: the figures assume dcb decodes slower");
  return parsed;
}

const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const MIB = 1024 * 1024;

/** Every figure a reader sees, formatted once. */
export function dictFacts(m: DictMeasured) {
  const savedBytes = (m.size.dczBytes - m.size.dcbBytes) / m.pairs.total;
  const extraDecodeUs = m.decode.dcbUs - m.decode.dczUs;
  const averageRawBytes = m.pairs.rawBytes / m.pairs.total;
  // Bits saved per response over the microseconds it costs gives bits per
  // microsecond, which is Mbps: below that link speed the smaller delta wins.
  const breakEvenMbps = (savedBytes * 8) / extraDecodeUs;
  return {
    pairs: `${m.pairs.total} deltas`,
    dcbSmaller: `${((1 - m.size.dcbBytes / m.size.dczBytes) * 100).toFixed(1)}%`,
    decodeRatio: `${(m.decode.dcbUs / m.decode.dczUs).toFixed(1)}x`,
    dcbUs: `${m.decode.dcbUs.toFixed(1)} µs`,
    dczUs: `${m.decode.dczUs.toFixed(1)} µs`,
    savedBytes: `${Math.round(savedBytes)} bytes`,
    extraDecodeUs: `${extraDecodeUs.toFixed(1)} µs`,
    breakEvenMbps: `${Math.round(breakEvenMbps)} Mbps`,
    phoneBreakEvenMbps: `${Math.round(breakEvenMbps / m.assumed.phoneDecodeSlowdown)} Mbps`,
    phoneSlowdown: `${m.assumed.phoneDecodeSlowdown}x`,
    dcbBytes: `${grouped(m.size.dcbBytes)} bytes`,
    dczBytes: `${grouped(m.size.dczBytes)} bytes`,
    widestFile: m.size.widest.file,
    widestDcb: `${grouped(m.size.widest.dcbBytes)} bytes`,
    widestDcz: `${grouped(m.size.widest.dczBytes)} bytes`,
    averageRaw: `${grouped(averageRawBytes)} B`,
    dcbMiBs: `${grouped(((averageRawBytes / m.decode.dcbUs) * 1e6) / MIB)} MiB/s`,
    dczMiBs: `${grouped(((averageRawBytes / m.decode.dczUs) * 1e6) / MIB)} MiB/s`,
  };
}

/** The /garage/compression figures table body, between its markers. */
export function renderDictTable(f: ReturnType<typeof dictFacts>): string {
  const deltas = `<a class="term" data-t="delta-encoding" href="https://en.wikipedia.org/wiki/Delta_encoding" title="Storing or sending only the differences between two versions of data, instead of the whole new version." rel="external">deltas</a>`;
  return [
    `        <tr><td>${f.pairs.replace("deltas", deltas)}, total</td><td class="y">${f.dcbBytes}</td><td>${f.dczBytes}</td></tr>`,
    `        <tr><td>widest single gap (${f.widestFile})</td><td class="y">${f.widestDcb}</td><td>${f.widestDcz}</td></tr>`,
    `        <tr><td>decode, average ${f.averageRaw} rebuilt</td><td>${f.dcbUs}</td><td class="y">${f.dczUs}</td></tr>`,
    `        <tr><td>throughput</td><td>${f.dcbMiBs}</td><td class="y">${f.dczMiBs}</td></tr>`,
  ].join("\n");
}

export const TABLE_START = "<!-- dict-measured:table, written by tools/measure-dict-encodings.ts -->";
export const TABLE_END = "<!-- /dict-measured:table -->";
