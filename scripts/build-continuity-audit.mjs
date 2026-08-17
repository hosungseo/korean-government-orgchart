#!/usr/bin/env node
// Function-continuity audit across an ordered series of snapshots.
//   node scripts/build-continuity-audit.mjs \
//     --snapshot outputs/문화체육관광부-20240205.json \
//     --snapshot outputs/문화체육관광부-20251230.json \
//     --snapshot outputs/문화체육관광부-20260728.json \
//     [--law-map work/dept-map.json] \
//     --out-json outputs/문화체육관광부-기능연속성감사.json \
//     --out-md outputs/문화체육관광부-기능연속성감사.md
// Signals:
//   사라진 사무  — 어느 시점에 폐지후보가 된 뒤, 이후 어떤 스냅샷에도 다시 나타나지 않는 사무
//   중복 사무    — 같은 스냅샷 안에서 서로 다른 부서가 유사 문언(기본 0.9 이상)을 동시에 보유
//   신설 사무    — 기원 없이 나타난 사무(직전 대비)
//   무주공산     — (law-map 제공 시) 소관 법령은 있으나 분장사무 문언에 흔적이 없는 법령
import fs from "node:fs/promises";
import path from "node:path";
import { buildFunctionLineage, findDuplicateDuties } from "../src/function-lineage.mjs";
import { normalizeDutyFunctionText } from "../src/legal-duty.mjs";

function parseArgs(argv) {
  const args = { snapshot: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : true;
    if (key === "snapshot") args.snapshot.push(value);
    else args[key] = value;
  }
  return args;
}

const load = async (p) => JSON.parse(await fs.readFile(path.resolve(p), "utf8"));

function snapshotLabel(graph, filePath) {
  return graph?.meta?.asOf || graph?.meta?.date || path.basename(filePath, ".json");
}

