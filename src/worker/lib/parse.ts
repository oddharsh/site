export const asText = (value, fallback = null) =>
	(typeof value === "string" && value !== "" ? value : fallback);

export const asNumber = (value, fallback = null) =>
	(typeof value === "number" && Number.isFinite(value) ? value : fallback);

export const asRecord = (value) =>
	(value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);

export const asList = (value) => (Array.isArray(value) ? value : []);

export const asScalarText = (value) => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
};

export const isCallable = (value) => typeof value === "function";
