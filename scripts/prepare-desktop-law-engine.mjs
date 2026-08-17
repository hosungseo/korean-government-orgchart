import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "desktop", "ui", "engine");
const modules = [
  "utils-core.mjs",
  "legal-duty.mjs",
  "model.mjs",
  "parser.mjs",
  "native-law-workflow.mjs",
  "duty-allocation.mjs",
  "duty-lineage.mjs",
  "function-lineage.mjs",
  "law-json-core.mjs",
  "law-history.mjs",
];

await fs.mkdir(target, { recursive: true });
for (const moduleName of modules) {
  await fs.copyFile(path.join(root, "src", moduleName), path.join(target, moduleName));
}
console.log(`브라우저용 직제 파서 ${modules.length}개 모듈 준비: ${target}`);
