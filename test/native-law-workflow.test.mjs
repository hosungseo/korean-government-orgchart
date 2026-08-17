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

test("두 개편을 한 장의 위아래 대역으로 합친다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: { decreeText: decree, ruleText: rule, asOf: "2024-12-31" },
    after: { decreeText: afterDecree, ruleText: afterRule, asOf: "2026-07-21" },
    focus: "디지털정부실, 참여혁신실, 인공지능정부실, 참여혁신조직실",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const boxes = Object.fromEntries(
    manifest.objects
      .filter((object) => object.metadata?.role === "organization-node")
      .map((object) => [object.metadata.nodeName, object]),
  );
  const bands = manifest.objects.filter((object) => object.metadata?.role === "comparison-band");

  assert.equal(workflow.summary.pageCount, 1);
  assert.equal(workflow.summary.comparison, "dual-outline-bands");
  assert.equal(workflow.manifests.length, 1);
  assert.ok(boxes["디지털정부실"]);
  assert.ok(boxes["참여혁신실"]);
  assert.ok(boxes["인공지능정부실"]);
  assert.ok(boxes["참여혁신조직실"]);
  assert.ok(boxes["디지털정부실"].geometry.y < boxes["참여혁신실"].geometry.y);
  assert.ok(boxes["인공지능정부실"].geometry.y < boxes["참여혁신조직실"].geometry.y);
  assert.ok(Math.abs(boxes["디지털정부실"].geometry.y - boxes["인공지능정부실"].geometry.y) < 8);
  assert.ok(Math.abs(boxes["참여혁신실"].geometry.y - boxes["참여혁신조직실"].geometry.y) < 20);
  assert.equal(bands.length, 2);
  assert.equal(boxes["디지털정부실"].style.fill, "#FFF4A3");
  assert.equal(boxes["참여혁신조직실"].style.fill, "#FFF4A3");
  assert.equal(boxes["조직국"].style.fill, "#DFF2E3");
  assert.ok(
    manifest.objects
      .filter((object) => object.metadata?.role === "organization-node" && /과$/.test(object.metadata.nodeName))
      .every((object) => object.style.fill === "#FFFFFF"),
  );
  const beforeByName = Object.fromEntries(
    manifest.objects
      .filter((object) => object.metadata?.role === "organization-node" && object.metadata.side === "before")
      .map((object) => [object.metadata.nodeName, object]),
  );
  assert.ok(beforeByName["인공지능정책과"].geometry.y < beforeByName["공공서비스혁신과"].geometry.y);
  assert.ok(beforeByName["조직기획과"].geometry.y < beforeByName["조직진단과"].geometry.y);
  const links = manifest.objects.filter((object) => object.metadata?.role === "correspondence-link");
  const wraps = manifest.objects.filter((object) => object.metadata?.role === "correspondence-wrap");
  assert.equal(wraps.some((object) => object.metadata.unit === "디지털정부실"), false);
  assert.equal(wraps.some((object) => object.metadata.unit === "조직국"), false);
  assert.ok(links.every((object) => object.style.color !== "#64748B"));
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("좌우 대비 연결선은 변화한 과만 다른 색으로 잇는다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: {
      institution: "시험부",
      asOf: "2025-10-01",
      decreeText: `시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 디지털정부혁신실 및 조직국을 둔다.
제3조(디지털정부혁신실) 디지털정부혁신실에 정부혁신국을 둔다.`,
      ruleText: `시험부와 그 소속기관 직제 시행규칙
제3조(디지털정부혁신실) 정부혁신국에 혁신기획과 및 정보공개과를 둔다.
제4조(조직국) 조직국에 조직기획과를 둔다.`,
    },
    after: {
      institution: "시험부",
      asOf: "2026-07-21",
      decreeText: `시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 인공지능정부실 및 참여혁신조직실을 둔다.
제3조(참여혁신조직실) 참여혁신조직실에 참여혁신국 및 조직국을 둔다.`,
      ruleText: `시험부와 그 소속기관 직제 시행규칙
제3조(참여혁신조직실) 참여혁신국에 혁신기획과 및 정보공개제도과를 두고, 조직국에 조직기획과를 둔다.`,
    },
    focus: "디지털정부혁신실, 조직국, 인공지능정부실, 참여혁신조직실",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const wraps = manifest.objects.filter((object) => object.metadata?.role === "correspondence-wrap");
  const linkColors = [...new Set(
    manifest.objects
      .filter((object) => object.metadata?.role === "correspondence-link")
      .map((object) => object.style.color),
  )];
  assert.equal(wraps.some((object) => object.metadata.unit === "혁신기획과"), false);
  assert.ok(wraps.some((object) => object.metadata.unit === "정보공개과"));
  assert.ok(wraps.some((object) => object.metadata.unit === "정보공개제도과"));
  assert.equal(wraps.some((object) => object.metadata.unit === "조직기획과"), false);
  assert.equal(wraps.some((object) => object.metadata.unit === "조직국"), false);
  const strokes = [...new Set(
    manifest.objects
      .filter((object) => object.metadata?.role === "correspondence-link")
      .map((object) => object.style.stroke),
  )];
  const spines = manifest.objects.filter((object) => /spine$/.test(object.id));
  assert.ok(linkColors.length >= 1);
  assert.ok(linkColors.every((color) => color !== "#64748B" && color !== "#4A6F8C"));
  assert.ok(strokes.length >= 1);
  assert.ok(strokes.every((color) => color !== "#64748B"));
  assert.ok(spines.length >= 1);
  assert.ok(manifest.objects.some((object) => object.metadata?.role === "correspondence-underlay"));
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("같은 이름의 과가 존속하면 이후 개편용 분할 매핑보다 exact-name을 우선한다", () => {
  const before = {
    institution: "시험문화부",
    asOf: "2024-02-05",
    decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 미디어정책국을 둔다.`,
    ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(미디어정책국) 미디어정책국에 미디어정책과ㆍ방송영상광고과 및 출판인쇄독서진흥과를 둔다.
① 미디어정책과장은 다음 사항을 분장한다.
1. 미디어 정책 총괄
② 방송영상광고과장은 다음 사항을 분장한다.
1. 방송영상 산업 지원
2. 광고 산업 진흥`,
  };
  const after = {
    ...before,
    asOf: "2024-02-06",
    ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(미디어정책국) 미디어정책국에 미디어정책과ㆍ방송영상광고과 및 출판인쇄독서진흥과를 둔다.
① 미디어정책과장은 다음 사항을 분장한다.
1. 미디어 정책 총괄
2. 방송영상 산업 지원
3. 광고 산업 진흥
② 방송영상광고과장은 다음 사항을 분장한다.
1. 방송광고 유통질서 조사`,
  };
  const workflow = buildNativeComparisonWorkflow({
    before,
    after,
    focus: "미디어정책국",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const boxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node");
  const wraps = manifest.objects.filter((object) => object.metadata?.role === "correspondence-wrap");
  const links = manifest.objects.filter((object) => object.metadata?.role === "correspondence-link");
  const status = manifest.objects.filter((object) => object.metadata?.role === "status-label");

  assert.equal(boxes.filter((object) => object.metadata.nodeName === "방송영상광고과").length, 2);
  assert.equal(wraps.some((object) => object.metadata.unit === "방송영상광고과"), false);
  assert.equal(wraps.some((object) => object.metadata.unit === "미디어정책과"), false);
  assert.equal(links.length, 0);
  assert.equal(status.length, 0);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("구버전 기능 카탈로그만 남은 이력은 자동 기능 점선을 만들지 않는다", () => {
  const originalBefore = buildNativeLawWorkflow({
    ruleText: `시험부 직제 시행규칙
제5조(녹색문화실) 녹색문화실에 기후문화정책과를 둔다.
① 기후문화정책과장은 다음 사항을 분장한다.
1. 녹색문화 종합계획 수립
2. 녹색문화 사업 지원`,
    institution: "시험부",
    asOf: "2025-01-01",
  }).snapshot;
  const originalAfter = buildNativeLawWorkflow({
    ruleText: `시험부 직제 시행규칙
제5조(녹색문화실) 녹색문화실에 녹색문화기획과를 둔다.
① 녹색문화기획과장은 다음 사항을 분장한다.
1. 녹색문화 종합계획 수립
2. 녹색문화 사업 지원`,
    institution: "시험부",
    asOf: "2026-01-01",
  }).snapshot;
  for (const snapshot of [originalBefore, originalAfter]) {
    snapshot.laws = [];
    delete snapshot.graph.meta.parserVersion;
    delete snapshot.graph.meta.dutyEvidenceQuality;
  }

  const workflow = buildNativeComparisonWorkflow({
    beforeSnapshot: originalBefore,
    afterSnapshot: originalAfter,
    focus: "녹색문화실",
  });
  const functionLinks = workflow.manifests[0].objects.filter((object) => (
    object.metadata?.role === "correspondence-link"
      && object.metadata?.basis === "duty-function"
  ));
  assert.equal(workflow.summary.dutyLineage.automaticEligible, false);
  assert.equal(functionLinks.length, 0);
});

test("개정문이 같은 과명을 다른 전신에 재사용하면 문체부 명시 개명을 우선한다", () => {
  const before = {
    institution: "시험문화부",
    asOf: "2025-12-30",
    decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 문화미디어산업실을 둔다.
제3조(문화미디어산업실) 문화미디어산업실 밑에 문화산업정책관을 둔다.`,
    ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(문화미디어산업실) 문화산업정책관에 문화산업정책과 및 문화산업기반과를 둔다.`,
  };
  const after = {
    institution: "시험문화부",
    asOf: "2026-07-28",
    decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 문화미디어산업실을 둔다.
제3조(문화미디어산업실) 문화미디어산업실 밑에 콘텐츠산업정책관 및 문화산업미디어정책관을 둔다.`,
    ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(문화미디어산업실) 콘텐츠산업정책관에 콘텐츠산업정책과를 두고, 문화산업미디어정책관에 문화산업정책과를 둔다.`,
  };
  const workflow = buildNativeComparisonWorkflow({
    before,
    after,
    focus: "문화미디어산업실",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const afterWraps = manifest.objects.filter(
    (object) => object.metadata?.role === "correspondence-wrap" && object.metadata.side === "after",
  );
  const byUnit = new Map(afterWraps.map((object) => [object.metadata.unit, object.metadata.from]));
  const status = manifest.objects.filter((object) => object.metadata?.role === "status-label");

  assert.equal(byUnit.get("콘텐츠산업정책과"), "문화산업정책과");
  assert.equal(byUnit.get("문화산업정책과"), "문화산업기반과");
  assert.equal(status.some((object) => object.metadata.unit === "콘텐츠산업정책과"), false);
  assert.equal(status.some((object) => object.metadata.unit === "문화산업정책과"), false);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("해외문화홍보원 기획운영과는 해외홍보기획과의 전신으로 연결한다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: {
      institution: "시험문화부",
      asOf: "2024-02-05",
      decreeText: `시험문화부와 그 소속기관 직제
제2조(소속기관) 시험문화부장관 소속으로 해외문화홍보원을 둔다.`,
      ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(해외문화홍보원) 해외문화홍보원에 기획운영과 및 해외문화홍보콘텐츠과를 둔다.`,
    },
    after: {
      institution: "시험문화부",
      asOf: "2024-02-06",
      decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 국제문화홍보정책실을 둔다.
제3조(국제문화홍보정책실) 국제문화홍보정책실 밑에 해외홍보정책관을 둔다.`,
      ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(국제문화홍보정책실) 해외홍보정책관에 해외홍보기획과 및 해외홍보콘텐츠과를 둔다.`,
    },
    focus: "해외문화홍보원, 국제문화홍보정책실",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const afterWrap = manifest.objects.find(
    (object) => object.metadata?.role === "correspondence-wrap"
      && object.metadata.side === "after"
      && object.metadata.unit === "해외홍보기획과",
  );
  const status = manifest.objects.filter((object) => object.metadata?.role === "status-label");

  assert.equal(afterWrap?.metadata.from, "기획운영과");
  assert.equal(status.some((object) => object.metadata.unit === "해외홍보기획과"), false);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

const midDecree = `
시험행정부와 그 소속기관 직제
제4조(하부조직) 시험행정부에 인공지능정부실 및 참여혁신실을 둔다.
제5조(인공지능정부실) 인공지능정부실에 인공지능정책국을 둔다.
제6조(참여혁신실) 참여혁신실에 참여혁신국 및 조직국을 둔다.
`;

const midRule = `
시험행정부와 그 소속기관 직제 시행규칙
제3조(인공지능정부실) 인공지능정책국에 인공지능정책과를 둔다.
제4조(참여혁신실) 참여혁신국에 혁신기획과를 두고, 조직국에 조직기획과를 둔다.
`;

test("세 시점은 A3 가로 3단으로 작도한다", () => {
  const workflow = buildNativeComparisonWorkflow({
    stages: [
      { decreeText: decree, ruleText: rule, asOf: "2025-10-01" },
      { decreeText: midDecree, ruleText: midRule, asOf: "2025-11-25" },
      { decreeText: afterDecree, ruleText: afterRule, asOf: "2026-07-21" },
    ],
    focus: "디지털정부실, 인공지능정부실, 참여혁신실, 참여혁신조직실, 조직국",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const headers = manifest.objects.filter((object) => object.metadata?.role === "comparison-header");
  assert.equal(workflow.summary.columns, 3);
  assert.equal(workflow.summary.paper, "A3");
  assert.equal(workflow.summary.layout, "comparison-multi-column");
  assert.equal(manifest.page.paper, "A3");
  assert.equal(manifest.page.orientation, "landscape");
  assert.equal(manifest.page.widthMm, 420);
  assert.equal(manifest.page.heightMm, 297);
  assert.equal(headers.length, 3);
  assert.ok(manifest.objects.some((object) => object.metadata?.nodeName === "디지털정부실"));
  assert.ok(manifest.objects.some((object) => object.metadata?.nodeName === "인공지능정부실"));
  assert.ok(manifest.objects.filter((object) => object.metadata?.role === "comparison-divider").length >= 2);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

const lateRule = `
시험행정부와 그 소속기관 직제 시행규칙
제3조(인공지능정부실) 인공지능정책국에 인공지능정책과ㆍ공공서비스혁신과를 두고, 공공데이터국에 데이터정책과ㆍ데이터분석과를 둔다.
제4조(참여혁신조직실) 참여혁신국에 혁신기획과ㆍ국민참여정책과를 두고, 조직국에 조직기획과ㆍ조직진단과ㆍ법사조직과를 둔다.
`;

test("네 시점은 A3 가로 4단으로 작도한다", () => {
  const workflow = buildNativeComparisonWorkflow({
    stages: [
      { decreeText: decree, ruleText: rule, asOf: "2025-10-01" },
      { decreeText: midDecree, ruleText: midRule, asOf: "2025-11-25" },
      { decreeText: afterDecree, ruleText: afterRule, asOf: "2026-01-01" },
      { decreeText: afterDecree, ruleText: lateRule, asOf: "2026-07-21" },
    ],
    focus: "디지털정부실, 인공지능정부실, 참여혁신실, 참여혁신조직실, 조직국",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const headers = manifest.objects.filter((object) => object.metadata?.role === "comparison-header");
  const boxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node");
  assert.equal(workflow.summary.columns, 4);
  assert.equal(workflow.summary.paper, "A3");
  assert.equal(manifest.page.paper, "A3");
  assert.equal(manifest.page.widthMm, 420);
  assert.equal(headers.length, 4);
  assert.ok(boxes.some((object) => object.text === "디지털정부실"));
  assert.ok(boxes.some((object) => object.text === "참여혁신조직실"));
  assert.ok(boxes.some((object) => object.text === "법사조직과"));
  assert.equal(manifest.objects.filter((object) => object.metadata?.role === "comparison-divider").length, 3);
  assert.ok(boxes.every((object) => object.geometry.x + object.geometry.width <= 408.001));
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("범용 4단 비교는 문화·미디어와 관광 대역을 자동 구성한다", () => {
  const stages = [
    {
      asOf: "2024-02-05",
      decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 콘텐츠정책국ㆍ미디어정책국ㆍ저작권국 및 관광정책국을 둔다.`,
      ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(콘텐츠정책국) 콘텐츠정책국에 콘텐츠정책과를 둔다.
제4조(미디어정책국) 미디어정책국에 미디어정책과를 둔다.
제5조(저작권국) 저작권국에 저작권정책과를 둔다.
제6조(관광정책국) 관광정책국에 관광정책과를 둔다.`,
    },
    {
      asOf: "2024-02-06",
      decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 국제문화홍보정책실ㆍ콘텐츠정책국ㆍ미디어정책국ㆍ저작권국 및 관광정책국을 둔다.
제3조(국제문화홍보정책실) 국제문화홍보정책실에 국제문화정책관을 둔다.`,
      ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(국제문화홍보정책실) 국제문화정책관에 국제문화정책과를 둔다.
제4조(콘텐츠정책국) 콘텐츠정책국에 콘텐츠정책과를 둔다.
제5조(미디어정책국) 미디어정책국에 미디어정책과를 둔다.
제6조(저작권국) 저작권국에 저작권정책과를 둔다.
제7조(관광정책국) 관광정책국에 관광정책과를 둔다.`,
    },
    {
      asOf: "2025-12-30",
      decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 문화미디어산업실 및 관광정책실을 둔다.
제3조(문화미디어산업실) 문화미디어산업실에 콘텐츠산업정책관 및 저작권정책관을 둔다.
제4조(관광정책실) 관광정책실에 관광정책관을 둔다.`,
      ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(문화미디어산업실) 콘텐츠산업정책관에 콘텐츠산업정책과를 두고, 저작권정책관에 저작권정책과를 둔다.
제4조(관광정책실) 관광정책관에 관광정책과를 둔다.`,
    },
    {
      asOf: "2026-07-28",
      decreeText: `시험문화부와 그 소속기관 직제
제2조(하부조직) 시험문화부에 문화미디어산업실 및 관광정책실을 둔다.
제3조(문화미디어산업실) 문화미디어산업실에 콘텐츠산업정책관ㆍ문화산업미디어정책관 및 저작권정책관을 둔다.
제4조(관광정책실) 관광정책실에 관광정책관을 둔다.`,
      ruleText: `시험문화부와 그 소속기관 직제 시행규칙
제3조(문화미디어산업실) 콘텐츠산업정책관에 콘텐츠산업정책과를 두고, 문화산업미디어정책관에 미디어정책과를 두며, 저작권정책관에 저작권정책과ㆍ저작권특별사법경찰과를 둔다.
제4조(관광정책실) 관광정책관에 관광정책과를 둔다.`,
    },
  ];
  const workflow = buildNativeComparisonWorkflow({
    stages,
    focus: "콘텐츠정책국, 미디어정책국, 저작권국, 국제문화홍보정책실, 문화미디어산업실, 관광정책국, 관광정책실",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const boxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node");
  const bands = manifest.objects.filter((object) => object.metadata?.role === "comparison-band");
  assert.equal(bands.length, 2);
  assert.ok(boxes.some((object) => object.text === "국제문화홍보정책실"));
  assert.ok(boxes.some((object) => object.text === "문화미디어산업실"));
  assert.ok(boxes.some((object) => object.text === "관광정책국"));
  assert.ok(boxes.some((object) => object.text === "관광정책실"));
  assert.ok(Math.max(...boxes.map((object) => object.geometry.width)) < 66);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("대응 없는 과는 처음 나타난 열에 신설, 사라진 열에 폐지로 표시한다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: {
      institution: "시험부",
      asOf: "2025-10-01",
      decreeText: `시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 조직국을 둔다.`,
      ruleText: `시험부와 그 소속기관 직제 시행규칙
제3조(조직국) 조직국에 조직기획과ㆍ조직진단과 및 정보공개과를 둔다.`,
    },
    after: {
      institution: "시험부",
      asOf: "2026-01-01",
      decreeText: `시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 조직국을 둔다.`,
      ruleText: `시험부와 그 소속기관 직제 시행규칙
제3조(조직국) 조직국에 조직기획과ㆍ정보공개제도과 및 법사조직과를 둔다.`,
    },
    focus: "조직국",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const labels = manifest.objects.filter((object) => object.metadata?.role === "status-label");
  const created = labels.filter((object) => object.metadata.status === "신설");
  const abolished = labels.filter((object) => object.metadata.status === "폐지");
  const boxes = Object.fromEntries(
    manifest.objects
      .filter((object) => object.metadata?.role === "organization-node")
      .map((object) => [object.metadata.nodeName, object]),
  );
  assert.deepEqual(created.map((object) => object.metadata.unit).sort(), ["법사조직과"]);
  assert.deepEqual(abolished.map((object) => object.metadata.unit).sort(), ["조직진단과"]);
  assert.equal(labels.some((object) => object.metadata.unit === "정보공개과"), false);
  assert.equal(labels.some((object) => object.metadata.unit === "정보공개제도과"), false);
  assert.equal(labels.some((object) => object.metadata.unit === "조직기획과"), false);
  assert.equal(created[0].style.textColor, "#9A3412");
  assert.equal(abolished[0].style.textColor, "#7B8794");
  assert.equal(boxes["법사조직과"].style.fill, "#FFFFFF");
  assert.ok(created[0].geometry.x > boxes["법사조직과"].geometry.x);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("4단에서 신설은 처음 나타난 열에만 찍는다", () => {
  const workflow = buildNativeComparisonWorkflow({
    stages: [
      { decreeText: decree, ruleText: rule, asOf: "2025-10-01" },
      { decreeText: midDecree, ruleText: midRule, asOf: "2025-11-25" },
      { decreeText: afterDecree, ruleText: afterRule, asOf: "2026-01-01" },
      { decreeText: afterDecree, ruleText: lateRule, asOf: "2026-07-21" },
    ],
    focus: "디지털정부실, 인공지능정부실, 참여혁신실, 참여혁신조직실, 조직국",
    onePage: true,
  });
  const labels = workflow.manifests[0].objects.filter((object) => (
    object.metadata?.role === "status-label" && object.metadata.unit === "법사조직과"
  ));
  assert.equal(labels.length, 1);
  assert.equal(labels[0].metadata.status, "신설");
  assert.equal(labels[0].metadata.side, "c4");
});

test("여러 대역을 빽빽하게 선택해도 A3 4단의 상자와 선은 용지 안에 맞춘다", () => {
  const departmentList = (prefix) => Array.from(
    { length: 18 },
    (_, index) => `${prefix}${index + 1}과`,
  ).join("ㆍ");
  const stage = (asOf) => ({
    institution: "시험부",
    asOf,
    decreeText: `시험부 직제
제2조(하부조직) 시험부에 문화미디어산업실ㆍ관광정책실 및 지원행정실을 둔다.`,
    ruleText: `시험부 직제 시행규칙
제3조(문화미디어산업실) 문화미디어산업실에 ${departmentList("문화정책")}를 둔다.
제4조(관광정책실) 관광정책실에 ${departmentList("관광정책")}를 둔다.
제5조(지원행정실) 지원행정실에 ${departmentList("지원행정")}를 둔다.`,
  });
  const workflow = buildNativeComparisonWorkflow({
    stages: [stage("2024-01-01"), stage("2025-01-01"), stage("2026-01-01"), stage("2027-01-01")],
    focus: "문화미디어산업실, 관광정책실, 지원행정실",
    onePage: true,
  });
  const manifest = workflow.manifests[0];
  const report = analyzeNativeManifest(manifest);
  const boxes = manifest.objects.filter((object) => object.metadata?.role === "organization-node");

  assert.equal(report.valid, true);
  assert.equal(report.errors.length, 0);
  assert.ok(boxes.length >= 200);
  assert.ok(boxes.every((box) => box.geometry.y >= 0));
  assert.ok(boxes.every((box) => box.geometry.y + box.geometry.height <= manifest.page.heightMm));
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

test("구버전 저장 이력은 조직 배치를 보존하고 원문 기능만 최신 파서로 다시 읽는다", () => {
  const original = buildNativeLawWorkflow({
    ruleText: `시험부 직제 시행규칙
제23조(지방박물관)
① 기획운영과장은 다음 사항을 분장한다.
1. 보안 및 관인 관리
② 학예연구실장은 다음 사항을 분장한다.
1. 소장유물의 관리
③ 교육과장은 다음 사항을 분장한다.
1. 교육 프로그램 운영`,
    institution: "시험부",
    asOf: "2025-01-01",
  });
  const snapshot = structuredClone(original.snapshot);
  delete snapshot.graph.meta.parserVersion;
  snapshot.graph.meta.departmentDutyCatalog[0].items.push({ number: 1, text: "소장유물의 관리" });

  const refreshed = buildNativeLawWorkflow(snapshot);
  const planning = refreshed.snapshot.graph.meta.departmentDutyCatalog
    .find((entry) => entry.department === "기획운영과");
  assert.deepEqual(planning.items.map((item) => item.text), ["보안 및 관인 관리"]);
  assert.equal(refreshed.snapshot.graph.meta.evidenceReparsedFromSnapshot, true);
  assert.equal(refreshed.summary.legalReadingAudit.conflictingCitations.length, 0);
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
  const wraps = manifest.objects.filter((object) => object.metadata?.role === "allocation-wrap");
  const links = manifest.objects.filter((object) => object.metadata?.role === "allocation-link");
  const labels = manifest.objects.filter((object) => object.metadata?.role === "allocation-link-label");
  assert.equal(workflow.summary.dutyAllocation.notable.length, 1);
  assert.match(line.text, /40% → 인공지능정책과/);
  assert.match(line.text, /60% → 데이터정책과/);
  assert.ok(wraps.some((object) => object.metadata.side === "before" && object.metadata.unit === "디지털정책과"));
  assert.ok(wraps.some((object) => object.metadata.side === "after" && object.metadata.unit === "인공지능정책과"));
  assert.ok(wraps.some((object) => object.metadata.side === "after" && object.metadata.unit === "데이터정책과"));
  assert.ok(wraps.every((object) => object.type === "rectangle" && object.style.dash === "dash"));
  assert.ok(links.length >= 4);
  assert.ok(links.every((object) => (
    object.geometry.x1 === object.geometry.x2 || object.geometry.y1 === object.geometry.y2
  )));
  assert.deepEqual(labels.map((object) => object.text).sort(), ["40%", "60%"]);
  const nodes = manifest.objects.filter((object) => object.metadata?.role === "organization-node");
  for (const wrap of wraps) {
    for (const node of nodes) {
      if (node.metadata.nodeName === wrap.metadata.unit) continue;
      assert.equal(boxesOverlap(wrap.geometry, node.geometry, 0.08), false, `${wrap.metadata.unit} 점선이 ${node.text}와 겹치면 안 됩니다`);
    }
  }
  const destWraps = wraps.filter((object) => object.metadata.side === "after");
  for (let index = 0; index < destWraps.length; index += 1) {
    for (let next = index + 1; next < destWraps.length; next += 1) {
      assert.equal(boxesOverlap(destWraps[index].geometry, destWraps[next].geometry, 0.08), false);
    }
  }
  assert.ok(labels.every((label) => label.geometry.x + label.geometry.width <= 124.5));
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("수동 명칭 사전에 없는 개편도 각 호 기능 근거로 점선을 만든다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: {
      ruleText: `시험부 직제 시행규칙
제5조(녹색문화실) 녹색문화실에 기후문화정책과를 둔다.
① 기후문화정책과장은 다음 사항을 분장한다.
1. 녹색문화 종합계획의 수립
2. 기후문화 조사 및 연구
3. 녹색문화 사업의 지원
4. 지역 기후문화 확산`,
      institution: "시험부",
      asOf: "2025-01-01",
    },
    after: {
      ruleText: `시험부 직제 시행규칙
제5조(녹색문화실) 녹색문화실에 녹색문화기획과ㆍ문화확산과를 둔다.
① 녹색문화기획과장은 다음 사항을 분장한다.
1. 녹색문화 종합계획의 수립
2. 기후문화 조사 및 연구
② 문화확산과장은 다음 사항을 분장한다.
1. 녹색문화 사업의 지원
2. 지역 기후문화 확산`,
      institution: "시험부",
      asOf: "2026-01-01",
    },
  });
  const manifest = workflow.manifests[0];
  const links = manifest.objects.filter((object) => (
    object.metadata?.role === "correspondence-link"
      && object.metadata.from === "기후문화정책과"
  ));
  assert.ok(links.some((object) => object.metadata.to === "녹색문화기획과"));
  assert.ok(links.some((object) => object.metadata.to === "문화확산과"));
  assert.ok(links.every((object) => object.metadata.basis === "duty-function"));
  assert.ok(links.every((object) => object.metadata.matchedFunctions === 2));
  assert.equal(workflow.summary.dutyLineage.links.length, 2);
  assert.equal(analyzeNativeManifest(manifest).valid, true);
});

test("같은 상위조직의 독립적인 1대1 변경은 점선 세로축을 공유하지 않는다", () => {
  const workflow = buildNativeComparisonWorkflow({
    before: {
      ruleText: `시험부 직제 시행규칙
제5조(시험실) 시험실에 기존가과ㆍ기존나과를 둔다.
① 기존가과장은 다음 사항을 분장한다.
1. 고유 가 기능의 수립 및 시행
2. 고유 가 사업의 평가 및 관리
② 기존나과장은 다음 사항을 분장한다.
1. 고유 나 기능의 조사 및 지원
2. 고유 나 사업의 운영 및 조정`,
      institution: "시험부",
    },
    after: {
      ruleText: `시험부 직제 시행규칙
제5조(시험실) 시험실에 개정나과ㆍ개정가과를 둔다.
① 개정나과장은 다음 사항을 분장한다.
1. 고유 나 기능의 조사 및 지원
2. 고유 나 사업의 운영 및 조정
② 개정가과장은 다음 사항을 분장한다.
1. 고유 가 기능의 수립 및 시행
2. 고유 가 사업의 평가 및 관리`,
      institution: "시험부",
    },
  });
  const vertical = workflow.manifests[0].objects.filter((object) => (
    object.metadata?.role === "correspondence-link"
      && object.geometry.x1 === object.geometry.x2
      && object.metadata.from
  ));
  assert.equal(vertical.length, 2);
  assert.equal(new Set(vertical.map((object) => object.geometry.x1)).size, 2);
  assert.deepEqual(
    vertical.map((object) => [object.metadata.from, object.metadata.to]).sort(),
    [["기존가과", "개정가과"], ["기존나과", "개정나과"]],
  );
});

function boxesOverlap(left, right, slack = 0.05) {
  return left.x < right.x + right.width - slack
    && left.x + left.width > right.x + slack
    && left.y < right.y + right.height - slack
    && left.y + left.height > right.y + slack;
}

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
