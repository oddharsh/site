// Ephemeral image tools for the site MCP. Image bytes are accepted in the MCP
// request or fetched from one validated public URL, transformed through the
// Cloudflare Images binding, and returned inline. Nothing is written to the
// public photo bucket or the representation vault.
import photoIndex from "./photo-index.json" with { type: "json" };
import { CANONICAL_HOST } from "./lib/const.js";
import { validateLensTarget } from "./lens.js";

const INPUT_CAP = 8 * 1024 * 1024;
const OUTPUT_CAP = 4 * 1024 * 1024;
const TOTAL_COMPARE_CAP = 8 * 1024 * 1024;
const MIME_BY_FORMAT = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg" };
const PRESETS = {
  web: { width: 1600, format: "avif", quality: 82 },
  thumbnail: { width: 600, height: 600, fit: "cover", format: "avif", quality: 84 },
  universal: { width: 1600, format: "jpeg", quality: 84 },
  og: { width: 1200, height: 630, fit: "cover", format: "jpeg", quality: 82 },
};

const PHOTO_FIELDS = [
  "camera", "lens", "aperture", "shutter", "iso", "focal", "ev", "date",
  "width", "height", "color_space", "white_balance", "color_temp", "wb_shift",
  "exposure_mode", "meter", "focus_mode", "drive", "film", "dr", "dr_value",
  "chrome", "chrome_blue", "grain", "grain_size", "highlight_tone", "shadow_tone",
  "saturation", "recipe",
];

function error(message) { return { _error: String(message).slice(0, 400) }; }

function decodeBase64(value) {
  let raw = String(value || "").trim();
  let mime = "";
  const match = raw.match(/^data:([^;,]+);base64,(.*)$/is);
  if (match) { mime = match[1].toLowerCase(); raw = match[2]; }
  if (!raw || raw.length > Math.ceil(INPUT_CAP / 3) * 4 + 64 || !/^[A-Za-z0-9+/\s]+=*$/.test(raw)) return null;
  try {
    const binary = atob(raw.replace(/\s/g, ""));
    if (binary.length > INPUT_CAP) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  } catch { return null; }
}

async function readBytesCapped(response, maxBytes) {
  if (!response?.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= maxBytes ? { bytes, truncated: false } : { bytes: null, truncated: true };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total >= maxBytes) { truncated = true; break; }
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(value.subarray(0, take));
      total += take;
      if (take < value.byteLength) { truncated = true; break; }
    }
  } finally {
    if (truncated) { try { await reader.cancel(); } catch {} }
  }
  if (truncated) return { bytes: null, truncated: true };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated: false };
}

