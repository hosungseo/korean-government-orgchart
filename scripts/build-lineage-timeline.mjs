#!/usr/bin/env node
// End-to-end timeline pipeline: collect dated snapshots from law.go.kr,
// then chain function lineages between consecutive dates.
//   node scripts/build-lineage-timeline.mjs \
//     --institution 문화체육관광부 \
//     --date 2024-02-05 --date 2025-12-30 --date 2026-07-28 \
//     [--build-missing] [--outputs-dir outputs] [--audit] \
//     --out-prefix outputs/문화체육관광부-기능계보
// Snapshots are cached as <outputs-dir>/<기관>-<YYYYMMDD>.json; missing ones
// are built via `cli.mjs from-law` when --build-missing is set.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBuildFunctionLineage } from "./build-function-lineage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { date: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : true;
    if (key === "date") args.date.push(value);
    else args[key] = value;
  }
  return args;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureSnapshot({ institution, date, outputsDir, buildMissing }) {
  const compact = date.replaceAll("-", "");
  const file = path.join(outputsDir, `${institution}-${compact}.json`);
  if (await exists(file)) return file;
  if (!buildMissing) throw new Error(`스냅샷이 없습니다: ${file} (--build-missing 으로 자동 수집 가능)`);
  console.log(`수집: ${institution} @ ${date} → ${file}`);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "src/cli.mjs"),
    "from-law",
    "--institution", institution,
    "--date", date,
    "--json", file,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`from-law 실패: ${institution} @ ${date}`);
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.institution) throw new Error("--institution 이 필요합니다.");
  if (args.date.length < 2) throw new Error("--date 를 시간 순서대로 2개 이상 지정하세요.");
  const outputsDir = path.resolve(args["outputs-dir"] || "outputs");
  const prefix = args["out-prefix"] || path.join(outputsDir, `${args.institution}-기능계보`);

  const files = [];
  for (const date of args.date) {
    files.push(await ensureSnapshot({
      institution: args.institution,
      date,
      outputsDir,
      buildMissing: Boolean(args["build-missing"]),
    }));
  }

  const timeline = { schema: "kr.go.mois.orgchart.function-lineage-timeline/v1", institution: args.institution, dates: args.date, pairs: [] };
  for (let i = 0; i < files.length - 1; i += 1) {
    const tag = `${args.date[i].replaceAll("-", "")}-${args.date[i + 1].replaceAll("-", "")}`;
    const lineage = await runBuildFunctionLineage({
      before: files[i],
      after: files[i + 1],
      "out-json": `${prefix}-${tag}.json`,
      "out-md": `${prefix}-${tag}.md`,
      "out-html": `${prefix}-${tag}.html`,
    });
    timeline.pairs.push({ from: args.date[i], to: args.date[i + 1], files: { before: files[i], after: files[i + 1] }, verdicts: lineage.stats.verdicts, stats: { beforeFunctions: lineage.stats.beforeFunctions, afterFunctions: lineage.stats.afterFunctions, suspect: lineage.stats.suspectSameNameDepartment } });
    const v = lineage.stats.verdicts;
    console.log(`${args.date[i]} → ${args.date[i + 1]}: 유지 ${v["유지"]} · 문언변경 ${v["문언변경"]} · 이관 ${v["이관"]} · 통합 ${v["통합"]} · 분할 ${v["분할"]} · 폐지 ${v["폐지후보"]} · 신설 ${v["신설후보"]}`);
  }
  await fs.writeFile(`${prefix}-타임라인.json`, `${JSON.stringify(timeline, null, 2)}\n`);
  console.log("타임라인:", `${prefix}-타임라인.json`);

  if (args.audit) {
    const auditArgs = files.flatMap((file) => ["--snapshot", file]);
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "scripts/build-continuity-audit.mjs"),
      ...auditArgs,
      "--out-json", `${prefix}-연속성감사.json`,
      "--out-md", `${prefix}-연속성감사.md`,
    ], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("연속성 감사 실패");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
