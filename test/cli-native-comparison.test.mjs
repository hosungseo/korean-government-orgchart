import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src/cli.mjs");

async function writeStage(dir, name, asOf, decree, rule) {
  const folder = path.join(dir, name);
  await mkdir(folder);
  await writeFile(path.join(folder, `시험부 직제-${asOf.replaceAll("-", "")}.txt`), decree, "utf8");
  await writeFile(path.join(folder, `시험부 직제 시행규칙-${asOf.replaceAll("-", "")}.txt`), rule, "utf8");
  return folder;
}

test("compare-native는 두 시점을 A4 대비 명세와 SVG로 만든다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-compare-native-2-"));
  const before = await writeStage(
    dir,
    "before",
    "2025-10-01",
    `시험부와 그 소속기관 직제\n제2조(하부조직) 시험부에 조직국을 둔다.`,
    `시험부와 그 소속기관 직제 시행규칙\n제3조(조직국) 조직국에 조직기획과ㆍ조직진단과를 둔다.`,
  );
  const after = await writeStage(
    dir,
    "after",
    "2026-01-01",
    `시험부와 그 소속기관 직제\n제2조(하부조직) 시험부에 조직국을 둔다.`,
    `시험부와 그 소속기관 직제 시행규칙\n제3조(조직국) 조직국에 조직기획과ㆍ법사조직과를 둔다.`,
  );
  const svgPath = path.join(dir, "compare.svg");
  const jsonPath = path.join(dir, "compare.native.json");
  const { stdout } = await run(process.execPath, [
    CLI,
    "compare-native",
    "--stage",
    before,
    "--stage-date",
    "2025-10-01",
    "--stage",
    after,
    "--stage-date",
    "2026-01-01",
    "--focus",
    "조직국",
    "--svg",
    svgPath,
    "--json",
    jsonPath,
  ]);
  const summary = JSON.parse(stdout);
  const manifest = JSON.parse(await readFile(jsonPath, "utf8"));
  const svg = await readFile(svgPath, "utf8");
  assert.equal(summary.paper, "A4");
  assert.equal(summary.layout, "comparison-two-column");
  assert.equal(manifest.page.paper, "A4");
  assert.match(svg, /법사조직과/);
  assert.match(svg, /신설/);
  assert.match(svg, /폐지/);
});

test("compare-native는 세 시점을 A3 가로 3단으로 작도한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-compare-native-3-"));
  const first = await writeStage(
    dir,
    "s1",
    "2025-10-01",
    `시험행정부와 그 소속기관 직제\n제4조(하부조직) 시험행정부에 디지털정부실 및 참여혁신실을 둔다.\n제5조(디지털정부실) 디지털정부실에 인공지능정책국을 둔다.\n제6조(참여혁신실) 참여혁신실에 조직국을 둔다.`,
    `시험행정부와 그 소속기관 직제 시행규칙\n제3조(디지털정부실) 인공지능정책국에 인공지능정책과를 둔다.\n제4조(참여혁신실) 조직국에 조직기획과를 둔다.`,
  );
  const second = await writeStage(
    dir,
    "s2",
    "2025-11-25",
    `시험행정부와 그 소속기관 직제\n제4조(하부조직) 시험행정부에 인공지능정부실 및 참여혁신실을 둔다.\n제5조(인공지능정부실) 인공지능정부실에 인공지능정책국을 둔다.\n제6조(참여혁신실) 참여혁신실에 조직국을 둔다.`,
    `시험행정부와 그 소속기관 직제 시행규칙\n제3조(인공지능정부실) 인공지능정책국에 인공지능정책과를 둔다.\n제4조(참여혁신실) 조직국에 조직기획과를 둔다.`,
  );
  const third = await writeStage(
    dir,
    "s3",
    "2026-07-21",
    `시험행정부와 그 소속기관 직제\n제4조(하부조직) 시험행정부에 인공지능정부실 및 참여혁신조직실을 둔다.\n제5조(인공지능정부실) 인공지능정부실에 인공지능정책국을 둔다.\n제6조(참여혁신조직실) 참여혁신조직실에 조직국을 둔다.`,
    `시험행정부와 그 소속기관 직제 시행규칙\n제3조(인공지능정부실) 인공지능정책국에 인공지능정책과를 둔다.\n제4조(참여혁신조직실) 조직국에 조직기획과ㆍ법사조직과를 둔다.`,
  );
  const svgPath = path.join(dir, "three.svg");
  const { stdout } = await run(process.execPath, [
    CLI,
    "compare-native",
    "--stage", first, "--stage-date", "2025-10-01",
    "--stage", second, "--stage-date", "2025-11-25",
    "--stage", third, "--stage-date", "2026-07-21",
    "--focus", "디지털정부실, 인공지능정부실, 참여혁신실, 참여혁신조직실, 조직국",
    "--svg", svgPath,
  ]);
  const summary = JSON.parse(stdout);
  const svg = await readFile(svgPath, "utf8");
  assert.equal(summary.paper, "A3");
  assert.equal(summary.columns, 3);
  assert.equal(summary.layout, "comparison-multi-column");
  assert.match(svg, /viewBox="0 0 420 297"/);
  assert.match(svg, /법사조직과/);
  assert.match(svg, /신설/);
});