function base64(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(out);
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeFormat(value, fallback = "avif") {
  const format = String(value || fallback).toLowerCase().replace(/^image\//, "");
  return format === "jpg" ? "jpeg" : format;
}

function safeNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function transformOptions(args = {}) {
  const preset = PRESETS[args.preset] || {};
  const format = normalizeFormat(args.format || preset.format, "avif");
  if (!MIME_BY_FORMAT[format]) return { error: "format must be avif, webp, or jpeg" };
  const fit = args.fit || preset.fit;
  if (fit && !["cover", "contain", "crop", "scale-down", "pad", "squeeze"].includes(fit)) {
    return { error: "fit must be cover, contain, crop, scale-down, pad, or squeeze" };
  }
  const rotate = args.rotate === undefined ? undefined : safeNumber(args.rotate, 0, 360, 0);
  if (rotate !== undefined && ![0, 90, 180, 270].includes(rotate)) return { error: "rotate must be 0, 90, 180, or 270" };
  return {
    options: {
      width: safeNumber(args.width ?? preset.width, 1, 2400, undefined),
      height: safeNumber(args.height ?? preset.height, 1, 2400, undefined),
      fit,
      rotate,
    },
    output: { format: MIME_BY_FORMAT[format], quality: safeNumber(args.quality ?? preset.quality, 1, 100, 84) },
    preset: args.preset && PRESETS[args.preset] ? args.preset : null,
  };
}

async function resolveImageInput(args, env) {
  const encoded = decodeBase64(args.image_data);
  if (args.image_data !== undefined && !encoded) return { error: "image_data must be valid base64 and no larger than 8 MiB" };
  if (encoded) {
    const mime = String(args.mime_type || encoded.mime || "").toLowerCase().split(";")[0];
    if (mime && !mime.startsWith("image/")) return { error: "mime_type must be an image type" };
    return { bytes: encoded.bytes, mime: mime || "application/octet-stream", source: "image_data" };
  }
  const rawUrl = String(args.source_url || "").trim();
  if (!rawUrl) return { error: "provide image_data or source_url" };
  const target = validateLensTarget(rawUrl);
  if (!target.ok) return { error: target.error };
  try {
    const response = await fetch(target.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
    const final = validateLensTarget(response.url || target.url);
    if (!final.ok) return { error: "source_url redirected to a disallowed target" };
    const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!response.ok) return { error: `source_url returned HTTP ${response.status}` };
    if (type && !type.startsWith("image/")) return { error: "source_url did not return an image" };
    const body = await readBytesCapped(response, INPUT_CAP);
    if (body.truncated) return { error: "source_url response exceeds the 8 MiB input limit" };
    return { bytes: body.bytes, mime: type || "application/octet-stream", source: "source_url", url: final.url };
  } catch { return { error: "source_url could not be fetched" }; }
}

async function imageInfo(env, bytes) {
  if (!env.IMAGES?.info) return null;
  try { return await env.IMAGES.info(bytes); } catch { return null; }
}

async function transformBytes(env, bytes, spec) {
  if (!env.IMAGES?.input) return { error: "Image binding is not configured on this deployment." };
  try {
    let pipeline = env.IMAGES.input(bytes);
    const options = Object.fromEntries(Object.entries(spec.options).filter(([, value]) => value !== undefined));
    if (Object.keys(options).length) pipeline = pipeline.transform(options);
    const response = await pipeline.output(spec.output).response();
    if (!response?.ok) return { error: "Image binding could not encode the image." };
    const body = await readBytesCapped(response, OUTPUT_CAP);
    if (body.truncated) return { error: "transformed image exceeds the 4 MiB output limit" };
    return { bytes: body.bytes, mime: spec.output.format, quality: spec.output.quality };
  } catch { return { error: "Image binding could not transform the image." }; }
}

function imageReceipt(input, info, output) {
  return {
    input: { source: input.source, url: input.url || null, bytes: input.bytes.byteLength, mimeType: input.mime, sha256: input.sha256 },
    output: output ? { bytes: output.bytes.byteLength, mimeType: output.mime, sha256: output.sha256, quality: output.quality } : null,
    engine: "cloudflare-images",
    persistence: "ephemeral",
    info: info || null,
  };
}

function mcpOutput(receipt, images = []) {
  // MCP content is a union of block shapes; without the annotation the array
  // infers as text-only off its first element and refuses the image blocks.
  /** @type {({type: "text", text: string} | {type: "image", data: string, mimeType: string})[]} */
  const content = [{ type: "text", text: JSON.stringify(receipt, null, 2) }];
  for (const image of images) content.push({ type: "image", data: base64(image.bytes), mimeType: image.mime });
  return { _mcp: { structured: receipt, content } };
}

export async function imageInspect(args, env) {
  const input = await resolveImageInput(args, env);
  if (input.error) return error(input.error);
  input.sha256 = await sha256(input.bytes);
  const info = await imageInfo(env, input.bytes);
  if (!info) return error("Image binding is not configured on this deployment.");
  return { ...imageReceipt(input, info, null), operation: "inspect" };
}

export async function imageTransform(args, env) {
  const spec = transformOptions(args);
  if (spec.error) return error(spec.error);
  const input = await resolveImageInput(args, env);
  if (input.error) return error(input.error);
  input.sha256 = await sha256(input.bytes);
  const info = await imageInfo(env, input.bytes);
  if (!info) return error("Image binding is not configured on this deployment.");
  const output = await transformBytes(env, input.bytes, spec);
  if (output.error) return error(output.error);
  output.sha256 = await sha256(output.bytes);
  const receipt = { ...imageReceipt(input, info, output), operation: "transform", preset: spec.preset, transform: spec.options };
  return mcpOutput(receipt, [output]);
}

export async function imageCompare(args, env) {
  const input = await resolveImageInput(args, env);
  if (input.error) return error(input.error);
  const formats = Array.isArray(args.formats) && args.formats.length ? args.formats : ["avif", "webp", "jpeg"];
  if (formats.length > 3) return error("formats is limited to three variants");
  const normalized = formats.map((format) => normalizeFormat(format, "avif"));
  if (normalized.some((format) => !MIME_BY_FORMAT[format])) return error("formats must contain avif, webp, or jpeg");
  input.sha256 = await sha256(input.bytes);
  const info = await imageInfo(env, input.bytes);
  if (!info) return error("Image binding is not configured on this deployment.");
  const variants = [];
  let total = 0;
  for (const format of normalized) {
    const spec = transformOptions({ ...args, format });
    if (spec.error) return error(spec.error);
    const output = await transformBytes(env, input.bytes, spec);
    if (output.error) return error(output.error);
    output.sha256 = await sha256(output.bytes);
    total += output.bytes.byteLength;
    if (total > TOTAL_COMPARE_CAP) return error("combined comparison output exceeds the 8 MiB limit");
    variants.push({ ...output, format });
  }
  const receipt = {
    ...imageReceipt(input, info, null), operation: "compare", preset: args.preset || null,
    variants: variants.map(({ bytes, ...variant }) => variant),
    recommendation: variants.slice().sort((a, b) => a.bytes.byteLength - b.bytes.byteLength)[0]?.format || null,
    note: "Size is measured exactly; visual quality is not scored by this tool.",
  };
  return mcpOutput(receipt, variants);
}

async function loadJson(env, path, fallback = {}) {
  try {
    const response = await env.ASSETS.fetch(`https://assets.local/${path}`);
    return response.ok ? await response.json() : fallback;
  } catch { return fallback; }
}

function archiveStemFromUrl(rawUrl, hashes) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== CANONICAL_HOST) return null;
    const full = decodeURIComponent(url.pathname.replace(/^\/images\/full\//, ""));
    for (const [stem, entry] of Object.entries(photoIndex)) if (entry.full === full) return { stem, kind: "archive-url" };
    const match = url.pathname.match(/^\/i\/([A-Za-z0-9_-]+?)(-400)?\.([a-f0-9]{8})\.(avif|jpg)$/i);
    if (match && hashes[match[1]]) {
      const entry = hashes[match[1]];
      const tier = match[2] ? "s" : match[4].toLowerCase() === "jpg" ? "j" : "a";
      if ((tier === "j" && entry.j === match[3]) || (tier === "a" && entry.a === match[3]) || (tier === "s" && entry.s === match[3])) return { stem: match[1], kind: "archive-url", tier };
    }
  } catch {}
  return null;
}

function publicPhoto(record, stem, hashes, alt, kind, tier) {
  const metadata = Object.fromEntries(PHOTO_FIELDS.filter((key) => record?.[key] !== undefined).map((key) => [key, record[key]]));
  const hash = hashes?.[stem] || {};
  const index = photoIndex[stem];
  return {
    stem, matchKind: kind, matchedTier: tier || null,
    full: index?.full ? `/images/full/${encodeURIComponent(index.full).replace(/%2F/g, "/")}` : null,
    thumb: { avif: hash.a ? `/i/${stem}.${hash.a}.avif` : null, jpg: hash.j ? `/i/${stem}.${hash.j}.jpg` : null, small: hash.s ? `/i/${stem}-400.${hash.s}.avif` : null, xs: hash.x ? `/i/${stem}-200.${hash.x}.avif` : null },
    alt: String(alt?.[stem] || "").slice(0, 240), metadata,
  };
}

export async function photoRecipe(args, env) {
  const metadata = await loadJson(env, "images/metadata.json");
  const hashes = await loadJson(env, "images/hashes.json");
  const alt = await loadJson(env, "images/alt.json");
  const fingerprints = await loadJson(env, "images/fingerprints.json");
  let stem = String(args.stem || "").trim();
  let kind = stem ? "stem" : null;
  let tier = null;
  if (stem && !/^[A-Za-z0-9_-]{1,120}$/.test(stem)) return error("stem is not a published photo stem");
  if (!stem && args.source_url) {
    const match = archiveStemFromUrl(args.source_url, hashes);
    if (match) { stem = match.stem; kind = match.kind; tier = match.tier; }
  }
  if (args.image_data) {
    const encoded = decodeBase64(args.image_data);
    if (!encoded) return error("image_data must be valid base64 and no larger than 8 MiB");
    const digest = await sha256(encoded.bytes);
    // fingerprints.json is keyed BY DIGEST, so the parsed object IS the index and
    // this is the whole lookup. It used to be a nested scan over all 474 entries
    // with an Object.entries() allocation per call, which is the wrong shape for
    // a question that only ever runs digest -> photo.
    //
    // Object.hasOwn keeps a caller-derived key off the prototype chain. A digest
    // is our own sha256 output and so can never spell `constructor`, but leaning
    // on that would put the safety three lines from the lookup.
    //
    // Deliberately a plain object rather than a Map parsed at the loadJson
    // boundary: building a 474-entry Map costs ~0.072 ms, which is MORE than the
    // 0.0205 ms scan this replaces, so the boundary parse would spend the whole
    // win. JSON.parse already returns the index; the values are our own build
    // artifact, and check-photo-pipeline.mjs is what proves their shape.
    const hit = Object.hasOwn(fingerprints, digest) ? String(fingerprints[digest]) : "";
    const cut = hit.lastIndexOf(":");
    const hitStem = cut > 0 ? hit.slice(0, cut) : "";
    const hitTier = cut > 0 ? hit.slice(cut + 1) : "";
    if (!hitStem || !["a", "j", "s"].includes(hitTier)) return { matched: false, inputSha256: digest, reason: "No exact published thumbnail match. Arbitrary originals are not treated as recipe matches." };
    stem = hitStem; kind = "published-thumbnail"; tier = hitTier;
  }
  if (!stem || !metadata[stem]) return error("provide a published stem, archive URL, or exact bytes from a published thumbnail");
  return { matched: true, input: args.image_data ? { sha256: await sha256(decodeBase64(args.image_data).bytes) } : null, photo: publicPhoto(metadata[stem], stem, hashes, alt, kind, tier), note: "Recipe data is returned only after an explicit archive identity or exact published-thumbnail match." };
}
