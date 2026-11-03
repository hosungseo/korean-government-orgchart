#!/usr/bin/env node
/**
 * Agent Skill entry point: 직제·행정기구 설치 조례 문언 → 세로 조직도(편집형 HWPX)
 * 와 개편 전·후 대비표. Runs on plain Node (≥18) with no install step; the
 * skill bundle copies this file next to the engine modules.
 *
 *   orgchart.mjs outline --input 조례.txt --input 시행규칙.txt [--date YYYY-MM-DD] --out 폴더
 *   orgchart.mjs compare --stage 현행조례.txt,현행규칙.txt --stage 개편조례.txt,개편규칙.txt
 *                        [--stage-date …] [--label 현행 --label 개편안] --out 폴더
 *   orgchart.mjs check 파일.hwpx
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildNativeComparisonWorkflow, buildNativeLawWorkflow } from "./native-law-workflow.mjs";
import { createNativeHwpxBytes } from "./render-native-hwpx.mjs";
import { renderNativeManifestSvg } from "./render-native-manifest.mjs";

const USAGE = `직제·행정기구 설치 조례 → 조직도

  outline  --decree <직제|조례.txt> --rule <시행규칙.txt> [--date 2026-01-23] [--institution 기관명] --out <폴더>
           (또는 --input을 두 번: 이름에 '시행규칙'이 있거나 본문이 "이 규칙은"으로 시작하는 파일을 시행규칙으로 읽음)
           세로 조직도(1단, A4 세로) 편집형 HWPX + 쪽별 미리보기
  compare  --stage <조례.txt>,<시행규칙.txt> (2~4번) [--stage-date …] [--label …] --out <폴더>
           개편 전·후 대비표(2단 A4 세로, 3~4단 A3 가로) HWPX + 미리보기
  check    <파일.hwpx>   생성 결과 점검(rhwp가 있으면 재파싱·쪽 수 검증)

경로는 현재 작업 폴더 기준입니다. 날짜는 2026-01-23 또는 2026. 1. 23. 형식.`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!command || ["help", "--help", "-h"].includes(command) || args.help) {
    console.log(USAGE);
    return 0;
  }
  if (command === "outline") return outline(args);
  if (command === "compare") return compare(args);
  if (command === "check") return check(args._[0] || args.file);
  throw new Error(`알 수 없는 명령입니다: ${command}\n\n${USAGE}`);
}

async function outline(args) {
  const decree = list(args.decree).map((file) => ({ file, role: "decree" }));
  const rule = list(args.rule).map((file) => ({ file, role: "rule" }));
  const inputs = [...decree, ...rule, ...list(args.input).map((file) => ({ file }))];
  if (!inputs.length) throw new Error("--decree(직제·설치 조례)와 --rule(시행규칙) 텍스트 파일을 지정하세요.");
  const stage = await readStage(inputs, normalizeDate(args.date), args.institution);
  const workflow = buildNativeLawWorkflow({ ...stage, focus: args.focus });
  const name = `${safe(workflow.summary.institution)}-조직도`;
  const result = await writeOutputs(workflow, requiredOut(args), name);
  print({ ...summaryOf(workflow, stage.roles), ...result });
  return 0;
}

async function compare(args) {
  const stageArgs = list(args.stage);
  if (stageArgs.length < 2 || stageArgs.length > 4) throw new Error("--stage를 2~4번 지정하세요(개편 전·후 등).");
  const dates = list(args["stage-date"]);
  const labels = list(args.label);
  const stages = [];
  for (const [index, value] of stageArgs.entries()) {
    const files = value.split(",").map((item) => item.trim()).filter(Boolean).map((file) => ({ file }));
    const stage = await readStage(files, normalizeDate(dates[index]), args.institution);
    stages.push({ ...stage, ...(labels[index] ? { label: labels[index] } : {}) });
  }
  const workflow = buildNativeComparisonWorkflow({ stages, focus: args.focus, onePage: true });
  const name = `${safe(workflow.summary.institution)}-조직대비-${stages.length}단`;
  const result = await writeOutputs(workflow, requiredOut(args), name);
  print({ ...summaryOf(workflow), columns: stages.length, ...result });
  return 0;
}

async function writeOutputs(workflow, outDir, name) {
  const dir = path.resolve(outDir);
  await fs.mkdir(path.join(dir, "preview"), { recursive: true });
  const hwpx = path.join(dir, `${name}.hwpx`);
  await fs.writeFile(hwpx, await createNativeHwpxBytes(workflow.manifests, { title: name }));
  const previews = [];
  const rsvg = findExecutable("rsvg-convert");
  for (const [index, manifest] of workflow.manifests.entries()) {
    const base = path.join(dir, "preview", String(index + 1).padStart(2, "0"));
    await fs.writeFile(`${base}.svg`, renderNativeManifestSvg(manifest));
    if (rsvg) {
      const run = spawnSync(rsvg, ["-w", "1240", `${base}.svg`, "-o", `${base}.png`]);
      previews.push(run.status === 0 ? `${base}.png` : `${base}.svg`);
    } else {
      previews.push(`${base}.svg`);
    }
  }
  return { hwpx, previews };
}

async function check(file) {
  if (!file) throw new Error("점검할 .hwpx 파일을 지정하세요.");
  const resolved = path.resolve(file);
  await fs.access(resolved);
  const rhwp = findExecutable("rhwp", [path.join(process.env.HOME || "", ".local/bin/rhwp")]);
  if (!rhwp) {
    print({ file: resolved, rhwp: false, note: "rhwp가 없어 재파싱 검증을 건너뜁니다. 한글에서 열어 확인하세요." });
    return 0;
  }
  const info = spawnSync(rhwp, ["info", resolved], { encoding: "utf8" });
  const pages = Number(info.stdout.match(/페이지 수:\s*(\d+)/)?.[1] || 0);
  const roundTrip = spawnSync(rhwp, ["export-hwpx", resolved, `${resolved}.roundtrip.hwpx`, "--verify", "--verify-pages"], { encoding: "utf8" });
  await fs.rm(`${resolved}.roundtrip.hwpx`, { force: true });
  const ok = info.status === 0 && pages > 0 && roundTrip.status === 0;
  print({ file: resolved, rhwp: true, pages, roundTrip: roundTrip.status === 0 ? "IR 차이 없음" : roundTrip.stdout + roundTrip.stderr, ok });
  return ok ? 0 : 1;
}

async function readStage(files, asOf, institution) {
  const stage = { decreeText: "", ruleText: "", asOf, institution, roles: [] };
  for (const { file, role } of files) {
    const text = await fs.readFile(path.resolve(file), "utf8");
    const resolvedRole = role || roleOf(file, text);
    if (resolvedRole === "rule") stage.ruleText += `\n${text}`;
    else stage.decreeText += `\n${text}`;
    stage.roles.push({ file: path.basename(file), role: resolvedRole === "rule" ? "시행규칙" : "직제·조례" });
  }
  if (!stage.decreeText.trim() && !stage.ruleText.trim()) throw new Error(`읽을 문언이 없습니다: ${files.map(({ file }) => file).join(", ")}`);
  return stage;
}

// 이름에 '시행규칙'이 있거나, 이름이 역할을 말하지 않을 때 본문 첫머리가
// 「…시행규칙」·"이 규칙은"이면 시행규칙으로 본다.
function roleOf(file, text) {
  const name = path.basename(file);
  if (/시행규칙/.test(name)) return "rule";
  if (/직제|조례/.test(name)) return "decree";
  const head = String(text).slice(0, 1500);
  return /이\s*규칙은|시행규칙/.test(head) && !/이\s*(?:조례|영)은/.test(head) ? "rule" : "decree";
}

function normalizeDate(value) {
  if (!value || value === true) return undefined;
  const parts = String(value).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!parts) return String(value);
  return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
}

function summaryOf(workflow, roles) {
  return {
    ...(roles ? { inputs: roles } : {}),
    institution: workflow.summary.institution,
    asOf: workflow.summary.asOf,
    pageCount: workflow.summary.pageCount,
    pages: workflow.pages.map((page) => page.label),
    warnings: workflow.summary.warnings,
  };
}

function requiredOut(args) {
  if (!args.out) throw new Error("--out에 결과를 저장할 폴더를 지정하세요.");
  return args.out;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next === undefined || next.startsWith("--") ? true : (index += 1, next);
    if (args[key] === undefined) args[key] = value;
    else args[key] = [].concat(args[key], value);
  }
  return args;
}

function list(value) {
  if (value === undefined || value === true) return [];
  return [].concat(value).filter((item) => typeof item === "string");
}

function findExecutable(name, extra = []) {
  for (const candidate of extra) {
    if (candidate && spawnSync(candidate, ["--version"]).status === 0) return candidate;
  }
  return spawnSync(name, ["--version"]).status === 0 ? name : null;
}

function safe(value) {
  return String(value || "조직").replace(/[\\/:*?"<>|\s]+/g, "-");
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("orgchart.mjs");
if (invokedDirectly) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
