import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HwpxReader } from "@ssabrojs/hwpxjs";
import JSZip from "jszip";
import { buildNativeComparisonWorkflow, buildNativeLawWorkflow } from "../src/native-law-workflow.mjs";
import { createNativeHwpxBytes } from "../src/render-native-hwpx.mjs";

const ordinance = `
제1조(목적) 이 조례는 「지방자치법」에 의하여 시험시에 두는 행정기구의 설치ㆍ조직을 규정함을 목적으로 한다.
제2조(국장 등) ① 시험시(이하 “시”라 한다) 본청의 국장의 직급 등은 규칙으로 정한다.
제2장 시 본 청
제3조(국의 설치) 시의 행정사무를 분장하기 위하여 기획행정국, 안전건설국을 둔다.
제4조(보좌기관) 시장 밑에 새만금정책담당관, 부시장 밑에 감사담당관을 둔다.
제5조(기획행정국에 두는 과)
① 기획행정국에 기획예산과, 행정지원과를 둔다.
제6조(안전건설국에 두는 과)
① 안전건설국에 안전총괄과, 도시계획과를 둔다.
`;

async function unpack(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  return {
    zip,
    header: await zip.file("Contents/header.xml").async("string"),
    section: await zip.file("Contents/section0.xml").async("string"),
  };
}

function count(xml, pattern) {
  return (xml.match(pattern) || []).length;
}

test("세로 조직도 명세를 한글 없이 편집형 HWPX로 직접 쓴다", async () => {
  const workflow = buildNativeLawWorkflow({ decreeText: ordinance, asOf: "2026-01-23" });
  const bytes = await createNativeHwpxBytes(workflow.manifests);
  const { zip, header, section } = await unpack(bytes);

  assert.equal(await zip.file("mimetype").async("string"), "application/hwp+zip");
  assert.equal(Object.keys(zip.files)[0], "mimetype");

  const objects = workflow.manifests.flatMap((manifest) => manifest.objects);
  const rects = objects.filter((object) => object.type !== "line").length;
  const lines = objects.filter((object) => object.type === "line").length;
  assert.equal(count(section, /<hp:rect /g), rects);
  assert.equal(count(section, /<hp:line /g), lines);
  assert.equal(count(section, /<hp:drawText /g), objects.filter((object) => object.type === "textbox").length);
  assert.equal(count(section, /pageBreak="1"/g), workflow.manifests.length - 1);

  // A4 세로: Hangul stores portrait as WIDELY with width < height.
  assert.match(section, /<hp:pagePr landscape="WIDELY" width="59528" height="84189"/);

  // Every style reference resolves and itemCnt matches the definitions.
  const charIds = new Set([...header.matchAll(/<hh:charPr id="(\d+)"/g)].map((match) => match[1]));
  const paraIds = new Set([...header.matchAll(/<hh:paraPr id="(\d+)"/g)].map((match) => match[1]));
  for (const [, id] of section.matchAll(/charPrIDRef="(\d+)"/g)) assert.ok(charIds.has(id), `charPr ${id}`);
  for (const [, id] of section.matchAll(/paraPrIDRef="(\d+)"/g)) assert.ok(paraIds.has(id), `paraPr ${id}`);
  assert.equal(Number(header.match(/<hh:charProperties itemCnt="(\d+)"/)[1]), charIds.size);
  assert.equal(Number(header.match(/<hh:paraProperties itemCnt="(\d+)"/)[1]), paraIds.size);

  // Bold advisor-free hierarchy survives as character shapes.
  const bold12 = [...header.matchAll(/<hh:charPr id="\d+" height="1200"[^>]*>.*?<\/hh:charPr>/gs)];
  assert.ok(bold12.some(([xml]) => xml.includes("<hh:bold/>")), "시장 12pt 굵게");

  const reader = new HwpxReader();
  await reader.loadFromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const text = await reader.extractText();
  for (const label of ["시장", "부시장", "새만금정책담당관", "기획행정국", "도시계획과", "2026. 1. 23. 현재"]) {
    assert.ok(text.includes(label), label);
  }
});

test("A3 가로 다단 대비표는 세로 치수와 NARROWLY 표식으로 저장한다", async () => {
  const after = ordinance.replace("행정지원과를", "행정지원과, AI행정과를");
  const workflow = buildNativeComparisonWorkflow({
    stages: [
      { decreeText: ordinance, asOf: "2026-01-23" },
      { decreeText: ordinance, asOf: "2026-04-01" },
      { decreeText: after, asOf: "2026-07-01" },
    ],
  });
  assert.equal(workflow.manifests[0].page.orientation, "landscape");
  const { section } = await unpack(await createNativeHwpxBytes(workflow.manifests));
  assert.match(section, /<hp:pagePr landscape="NARROWLY" width="84189" height="119055"/);
  assert.ok(section.includes("AI행정과"));
});

const RHWP = [process.env.RHWP_BIN, path.join(os.homedir(), ".local/bin/rhwp")].find((candidate) => candidate && existsSync(candidate));
const maybe = RHWP ? test : (name, fn) => test.skip(`${name} (rhwp 없음 — RHWP_BIN으로 지정 가능)`, fn);

maybe("rhwp가 직접 쓴 HWPX를 쪽 수·문구 그대로 다시 읽고 HWP로도 변환한다", async () => {
  const workflow = buildNativeLawWorkflow({ decreeText: ordinance, asOf: "2026-01-23" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-hwpx-"));
  try {
    const file = path.join(dir, "chart.hwpx");
    writeFileSync(file, await createNativeHwpxBytes(workflow.manifests));
    const verify = spawnSync(RHWP, ["verify", file, "--expect-pages", String(workflow.manifests.length), "--expect-contains", "기획행정국", "--expect-format", "hwpx"], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    const convert = spawnSync(RHWP, ["convert", file, path.join(dir, "chart.hwp"), "--verify", "--verify-pages"], { encoding: "utf8" });
    assert.equal(convert.status, 0, convert.stdout + convert.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
