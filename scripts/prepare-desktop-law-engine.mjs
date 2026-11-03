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
  "annex.mjs",
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
// The direct HWPX writer runs in the webview so the app can save without Hangul.
// Rewrite its bare/relative imports to files copied next to it.
const writer = (await fs.readFile(path.join(root, "src", "render-native-hwpx.mjs"), "utf8"))
  .replace('import JSZip from "jszip";', 'import JSZip from "./vendor/jszip.mjs";')
  .replace('from "../docs/assets/hwpx-template.mjs"', 'from "./hwpx-template.mjs"');
if (!writer.includes("./vendor/jszip.mjs") || !writer.includes("./hwpx-template.mjs")) {
  throw new Error("render-native-hwpx.mjs imports changed; update prepare-desktop-law-engine.mjs");
}
await fs.writeFile(path.join(target, "render-native-hwpx.mjs"), writer);
await fs.copyFile(path.join(root, "docs", "assets", "hwpx-template.mjs"), path.join(target, "hwpx-template.mjs"));
await fs.mkdir(path.join(target, "vendor"), { recursive: true });
await fs.copyFile(path.join(root, "node_modules", "jszip", "dist", "jszip.min.js"), path.join(target, "vendor", "jszip.min.js"));
// jszip ships UMD only; loaded as a module script it attaches itself to window.
await fs.writeFile(path.join(target, "vendor", "jszip.mjs"), 'import "./jszip.min.js";\nexport default globalThis.JSZip;\n');
console.log(`브라우저용 직제 파서 ${modules.length}개 모듈 준비: ${target}`);
