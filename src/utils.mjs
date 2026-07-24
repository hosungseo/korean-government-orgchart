import fs from "node:fs/promises";
import path from "node:path";

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

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

export async function writeText(filePath, text) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, text, "utf8");
}

export function parseArgs(argv) {
  const args = { _: [], input: [], law: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) index += 1;
    if (key === "input" || key === "law") {
      args[key].push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

export async function readInputs(paths) {
  if (!paths?.length) {
    throw new Error("하나 이상의 --input 경로가 필요합니다.");
  }
  const chunks = [];
  for (const inputPath of paths) {
    if (inputPath === "-") {
      chunks.push(await readStdin());
    } else {
      chunks.push(await fs.readFile(path.resolve(inputPath), "utf8"));
    }
  }
  return chunks;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
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
