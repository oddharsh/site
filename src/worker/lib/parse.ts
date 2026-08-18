// The boundary parse layer.
//
// Everything this Worker reads from outside itself arrives as `any`: a Spotify
// embed's JSON, a KV entry written by an older deploy, a foreign MCP server's
// tools/list, a CDP frame, an RDAP record, a D1 row. Before this module those
// values were checked with `typeof` at each USE site, which meant the same
// question ("is this actually a string?") was asked in a dozen places and
// answered slightly differently in each.
//
// The rule that forced this is anti-slop/no-runtime-typeof, and its argument is
// the right one: parse input where it enters, then branch on a value you can
// trust. This repo declares ZERO runtime dependencies and the Worker bundle
// sits on a 204.24 KiB baseline, so a schema library was not the way to get
// there. These are the primitives instead, and they are deliberately dull.
//
// The rule is OFF for this file alone, in .oxlintrc.json. That is not a
// loophole: a hand-rolled parser is made of `typeof` by construction, so the
// only thing the rule can buy here is that the checks live in ONE named place
// rather than scattered across the call sites. Suppressing it anywhere else
// gives up the thing this file exists to provide.

/** A non-empty string, or `fallback`. An empty string is not a value. */
export const asText = (value, fallback = null) =>
	(typeof value === "string" && value !== "" ? value : fallback);

/** A finite number, or `fallback`. NaN and Infinity are not numbers here. */
export const asNumber = (value, fallback = null) =>
	(typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A plain object, or null. Arrays are NOT records: `{}` and `[]` both answer
 *  "object" to typeof, and every caller here means the first one. */
export const asRecord = (value) =>
	(value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);

/** An array, or an empty one, so callers can map without a guard. */
export const asList = (value) => (Array.isArray(value) ? value : []);

/** A boolean, or `fallback`. Deliberately does NOT coerce: a missing flag and
 *  a false one are different answers at a boundary. */
export const asBool = (value, fallback = null) =>
	(typeof value === "boolean" ? value : fallback);

/** Is this callable? The binding-shaped question rather than the data-shaped
 *  one: `env.BROWSER.quickAction`, `ctx.waitUntil`, a rate limiter's `limit`.
 *  There is no wire format to parse, only a platform that either handed us the
 *  method or did not, so this is the honest floor for that whole class. */
/**
 * A value going into text a human or an agent will read: a URL parameter, a
 * tooltip line, a frame cell. Primitives keep their exact spelling; anything
 * else is JSON rather than "[object Object]", which is what plain String()
 * produces and what three sites shipped until TypeScript pointed at them.
 *
 * The three were reading values this Worker does not own: EXIF recipe cards
 * parsed from JSON, and MCP tool arguments, which arrive from a stranger.
 */
export const asScalarText = (value) => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
};

export const isCallable = (value) => typeof value === "function";
