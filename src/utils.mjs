import fs from "node:fs/promises";
import path from "node:path";
export {
  compactDate,
  displayDate,
  jsonReplacer,
  normalizeWhitespace,
  stableId,
  uniq,
  xmlEscape,
} from "./utils-core.mjs";

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

export async function writeText(filePath, text) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, text, "utf8");
}

export function parseArgs(argv) {
  const repeatedKeys = new Set([
    "input",
    "law",
    "before-input",
    "after-input",
    "before-law",
    "after-law",
    "stage",
    "stage-date",
  ]);
  const args = {
    _: [],
    input: [],
    law: [],
    "before-input": [],
    "after-input": [],
    "before-law": [],
    "after-law": [],
    stage: [],
    "stage-date": [],
  };
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
    if (repeatedKeys.has(key)) {
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
