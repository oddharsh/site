const entities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function numericEntity(entity: string): string | null {
  const body = entity.slice(2, -1);
  const hexadecimal = body[0]?.toLowerCase() === "x";
  const value = Number.parseInt(hexadecimal ? body.slice(1) : body, hexadecimal ? 16 : 10);
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return String.fromCodePoint(value);
}

/** Decode each recognized HTML character reference exactly once. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:amp|apos|gt|lt|nbsp|quot|#(?:x[0-9a-f]{1,6}|[0-9]{1,7}));/gi, (entity) => {
    if (entity[1] === "#") return numericEntity(entity) ?? entity;
    return entities[entity.slice(1, -1).toLowerCase()] ?? entity;
  });
}

export function cleanText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}
