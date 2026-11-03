export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function compactDate(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new Error(`날짜는 YYYY-MM-DD 또는 YYYYMMDD 형식이어야 합니다: ${value}`);
  }
  return digits;
}

export function displayDate(value) {
  const date = compactDate(value);
  return `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}.`;
}

export function stableId(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `n-${hash.toString(16).padStart(8, "0")}`;
}

export function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

export function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function jsonReplacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