function allNormalizedTexts(graph) {
  const set = new Set();
  for (const entry of graph.meta?.departmentDutyCatalog || []) {
    for (const item of entry.items || []) {
      const text = String(item?.text || "").trim();
      if (!text || /^삭제/u.test(text)) continue;
      set.add(item.normalizedText || normalizeDutyFunctionText(text));
    }
  }
  return set;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.snapshot.length < 2) throw new Error("--snapshot 을 시간 순서대로 2개 이상 지정하세요.");
  const graphs = [];
  for (const file of args.snapshot) graphs.push({ file, graph: await load(file) });
  const labels = graphs.map(({ graph, file }) => snapshotLabel(graph, file));
  const laterTexts = graphs.map(({ graph }) => allNormalizedTexts(graph));

  // 1) pairwise lineage → 폐지후보·신설후보
  const pairs = [];
  for (let i = 0; i < graphs.length - 1; i += 1) {
    const lineage = buildFunctionLineage(graphs[i].graph, graphs[i + 1].graph);
    pairs.push({ from: labels[i], to: labels[i + 1], lineage });
  }

  // 2) 사라진 사무: 폐지후보 중 이후 모든 스냅샷의 문언 전집합에 재등장하지 않는 것
  const vanished = [];
  pairs.forEach((pair, index) => {
    for (const entry of pair.lineage.entries) {
      if (entry.verdict !== "폐지후보") continue;
      const normalized = normalizeDutyFunctionText(entry.before.text);
      const reappears = laterTexts.slice(index + 2).some((set) => set.has(normalized));
      if (!reappears) {
        vanished.push({
          lastSeen: pair.from,
          goneSince: pair.to,
          department: entry.before.department,
          citation: entry.before.citation,
          text: entry.before.text,
        });
      }
    }
  });

  // 3) 중복 사무(최신 스냅샷 기준)
  const duplicateThreshold = Number(args["dup-threshold"] || 0.9);
  const latest = graphs[graphs.length - 1];
  const duplicates = findDuplicateDuties(latest.graph, { threshold: duplicateThreshold });

  // 4) 무주공산(선택): law-map의 소관 법령명이 최신 분장사무 문언 어디에도 없으면 신호
  let orphanLaws = null;
  if (args["law-map"]) {
    const lawMap = await load(args["law-map"]);
    const laws = Array.isArray(lawMap) ? lawMap : lawMap.laws || Object.values(lawMap).flat();
    const corpus = [...allNormalizedTexts(latest.graph)].join("\n");
    orphanLaws = [];
    for (const law of laws) {
      const name = typeof law === "string" ? law : law.lawName || law.name || "";
      if (!name) continue;
      const stem = normalizeDutyFunctionText(name.replace(/에 관한 (법률|규정)|법률$|법$|시행령$|시행규칙$/g, ""));
      if (stem.length < 4) continue;
      if (!corpus.includes(stem)) orphanLaws.push({ law: name });
    }
  }

  const report = {
    schema: "kr.go.mois.orgchart.function-continuity-audit/v1",
    snapshots: labels,
    pairs: pairs.map(({ from, to, lineage }) => ({ from, to, verdicts: lineage.stats.verdicts })),
    vanished,
    duplicates: {
      threshold: duplicates.threshold,
      asOf: labels[labels.length - 1],
      count: duplicates.duplicates.length,
      items: duplicates.duplicates,
      boilerplateCount: duplicates.boilerplate.length,
      boilerplate: duplicates.boilerplate,
    },
    orphanLaws,
  };
  if (args["out-json"]) await fs.writeFile(path.resolve(args["out-json"]), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [];
  lines.push(`# 기능 연속성 감사 — ${labels.join(" → ")}`);
  lines.push("");
  for (const pair of report.pairs) {
    const v = pair.verdicts;
    lines.push(`- ${pair.from} → ${pair.to}: 유지 ${v["유지"]} · 문언변경 ${v["문언변경"]} · 이관 ${v["이관"]} · 통합 ${v["통합"]} · 분할 ${v["분할"]} · 폐지후보 ${v["폐지후보"]} · 신설후보 ${v["신설후보"]}`);
  }
  lines.push("");
  lines.push(`## 사라진 사무 (${vanished.length}) — 이후 어떤 시점에도 재등장하지 않음`);
  lines.push("");
  for (const item of vanished) {
    lines.push(`- [${item.department}] ${item.citation}: ${item.text} (마지막 등장 ${item.lastSeen}, ${item.goneSince}부터 부재)`);
  }
  lines.push("");
  lines.push(`## 중복 사무(실질) (${report.duplicates.count}) — ${report.duplicates.asOf} 기준, 부서 간 유사도 ≥ ${duplicateThreshold}, 2개 부서만 보유`);
  lines.push("");
  for (const item of report.duplicates.items.slice(0, 80)) {
    const ctx = (c) => { const m = String(c || "").match(/\(([^)]+)\)/); return m ? m[1] : ""; };
    lines.push(`- (${item.score}) [${ctx(item.left.citation)}·${item.left.department}] ${item.left.text}  ↔  [${ctx(item.right.citation)}·${item.right.department}] ${item.right.text}`);
  }
  lines.push("");
  lines.push(`## 관례 서무(공통 문형) ${report.duplicates.boilerplateCount}쌍 — 3개 부서 이상 공유(보안·관인, 예산·회계 등), 실질 중복 아님`);
  if (orphanLaws) {
    lines.push("");
    lines.push(`## 무주공산 후보 (${orphanLaws.length}) — 소관 법령은 있으나 분장사무 문언에 흔적 없음`);
    lines.push("");
    for (const item of orphanLaws.slice(0, 60)) lines.push(`- ${item.law}`);
  }
  lines.push("");
  lines.push("> 폐지후보·중복·무주공산은 기계 신호이며, 훈령 개정 이력·위임 규정 확인 후 확정해야 합니다.");
  const outMd = args["out-md"] || "outputs/기능연속성감사.md";
  await fs.writeFile(path.resolve(outMd), `${lines.join("\n")}\n`);
  console.log(`감사 완료: 사라진 사무 ${vanished.length} · 실질 중복 ${report.duplicates.count} · 관례 서무 ${report.duplicates.boilerplateCount}${orphanLaws ? ` · 무주공산 후보 ${orphanLaws.length}` : ""}`);
  console.log("written:", outMd);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
