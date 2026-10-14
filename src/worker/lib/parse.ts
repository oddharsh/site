// The boundary parse layer.

export function asText(value: unknown): string | null;
export function asText<F>(value: unknown, fallback: F): string | F;
export function asText(value: unknown, fallback: unknown = null): unknown {
	return typeof value === "string" && value !== "" ? value : fallback;
}

export function asNumber(value: unknown): number | null;
export function asNumber<F>(value: unknown, fallback: F): number | F;
export function asNumber(value: unknown, fallback: unknown = null): unknown {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
	(value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);

export const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asScalarText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
};

export const isCallable = (value: unknown): boolean => typeof value === "function";
