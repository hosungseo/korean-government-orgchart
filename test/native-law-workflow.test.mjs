import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNativeManifest } from "../desktop/ui/manifest-validation.js";
import { buildNativeLawWorkflow } from "../src/native-law-workflow.mjs";

const decree = `
시험행정부와 그 소속기관 직제
제2조(소속기관) 시험행정부장관 소속으로 국가시험연구원을 둔다.
제4조(하부조직) 시험행정부에 디지털정부실 및 참여혁신실을 둔다.
제5조(디지털정부실) 디지털정부실에 인공지능정책국 및 공공데이터국을 둔다.
제6조(참여혁신실) 참여혁신실에 참여혁신국 및 조직국을 둔다.
`;

const rule = `
시험행정부와 그 소속기관 직제 시행규칙
제3조(디지털정부실) 인공지능정책국에 인공지능정책과ㆍ공공서비스혁신과를 두고, 공공데이터국에 데이터정책과ㆍ데이터분석과를 둔다.
제4조(참여혁신실) 참여혁신국에 혁신기획과ㆍ국민참여정책과를 두고, 조직국에 조직기획과ㆍ조직진단과를 둔다.
`;

test("직제와 시행규칙 문언을 Windows용 네이티브 HWPX 명세로 바로 연결한다", () => {
  const workflow = buildNativeLawWorkflow({ decreeText: decree, ruleText: rule, asOf: "2026-08-13" });

  assert.equal(workflow.summary.institution, "시험행정부");
  assert.equal(workflow.summary.decreePresent, true);
  assert.equal(workflow.summary.rulePresent, true);
  assert.ok(workflow.summary.nodeCount >= 13);
  assert.ok(workflow.manifests.length >= 1);
  for (const manifest of workflow.manifests) {
    const report = analyzeNativeManifest(manifest);
    assert.equal(report.valid, true);
    assert.equal(report.summary.connectionWarnings, 0);
    assert.equal(manifest.page.paper, "A4");
    assert.equal(manifest.verification.expectedPageCount, 1);
  }
});

test("여러 실을 작도 범위로 지정하면 한 장의 정확한 계선 트리로 묶는다", () => {
  const workflow = buildNativeLawWorkflow({
    decreeText: decree,
    ruleText: rule,
    focus: "디지털정부실, 참여혁신실",
  });
  const manifest = workflow.manifests[0];
  const byId = new Map(manifest.objects.map((object) => [object.id, object]));
  const childLinks = manifest.objects.filter((object) => object.type === "line" && object.metadata?.childId);

  assert.equal(workflow.manifests.length, 1);
  assert.ok(manifest.objects.some((object) => object.type === "textbox" && object.text === "디지털정부실"));
  assert.ok(manifest.objects.some((object) => object.type === "textbox" && object.text === "참여혁신실"));
  assert.ok(childLinks.length >= 8);
  for (const line of childLinks) {
    const child = byId.get(line.metadata.childId);
    assert.ok(child, `${line.id}의 자식 상자가 있어야 합니다.`);
    assert.ok(line.geometry.x2 > child.geometry.x);
    assert.ok(line.geometry.x2 < child.geometry.x + 1);
    assert.ok(Math.abs(line.geometry.y2 - (child.geometry.y + child.geometry.height / 2)) < 0.001);
  }
});

test("한쪽 법령이 빠지면 생성은 유지하되 자료 누락을 경고한다", () => {
  const decreeOnly = buildNativeLawWorkflow({ decreeText: decree });
  const ruleOnly = buildNativeLawWorkflow({ ruleText: rule, institution: "시험행정부" });

  assert.ok(decreeOnly.summary.warnings.some((warning) => warning.includes("시행규칙")));
  assert.ok(ruleOnly.summary.warnings.some((warning) => warning.includes("직제 본문")));
  assert.throws(
    () => buildNativeLawWorkflow({ decreeText: decree, focus: "없는실" }),
    /작도 범위를 찾지 못했습니다/,
  );
});

test("대형 조직은 작은 글씨로 압축하지 않고 읽을 수 있는 A4 여러 쪽으로 분할한다", () => {
  const departmentClauses = Array.from(
    { length: 70 },
    (_, index) => `대형정책실에 제${index + 1}정책과를 둔다.`,
  ).join("\n");
  const workflow = buildNativeLawWorkflow({
    decreeText: `대형시험부 직제\n제2조(하부조직) 대형시험부에 대형정책실을 둔다.\n${departmentClauses}`,
    institution: "대형시험부",
    focus: "대형정책실",
  });

  assert.ok(workflow.manifests.length > 1);
  assert.ok(workflow.pages.every((page) => page.nodeCount <= 38));
  assert.ok(workflow.summary.warnings.some((warning) => warning.includes("자동 분할")));
  assert.ok(workflow.manifests.every((manifest) => analyzeNativeManifest(manifest).valid));
});
