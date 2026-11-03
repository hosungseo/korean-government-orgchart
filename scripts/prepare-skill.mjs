// Assemble the Agent Skill bundle (skills/korean-gov-orgchart/scripts) from
// src/: follow the import graph from skill-cli.mjs, copy every module next
// to it, vendor jszip, and refuse any other npm dependency so the skill runs
// on plain Node without `npm install`.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "korean-gov-orgchart");
const target = path.join(skillDir, "scripts");
const checkOnly = process.argv.includes("--check");

const REWRITES = new Map([
  ["jszip", "./vendor/jszip.mjs"],
  ["../docs/assets/hwpx-template.mjs", "./hwpx-template.mjs"],
]);

async function collect(entry) {
  const files = new Map();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    let source = await fs.readFile(file, "utf8");
    for (const [from, to] of REWRITES) {
      source = source.replaceAll(`from "${from}"`, `from "${to}"`);
    }
    const name = path.basename(file) === "skill-cli.mjs" ? "orgchart.mjs" : path.basename(file);
    files.set(file, { name, source });
    for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || specifier.startsWith("./vendor/")) continue;
      if (specifier === "./hwpx-template.mjs") {
        queue.push(path.join(root, "docs", "assets", "hwpx-template.mjs"));
        continue;
      }
      if (!specifier.startsWith("./")) {
        throw new Error(`${path.relative(root, file)}: 스킬에 넣을 수 없는 외부 의존성 "${specifier}"`);
      }
      queue.push(path.join(path.dirname(file), specifier));
    }
  }
  return [...files.values()];
}

const modules = await collect(path.join(root, "src", "skill-cli.mjs"));
const require = createRequire(import.meta.url);
const jszipDir = path.dirname(require.resolve("jszip/package.json"));
const vendor = [
  { name: "vendor/jszip.min.cjs", source: await fs.readFile(path.join(jszipDir, "dist", "jszip.min.js"), "utf8") },
  { name: "vendor/JSZIP-LICENSE.markdown", source: await fs.readFile(path.join(jszipDir, "LICENSE.markdown"), "utf8") },
  {
    name: "vendor/jszip.mjs",
    source: `// jszip ${require("jszip/package.json").version} (MIT) UMD build, loaded for ESM callers.\nimport { createRequire } from "node:module";\n\nconst require = createRequire(import.meta.url);\nexport default require("./jszip.min.cjs");\n`,
  },
];

const outputs = [...modules, ...vendor];
if (checkOnly) {
  const stale = [];
  for (const { name, source } of outputs) {
    const current = await fs.readFile(path.join(target, name), "utf8").catch(() => null);
    if (current !== source) stale.push(name);
  }
  if (stale.length) {
    console.error(`스킬 번들이 src와 다릅니다. node scripts/prepare-skill.mjs 를 실행하세요: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`스킬 번들 최신: ${outputs.length}개 파일`);
} else {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, "vendor"), { recursive: true });
  for (const { name, source } of outputs) await fs.writeFile(path.join(target, name), source);
  console.log(`스킬 번들 준비: ${path.relative(root, target)} (${modules.length}개 모듈 + jszip)`);
}
