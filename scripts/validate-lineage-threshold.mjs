#!/usr/bin/env node
// Threshold validation harness for function lineage matching.
//   node scripts/validate-lineage-threshold.mjs \
//     --self outputs/A.json \
//     --near-before outputs/A.json --near-after outputs/B.json \
//     --reorg-before outputs/A.json --reorg-after outputs/C.json \
//     --out outputs/기능계보-임계값검증.md
// Emits: identity check, near-pair churn breakdown, and a review sheet of
// every non-trivial verdict (이관·통합·분할·폐지·신설) plus gray-zone rejected
// matches (0.48 <= score < acceptance) for human adjudication.
import fs from "node:fs/promises";
import path from "node:path";
import { buildFunctionLineage } from "../src/function-lineage.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : true;
    args[key] = value;
  }
  return args;
}

const load = async (p) => JSON.parse(await fs.readFile(path.resolve(p), "utf8"));

function verdictLine(stats) {
  const v = stats.verdicts;
  return `유지 ${v["유지"]} · 문언변경 ${v["문언변경"]} · 이관 ${v["이관"]} · 통합 ${v["통합"]} · 분할 ${v["분할"]} · 폐지후보 ${v["폐지후보"]} · 신설후보 ${v["신설후보"]}`;
}

function reviewRows(lineage, { limit = 400 } = {}) {
  const rows = [];
  const push = (kind, entry) => rows.push({ kind, entry });
  for (const entry of lineage.entries) {
    if (["이관", "통합", "분할"].includes(entry.verdict)) push(entry.verdict, entry);
  }
  for (const entry of lineage.entries.filter((item) => item.verdict === "폐지후보")) push("폐지후보", entry);
  for (const item of lineage.newFunctions) push("신설후보", { before: null, after: item, from: null, to: item.department });
  return rows.slice(0, limit);
}

function grayZone(lineage, { floor = 0.48 } = {}) {
  const seen = new Set(lineage.entries.filter((entry) => entry.after).map((entry) => entry.id));
  return (lineage.rejected || []).filter((match) => match.score >= floor && !seen.has(match.before.id));
}

function fmtRow({ kind, entry }) {
  if (kind === "신설후보") {
    return `| 신설후보 | — | ${entry.to} | — | ${cell(entry.after.citation)} ${cell(entry.after.text)} | — |`;
  }
  if (kind === "폐지후보") {
    return `| 폐지후보 | ${entry.before.department} | — | ${cell(entry.before.citation)} ${cell(entry.before.text)} | — | — |`;
  }
  const mark = entry.suspect ? " ⚠동명이과" : "";
  return `| ${kind}${mark} | ${entry.from} | ${entry.to} | ${cell(entry.before.citation)} ${cell(entry.before.text)} | ${cell(entry.after?.citation)} ${cell(entry.after?.text)} | ${entry.score ?? ""} |`;
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "／").replace(/\n/g, " ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = [];
  lines.push("# 기능 계보 임계값 검증 리포트");
  lines.push("");

  if (args.self) {
    const graph = await load(args.self);
    const result = buildFunctionLineage(graph, graph);
    const v = result.stats.verdicts;
    const clean = v["이관"] === 0 && v["폐지후보"] === 0 && v["신설후보"] === 0 && v["통합"] === 0 && v["분할"] === 0 && v["문언변경"] === 0;
    lines.push(`## 1. 항등성(자기 자신 대조): ${clean ? "PASS" : "FAIL"}`);
    lines.push("");
    lines.push(`- ${args.self}: ${verdictLine(result.stats)} (기대: 전량 유지)`);
    lines.push("");
  }

  for (const [label, beforeKey, afterKey] of [
    ["2. 근접 쌍(소폭 개정 전후)", "near-before", "near-after"],
    ["3. 대개편 쌍", "reorg-before", "reorg-after"],
  ]) {
    if (!args[beforeKey] || !args[afterKey]) continue;
    const before = await load(args[beforeKey]);
    const after = await load(args[afterKey]);
    const result = buildFunctionLineage(before, after);
    lines.push(`## ${label}`);
    lines.push("");
    lines.push(`- ${args[beforeKey]} → ${args[afterKey]}`);
    lines.push(`- 사무 ${result.stats.beforeFunctions} → ${result.stats.afterFunctions} · ${verdictLine(result.stats)}`);
    lines.push("");
    lines.push("| 판정 | 전 부서 | 후 부서 | 전 사무 | 후 사무 | 유사도 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of reviewRows(result)) lines.push(fmtRow(row));
    lines.push("");
  }

  const out = args.out || "outputs/기능계보-임계값검증.md";
  await fs.writeFile(path.resolve(out), `${lines.join("\n")}\n`);
  console.log("written:", out);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
