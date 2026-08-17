#!/usr/bin/env node
// Merge N organization snapshots into one synthetic comparison target —
// used to trace a ministry split (one before → several after ministries).
//   node scripts/merge-organization-snapshots.mjs \
//     --input outputs/기획예산처-20260801.json --label 기획예산처 \
//     --input outputs/재정경제부-20260801.json --label 재정경제부 \
//     --out outputs/기획예산처+재정경제부-20260801.json
// Department names that appear in more than one source are suffixed with
// "(label)" so duty matching cannot collapse them; a departmentMinistry map
// is stored in meta for downstream attribution.
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { input: [], label: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : true;
    if (key === "input" || key === "label") args[key].push(value);
    else args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.input.length < 2) throw new Error("--input 을 2개 이상 지정하세요.");
  if (args.label.length !== args.input.length) throw new Error("--label 은 --input 과 같은 개수여야 합니다.");
  const sources = [];
  for (let i = 0; i < args.input.length; i += 1) {
    sources.push({
      label: args.label[i],
      graph: JSON.parse(await fs.readFile(path.resolve(args.input[i]), "utf8")),
    });
  }

  const nameOwners = new Map();
  for (const { label, graph } of sources) {
    for (const entry of graph.meta?.departmentDutyCatalog || []) {
      const name = String(entry.department || "").trim();
      if (!name) continue;
      if (!nameOwners.has(name)) nameOwners.set(name, new Set());
      nameOwners.get(name).add(label);
    }
  }
  const collides = (name) => (nameOwners.get(name)?.size || 0) > 1;
  const rename = (name, label) => (collides(name) ? `${name}(${label})` : name);

  const catalog = [];
  const departmentMinistry = {};
  for (const { label, graph } of sources) {
    for (const entry of graph.meta?.departmentDutyCatalog || []) {
      const name = String(entry.department || "").trim();
      if (!name) continue;
      const renamed = rename(name, label);
      departmentMinistry[renamed] = label;
      catalog.push({ ...entry, department: renamed });
    }
  }

  const base = sources[0].graph;
  const merged = {
    ...base,
    nodes: sources.flatMap(({ graph }) => graph.nodes || []),
    edges: sources.flatMap(({ graph }) => graph.edges || []),
    meta: {
      ...base.meta,
      institution: sources.map(({ label }) => label).join("+"),
      title: `${sources.map(({ label }) => label).join(" + ")} 병합 대조본`,
      departmentDutyCatalog: catalog,
      departmentMinistry,
      mergedFrom: sources.map(({ label }, index) => ({ label, file: args.input[index] })),
    },
  };
  const out = args.out || "outputs/merged-snapshot.json";
  await fs.writeFile(path.resolve(out), `${JSON.stringify(merged, null, 2)}\n`);
  const renamedCount = Object.keys(departmentMinistry).filter((name) => name.includes("(")).length;
  console.log(`병합 완료: 부서 ${catalog.length} (충돌 접미사 ${renamedCount}) → ${out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
