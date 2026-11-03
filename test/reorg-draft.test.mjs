import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createAmendmentHwpxBytes } from "../src/render-amendment-hwpx.mjs";
import {
  buildAmendmentDocument,
  draftAmendment,
  formatOutline,
  parseOutline,
  particle,
  readStructure,
} from "../src/reorg-draft.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gunsan = path.join(root, "skills", "korean-gov-orgchart", "examples", "gunsan");
const decreeText = readFileSync(path.join(gunsan, "군산시 행정기구 설치 조례.txt"), "utf8");
const ruleText = readFileSync(path.join(gunsan, "군산시 행정기구 설치 조례 시행규칙.txt"), "utf8");
const currentOutline = formatOutline(readStructure({ decreeText, ruleText }));

function edit(outline, replacements) {
  let text = outline;
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `개요에 없는 줄: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}

// 이름 변경·국 신설(과 이동+신설)·과 폐지·과 이동·담당관 신설·직속기관 과 명칭 변경
const reorganization = edit(currentOutline, [
  ["      디지털정보담당관 [보좌]\n", "      디지털혁신담당관 [보좌] (← 디지털정보담당관)\n      청년정책담당관 [보좌]\n"],
  ["        회계과\n", ""],
  ["        건축경관과\n", "        건축경관과\n        도시재생과\n"],
  ["        도시재생과\n        체육진흥과", "        체육진흥과"],
  ["        신성장산업과\n", ""],
  ["        신재생에너지과\n", ""],
  ["      문화관광국\n", "      미래산업국\n        신성장산업과\n        신재생에너지과\n        이차전지산업과\n      문화관광국\n"],
  ["    위생과\n", "    식품위생과 (← 위생과)\n"],
]);

test("현행 개요를 그대로 넣으면 바뀌는 문언이 없다", () => {
  const tree = parseOutline(currentOutline);
  assert.equal(tree.name, "군산시");
  const result = draftAmendment({ decreeText, ruleText, target: currentOutline });
  assert.equal(result.amended.decreeText, decreeText);
  assert.equal(result.amended.ruleText, ruleText);
  assert.deepEqual(result.plan, { renames: [], created: [], abolished: [], moved: [] });
  assert.equal(result.verification.ok, true);
});

test("개편안 개요로 조례·시행규칙을 고치고, 고친 문언을 다시 그리면 개편안과 같다", () => {
  const result = draftAmendment({ decreeText, ruleText, target: reorganization });
  assert.equal(result.verification.ok, true, result.verification.problems.join("\n"));
  assert.deepEqual(result.plan.renames, [
    { from: "디지털정보담당관", to: "디지털혁신담당관" },
    { from: "위생과", to: "식품위생과" },
  ]);
  assert.deepEqual(result.plan.moved.map((item) => item.name).sort(), ["신성장산업과", "신재생에너지과", "도시재생과"].sort());

  const decree = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례", oldText: decreeText, newText: result.amended.decreeText });
  assert.deepEqual(decree.sentences.filter((line) => line.startsWith("제") && line.endsWith("한다.")), [
    "제3조 중 “경제산업국”을 “경제산업국, 미래산업국”으로 한다.",
    "제4조 중 “디지털정보담당관”을 “디지털혁신담당관, 청년정책담당관”으로 한다.",
    "제5조제1항 중 “회계과, 세무과”를 “세무과”로 한다.",
    "제6조제1항 중 “건축경관과”를 “건축경관과, 도시재생과”로 한다.",
    "제7조제1항 중 “신성장산업과, 기업지원과, 신재생에너지과”를 “기업지원과”로 한다.",
    "제7조의2를 다음과 같이 신설한다.",
    "제8조제1항 중 “도시재생과, 체육진흥과”를 “체육진흥과”로 한다.",
  ]);
  assert.ok(decree.sentences.includes("① 미래산업국에 신성장산업과, 신재생에너지과, 이차전지산업과를 둔다."));

  const rule = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례 시행규칙", oldText: ruleText, newText: result.amended.ruleText, kind: "규칙" });
  // 이동한 과의 직급은 옛 국에서 빠지고 새 국으로 따라간다.
  assert.ok(rule.sentences.includes("제7조제1항 중 “회계과장ㆍ세무과장”을 “세무과장”으로 한다."));
  assert.ok(rule.sentences.includes("제2장에 제4절의2(제9조의2)를 다음과 같이 신설한다."));
  assert.ok(rule.sentences.some((line) => line.startsWith("제9조의2(미래산업국)") && line.includes("신성장산업과장은 지방행정사무관으로")));
  assert.ok(rule.sentences.includes("제10조제1항 중 “관광진흥과장ㆍ도시재생과장은”을 “관광진흥과장은”으로 한다."));
  assert.ok(rule.sentences.includes("제6조의3을 다음과 같이 신설한다."));
  // 개정문의 인용 문구는 그 조문 안에서 하나로 특정되어야 한다.
  assert.ok(rule.sentences.includes("제8조 중 “건설과장은 지방시설사무관으로”를 “건설과장은 지방시설사무관으로, 도시재생과장은 지방행정사무관 또는 지방시설사무관으로”로 한다."));
  assert.ok(result.todos.some((todo) => todo.includes("미래산업국장 분장사항")));
  assert.ok(result.todos.some((todo) => todo.includes("별표 1")));
});

test("국 폐지·담당관 폐지·직속기관 과 신설", () => {
  const target = edit(currentOutline, [
    ["      기후환경국\n        기후환경과\n        자원순환과\n        산림녹지과\n        수도과\n        하수과\n", ""],
    ["        신재생에너지과\n", "        신재생에너지과\n        기후환경과\n        자원순환과\n"],
    ["        토지정보과\n", "        토지정보과\n        산림녹지과\n        상하수도과\n"],
    ["    위생과\n", "    위생과\n    치매안심과\n"],
    ["      감사담당관 [보좌]\n", ""],
  ]);
  const result = draftAmendment({ decreeText, ruleText, target });
  assert.equal(result.verification.ok, true, result.verification.problems.join("\n"));
  const decree = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례", oldText: decreeText, newText: result.amended.decreeText });
  assert.ok(decree.sentences.includes("제3조 중 “복지교육국, 기후환경국”을 “복지교육국”으로 한다."));
  assert.ok(decree.sentences.includes("제4조 중 “감사담당관, 인구대응담당관”을 “인구대응담당관”으로 한다."));
  assert.ok(decree.sentences.includes("제11조를 삭제한다."));
  const rule = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례 시행규칙", oldText: ruleText, newText: result.amended.ruleText, kind: "규칙" });
  assert.ok(rule.sentences.includes("제5조를 삭제한다."));
  assert.ok(rule.sentences.includes("제2장제8절(제13조)를 삭제한다."));
  assert.ok(rule.sentences.some((line) => line.startsWith("제15조제1항 중 “위생과”를 “위생과, 치매안심과”로 하고, 같은 조 제2항 중")));
  // 같은 직급의 과는 한 구절로 묶는다.
  assert.ok(result.amended.ruleText.includes("기후환경과장ㆍ자원순환과장은 지방행정사무관ㆍ지방공업사무관 또는 지방환경사무관으로"));
  assert.ok(result.todos.some((todo) => todo.includes("상하수도과장")));
});

test("국 명칭 변경은 절 제목까지, 조문은 부분 개정으로 쓰고 개정문이 모든 변경을 덮는다", () => {
  const target = edit(currentOutline, [
    ["      문화관광국\n", "      문화체육관광국 (← 문화관광국)\n"],
    ["    새만금정책담당관 [보좌]\n", "    새만금정책담당관 [보좌]\n    미래전략담당관 [보좌]\n"],
    ["        세무과\n", "        세무회계과 (← 세무과)\n"],
    ["        회계과\n", ""],
  ]);
  const result = draftAmendment({ decreeText, ruleText, target });
  assert.equal(result.verification.ok, true, result.verification.problems.join("\n"));
  const decree = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례", oldText: decreeText, newText: result.amended.decreeText });
  assert.deepEqual(decree.uncovered, []);
  assert.ok(decree.sentences.includes("제5조제1항 중 “회계과, 세무과”를 “세무회계과”로 한다."));
  assert.ok(decree.sentences.includes("제8조의 제목 “문화관광국에 두는 과”를 “문화체육관광국에 두는 과”로 하고, 같은 조 제1항 중 “문화관광국에”를 “문화체육관광국에”로 하고, 같은 조 제2항 각 호 외의 부분 중 “문화관광국장은”을 “문화체육관광국장은”으로 한다."));
  const rule = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례 시행규칙", oldText: ruleText, newText: result.amended.ruleText, kind: "규칙" });
  assert.deepEqual(rule.uncovered, []);
  assert.ok(rule.sentences.includes("제2장제5절의 제목 “문화관광국”을 “문화체육관광국”으로 한다."));
  assert.ok(rule.sentences.includes("제10조의 제목 “문화관광국”을 “문화체육관광국”으로 한다."));
  // 시장 밑 담당관은 시장 밑 담당관 조문 바로 뒤에 둔다.
  assert.ok(rule.sentences.includes("제4조의2를 다음과 같이 신설한다."));
  assert.ok(rule.markdown.includes("제2장제5절") || rule.changes.some((change) => change.kind === "heading"));
});

test("개정문에 빠진 변경을 찾아낸다", async () => {
  const { uncoveredLines, compareArticles } = await import("../src/reorg-draft.mjs");
  const before = "제1장 총칙\n제1조(목적) 가.\n제2장 본청\n제1절 가국\n제2조(가국) 가과를 둔다.\n";
  const after = "제1장 총칙\n제1조(목적) 가.\n제2장 본청\n제1절 나국\n제2조(가국) 가과를 둔다.\n";
  const changes = compareArticles(before, after);
  assert.deepEqual(uncoveredLines(before, after, changes), []);
  assert.deepEqual(uncoveredLines(before, after, []), ["- 제1절 가국", "+ 제1절 나국"]);
});

test("개요의 들여쓰기·태그·옛이름을 읽고 오류를 알려준다", () => {
  const tree = parseOutline("시험시\n  시장\n    부시장\n      감사담당관\n      새국 (← 옛국)\n        가과\n  보건소 [소속]\n");
  const deputy = tree.children[0].children[0];
  assert.equal(deputy.children[0].type, "advisor");
  assert.equal(deputy.children[1].from, "옛국");
  assert.equal(tree.children[1].type, "affiliated");
  assert.throws(() => draftAmendment({ decreeText, ruleText, target: edit(currentOutline, [["    위생과\n", "    식품위생과 (← 없는과)\n"]]) }), /없는과/);
  assert.throws(() => parseOutline("시험시\n  시장\n  시장\n"), /같은 이름/);
});

test("조사는 받침과 숫자 읽기를 따른다", () => {
  assert.equal(particle("기획행정국", "을", "를"), "을");
  assert.equal(particle("세무과", "을", "를"), "를");
  assert.equal(particle("지방행정사무관", "으로", "로"), "으로");
  assert.equal(particle("식품위생과", "으로", "로"), "로");
  assert.equal(particle("[직급 작성 필요]", "으로", "로"), "로");
  assert.equal(particle("제6조의3", "을", "를"), "을");
  assert.equal(particle("제7조의2", "을", "를"), "를");
  assert.equal(particle("제7조의1", "으로", "로"), "로");
});

test("개정안 HWPX: 개정문과 밑줄 친 신구조문대비표 표", async () => {
  const result = draftAmendment({ decreeText, ruleText, target: reorganization });
  const doc = buildAmendmentDocument({ lawName: "군산시 행정기구 설치 조례", oldText: decreeText, newText: result.amended.decreeText });
  const bytes = await createAmendmentHwpxBytes({ title: doc.title, blocks: doc.blocks });
  const zip = await JSZip.loadAsync(bytes);
  const header = await zip.file("Contents/header.xml").async("string");
  const section = await zip.file("Contents/section0.xml").async("string");
  for (const tag of ["borderFill", "charPr", "paraPr"]) {
    const plural = { borderFill: "borderFills", charPr: "charProperties", paraPr: "paraProperties" }[tag];
    const declared = Number(header.match(new RegExp(`<hh:${plural} itemCnt="(\\d+)"`))[1]);
    assert.equal(declared, (header.match(new RegExp(`<hh:${tag} id=`, "g")) || []).length, `${plural} itemCnt`);
  }
  assert.match(section, /<hp:tbl [^>]*repeatHeader="1"[^>]*rowCnt="\d+" colCnt="2"/);
  assert.match(section, /<hp:pos treatAsChar="0"/, "표가 쪽을 넘겨 나뉘도록 글자처럼 취급하지 않는다");
  assert.match(header, /<hh:underline type="BOTTOM"/);
  assert.ok(section.includes("군산시 행정기구 설치 조례 일부를 다음과 같이 개정한다."));
  assert.ok(section.includes("[분장사무 작성 필요]"));

  const rhwp = [path.join(os.homedir(), ".local/bin/rhwp"), "rhwp"].find((candidate) => spawnSync(candidate, ["--version"]).status === 0);
  if (!rhwp) return;
  const dir = mkdtempSync(path.join(os.tmpdir(), "amendment-hwpx-"));
  try {
    const file = path.join(dir, "개정안.hwpx");
    writeFileSync(file, bytes);
    const info = spawnSync(rhwp, ["info", file], { encoding: "utf8" });
    assert.equal(info.status, 0, info.stderr);
    assert.ok(Number(info.stdout.match(/페이지 수:\s*(\d+)/)?.[1]) >= 2);
    const text = spawnSync(rhwp, ["export-text", file, "-o", path.join(dir, "out")], { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("스킬 draft 명령: 개편안 개요 → 개정안 HWPX·대비표·검증", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "orgchart-draft-"));
  try {
    const target = path.join(out, "개편안.txt");
    writeFileSync(target, reorganization);
    const run = spawnSync(process.execPath, [
      path.join(root, "skills", "korean-gov-orgchart", "scripts", "orgchart.mjs"),
      "draft",
      "--decree", path.join(gunsan, "군산시 행정기구 설치 조례.txt"),
      "--rule", path.join(gunsan, "군산시 행정기구 설치 조례 시행규칙.txt"),
      "--target", target,
      "--date", "2026-07-01",
      "--out", out,
    ], { encoding: "utf8", cwd: out });
    assert.equal(run.status, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.verification.ok, true);
    assert.equal(summary.files.amendments.length, 2);
    for (const file of [...summary.files.amendments, summary.files.chart, summary.files.comparison, summary.files.report]) {
      assert.ok(existsSync(file), file);
    }
    const report = readFileSync(summary.files.report, "utf8");
    assert.ok(report.includes("개편안 70개 기구와 모두 일치하고, 개정문이 바뀐 문언을 모두 담고 있습니다"));
    // 명칭 변경·이동은 대비표에서 점선 대응으로 그리고 폐지·신설로 표시하지 않는다.
    const sheets = summary.files.comparisonPreviews.map((file) => readFileSync(file.replace(/\.png$/, ".svg"), "utf8")).join("\n");
    const labels = [...sheets.matchAll(/>(신설|폐지|명칭변경|이동)</g)].map((match) => match[1]).sort();
    assert.deepEqual(labels, ["명칭변경", "명칭변경", "신설", "신설", "이동", "이동", "이동", "폐지"]);
    const chartTitle = readFileSync(summary.files.chartPreviews[0].replace(/\.png$/, ".svg"), "utf8");
    assert.ok(chartTitle.includes("개편안 · 2026. 7. 1. 시행 예정"));

    const tree = spawnSync(process.execPath, [
      path.join(root, "skills", "korean-gov-orgchart", "scripts", "orgchart.mjs"),
      "tree",
      "--decree", path.join(gunsan, "군산시 행정기구 설치 조례.txt"),
      "--rule", path.join(gunsan, "군산시 행정기구 설치 조례 시행규칙.txt"),
    ], { encoding: "utf8" });
    assert.equal(tree.status, 0, tree.stderr);
    assert.equal(tree.stdout, currentOutline);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
