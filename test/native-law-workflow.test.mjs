import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNativeManifest } from "../desktop/ui/manifest-validation.js";
import { buildNativeComparisonWorkflow, buildNativeLawWorkflow } from "../src/native-law-workflow.mjs";

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

test("24개 전체 조직은 개요·소속기관과 본부 하부조직 두 쪽으로 나뉜다", () => {
  const departmentClauses = Array.from(
    { length: 20 },
    (_, index) => `대형정책실장 밑에 제${index + 1}정책과를 둔다.`,
  ).join("\n");
  const workflow = buildNativeLawWorkflow({
    decreeText: `대형시험부와 그 소속기관 직제
제1조(하부조직) 대형시험부에 대형정책실을 둔다.
제2조(소속기관) 대형시험부 소속으로 지역사무소를 둔다.
${departmentClauses}`,
    institution: "대형시험부",
  });

  assert.equal(workflow.summary.nodeCount, 24);
  assert.equal(workflow.summary.pageCount, 2);
  assert.deepEqual(workflow.pages.map((page) => page.label), ["본부 기구 개요 · 소속기관", "본부 하부조직"]);
  assert.deepEqual(
    workflow.manifests.map((manifest) => manifest.objects.find((object) => object.id === "document-page")?.text),
    ["1 / 2", "2 / 2"],
  );
  assert.ok(workflow.manifests.every((manifest) => analyzeNativeManifest(manifest).valid));
});
test("좌우 2단 대비표는 조직 상자를 좌측 열에 제한하고 우측 대비 영역을 예약한다", () => {
  const workflow = buildNativeLawWorkflow({
    decreeText: decree,
    ruleText: rule,
    layout: "comparison-two-column",
  });
  const manifest = workflow.manifests[0];
  const nodeBoxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node");
  const divider = manifest.objects.find((object) => object.id === "comparison-divider");
  const header = manifest.objects.find((object) => object.id === "comparison-header");

  assert.equal(manifest.source.layout, "comparison-two-column");
  assert.ok(nodeBoxes.length > 0);
  assert.ok(nodeBoxes.every((object) => object.geometry.x + object.geometry.width <= 97.001));
  assert.ok(Math.max(...nodeBoxes.map((object) => object.geometry.width)) < 90);
  assert.equal(divider.geometry.x1, 104);
  assert.equal(divider.geometry.x2, 104);
  assert.equal(header.text, "개편 전·후 대비");
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

const afterDecree = `
시험행정부와 그 소속기관 직제
제2조(소속기관) 시험행정부장관 소속으로 국가시험연구원을 둔다.
제4조(하부조직) 시험행정부에 인공지능정부실 및 참여혁신조직실을 둔다.
제5조(인공지능정부실) 인공지능정부실에 인공지능정책국 및 공공데이터국을 둔다.
제6조(참여혁신조직실) 참여혁신조직실에 참여혁신국 및 조직국을 둔다.
`;

const afterRule = `
시험행정부와 그 소속기관 직제 시행규칙
제3조(인공지능정부실) 인공지능정책국에 인공지능정책과ㆍ공공서비스혁신과를 두고, 공공데이터국에 데이터정책과ㆍ데이터분석과를 둔다.
제4조(참여혁신조직실) 참여혁신국에 혁신기획과ㆍ국민참여정책과를 두고, 조직국에 조직기획과ㆍ조직진단과를 둔다.
`;

test("두 시점 조직도를 좌우에 각각 그린다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: { decreeText: decree, ruleText: rule, asOf: "2024-12-31" },
    after: { decreeText: afterDecree, ruleText: afterRule, asOf: "2026-07-21" },
  });
  const manifest = workflow.manifests[0];
  const beforeBoxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node" && object.metadata?.side === "before");
  const afterBoxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node" && object.metadata?.side === "after");
  const divider = manifest.objects.find((object) => object.id === "comparison-divider");

  assert.equal(workflow.summary.layout, "comparison-two-column");
  assert.equal(workflow.summary.comparison, "dual-outline");
  assert.ok(beforeBoxes.some((object) => object.text === "디지털정부실"));
  assert.ok(afterBoxes.some((object) => object.text === "인공지능정부실"));
  assert.ok(beforeBoxes.every((object) => object.geometry.x + object.geometry.width <= 99.001));
  assert.ok(afterBoxes.every((object) => object.geometry.x >= 109));
  assert.equal(divider.geometry.x1, 104);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("저장된 스냅샷 두 개로도 좌우 조직도를 복원한다", () => {
  const before = buildNativeLawWorkflow({ decreeText: decree, ruleText: rule, asOf: "2024-12-31" });
  const after = buildNativeLawWorkflow({ decreeText: afterDecree, ruleText: afterRule, asOf: "2026-07-21" });
  const workflow = buildNativeComparisonWorkflow({
    beforeSnapshot: before.snapshot,
    afterSnapshot: after.snapshot,
    focus: "디지털정부실, 인공지능정부실",
  });
  const manifest = workflow.manifests[0];
  const texts = manifest.objects
    .filter((object) => object.metadata?.role === "organization-node")
    .map((object) => object.text);

  assert.ok(texts.includes("디지털정부실"));
  assert.ok(texts.includes("인공지능정부실"));
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("좌우 조직도 아래 호 분할은 갈라진 과를 모두 표시한다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: {
      decreeText: `시험부와 그 소속기관 직제\n제2조(하부조직) 시험부에 디지털정부실을 둔다.\n디지털정부실에 디지털정책과를 둔다.`,
      ruleText: `시험부와 그 소속기관 직제 시행규칙\n제3조(디지털정부실)\n① 디지털정책과장은 직제 제10조제3항제1호부터 제10호까지의 사항을 분장한다.`,
      asOf: "2024-12-31",
    },
    after: {
      decreeText: `시험부와 그 소속기관 직제\n제2조(하부조직) 시험부에 인공지능정부실을 둔다.\n인공지능정부실에 인공지능정책과ㆍ데이터정책과를 둔다.`,
      ruleText: `시험부와 그 소속기관 직제 시행규칙\n제3조(인공지능정부실)\n① 인공지능정책과장은 직제 제10조제3항제1호부터 제4호까지의 사항을 분장한다.\n② 데이터정책과장은 직제 제10조제3항제5호부터 제10호까지의 사항을 분장한다.`,
      asOf: "2026-07-21",
    },
  });
  const manifest = workflow.manifests[0];
  const line = manifest.objects.find((object) => object.metadata?.role === "allocation-line");
  const badge = manifest.objects.find((object) => object.metadata?.role === "allocation-badge");
  assert.equal(workflow.summary.dutyAllocation.notable.length, 1);
  assert.match(line.text, /40% → 인공지능정책과/);
  assert.match(line.text, /60% → 데이터정책과/);
  assert.match(badge.text, /40%→인공지능정책과/);
  assert.match(badge.text, /60%→데이터정책과/);
  assert.ok(badge.geometry.x >= 70);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("시행규칙에서 소관 과가 확인된 관은 국처럼 과를 하위 계선으로 묶는다", () => {
  const workflow = buildNativeLawWorkflow({
    decreeText: `
과학기술정보통신부와 그 소속기관 직제
제10조(연구개발정책실) 연구개발정책실장 밑에 기초원천연구정책관ㆍ미래인재정책관 및 공공융합연구정책관을 둔다.
`,
    ruleText: `
과학기술정보통신부와 그 소속기관 직제 시행규칙
제8조(연구개발정책실) 연구개발정책실에 기초연구진흥과ㆍ원천기술과ㆍ미래인재정책과 및 공공기술과를 둔다.
① 기초연구진흥과장은 다음 사항을 분장한다.
1. 기초연구 정책 총괄
2. 그 밖에 기초원천연구정책관 내 다른 과의 주관에 속하지 않는 사항
② 원천기술과장은 다음 사항을 분장한다.
1. 원천기술 개발 지원
③ 미래인재정책과장은 다음 사항을 분장한다.
1. 그 밖에 미래인재정책관 내 다른 과의 주관에 속하지 않는 사항
④ 공공기술과장은 다음 사항을 분장한다.
1. 그 밖에 공공융합연구정책관 내 다른 과의 주관에 속하지 않는 사항
`,
    institution: "과학기술정보통신부",
  });
  const manifest = workflow.manifests[0];
  const boxes = new Map(
    manifest.objects
      .filter((object) => object.metadata?.role === "organization-node")
      .map((object) => [object.text, object]),
  );
  const policyOfficer = boxes.get("기초원천연구정책관");
  const firstDepartment = boxes.get("기초연구진흥과");
  const inferredDepartment = boxes.get("원천기술과");
  const nextPolicyOfficer = boxes.get("미래인재정책관");
  const links = manifest.objects.filter((object) => object.metadata?.role === "child-link");

  assert.equal(manifest.source.renderView, "operational");
  assert.equal(policyOfficer.metadata.renderRole, "jurisdiction-container");
  assert.equal(policyOfficer.style.fill, "#E3F1EF");
  assert.equal(policyOfficer.style.stroke, "#477D78");
  assert.equal(policyOfficer.style.dash, "solid");
  assert.ok(policyOfficer.geometry.y < firstDepartment.geometry.y);
  assert.ok(firstDepartment.geometry.y < inferredDepartment.geometry.y);
  assert.ok(inferredDepartment.geometry.y < nextPolicyOfficer.geometry.y);
  assert.ok(links.some((line) => (
    line.metadata.parentId === policyOfficer.id
      && line.metadata.childId === firstDepartment.id
      && line.style.dash === "solid"
  )));
  assert.ok(links.some((line) => (
    line.metadata.parentId === policyOfficer.id
      && line.metadata.childId === inferredDepartment.id
      && line.style.dash === "solid"
  )));
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});
