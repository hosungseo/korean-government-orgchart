import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditReport, formatAuditMarkdown, suggestJurisdictionCandidates } from "../src/audit.mjs";
import { enrichGraphWithLawMap } from "../src/law-map.mjs";
import { planPages } from "../src/layout.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

test("감사 리포트는 정책관 소관 후보 지시문을 제안한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실장 밑에 지역정책관을 둔다.
시험실에 지역총괄과ㆍ지역진흥과 및 입지과를 둔다.
`,
  ]);
  const candidates = suggestJurisdictionCandidates(graph);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].advisor, "지역정책관");
  assert.deepEqual(candidates[0].departments, ["지역총괄과", "지역진흥과", "입지과"]);
  assert.match(candidates[0].directive, /^@소관: 지역정책관 > 지역총괄과ㆍ지역진흥과ㆍ입지과/);

  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  assert.equal(report.meta.status, "needs-review");
  assert.equal(report.reviewActions.some((action) => action.topic === "jurisdiction"), true);
  assert.match(formatAuditMarkdown(report), /정책관·관 소관 후보/);
});

test("감사 리포트는 별표 요구와 소관법령 미매칭을 우선 확인 항목으로 올린다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(하부조직) 시험청에 운영지원과 및 정책국을 둔다.
각 세무서에 두는 과 및 이에 상당하는 담당관은 별표 5와 같다. 직급별 정원은 별표 7과 같다.
`,
  ]);
  enrichGraphWithLawMap(
    graph,
    {
      시험청: {
        운영지원과: { laws: [{ 법령명: "시험청 운영규칙" }] },
        미설치과: { laws: [{ 법령명: "미설치 법령" }] },
      },
    },
    { asOf: "2026-07-24", source: "dept_map.json" },
  );

  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-landscape" }));
  assert.equal(report.annexRequirements.length, 2);
  assert.equal(report.lawMap.unmatchedDepartments.length, 1);
  assert.equal(report.reviewActions.some((action) => action.topic === "annex" && action.priority === "high"), true);
  assert.equal(report.reviewActions.some((action) => action.topic === "law-map"), true);
});

test("감사 리포트는 직제만 있고 시행규칙이 없으면 과 단위 누락 가능성을 경고한다", () => {
  const graph = parseOrganizationTexts(
    [
      `
시험부와 그 소속기관 직제
제1조(목적) 이 영은 시험부와 그 소속기관의 조직과 직무범위를 규정한다.
제2조(하부조직) 시험부에 정책실 및 산업국을 둔다.
`,
    ],
    { sources: ["시험부와 그 소속기관 직제"] },
  );

  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  const action = report.reviewActions.find((item) => item.topic === "source-completeness");
  const markdown = formatAuditMarkdown(report);

  assert.equal(graph.meta.sourceInventory[0].role, "decree");
  assert.equal(action?.priority, "medium");
  assert.match(action.message, /직제 시행규칙 입력이 확인되지 않아/);
  assert.match(action.message, /산업국/);
  assert.match(markdown, /입력 소스/);
  assert.match(markdown, /시험부와 그 소속기관 직제: 직제/);
});

test("감사 리포트는 시행규칙 입력이 있으면 과 단위 누락 경고를 억제한다", () => {
  const graph = parseOrganizationTexts(
    [
      `
시험부와 그 소속기관 직제
제1조(목적) 이 영은 시험부와 그 소속기관의 조직과 직무범위를 규정한다.
제2조(하부조직) 시험부에 정책실 및 산업국을 둔다.
`,
      `
시험부와 그 소속기관 직제 시행규칙
제3조(정책실) 정책실에 정책과를 둔다.
`,
    ],
    { sources: ["시험부와 그 소속기관 직제", "시험부와 그 소속기관 직제 시행규칙"] },
  );

  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));

  assert.deepEqual(graph.meta.sourceInventory.map((item) => item.role), ["decree", "rule"]);
  assert.equal(report.reviewActions.some((item) => item.topic === "source-completeness"), false);
});

test("복수 보좌기관 후보는 중복 지시문 대신 대조 필요 묶음으로 압축한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실장 밑에 제도정책관 및 현장지원관을 둔다.
시험실에 총괄과ㆍ지원과 및 현장팀을 둔다.
`,
  ]);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  assert.equal(report.jurisdictionCandidates.length, 1);
  assert.equal(report.jurisdictionCandidates[0].advisor, "제도정책관ㆍ현장지원관");
  assert.equal(report.jurisdictionCandidates[0].directive, null);
  assert.equal(report.jurisdictionCandidates[0].confidence, "multiple-advisors-need-range-crosswalk");
  assert.match(formatAuditMarkdown(report), /직제 호 번호 범위와 시행규칙 과 분장사무/);
});

test("감사 리포트는 직제 호 번호 범위 대조 결과를 확정과 미확정으로 나눈다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실장 밑에 지역정책관 및 산업정책관을 둔다.
시험실에 지역총괄과ㆍ조정과를 둔다.
지역정책관은 직제 제10조제3항제1호부터 제4호까지의 사항에 관하여 시험실장을 보좌한다.
산업정책관은 직제 제10조제3항제5호부터 제9호까지의 사항에 관하여 시험실장을 보좌한다.
① 지역총괄과장은 직제 제10조제3항제1호부터 제2호까지의 사항을 분장한다.
② 조정과장은 직제 제10조제3항제4호 및 제5호의 사항을 분장한다.
`,
  ]);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  const markdown = formatAuditMarkdown(report);

  assert.equal(report.jurisdictionCrosswalks.confirmed.length, 1);
  assert.equal(report.jurisdictionCrosswalks.confirmed[0].child, "지역총괄과");
  assert.equal(report.jurisdictionCrosswalks.unresolved.length, 1);
  assert.equal(report.jurisdictionCrosswalks.unresolved[0].department, "조정과");
  assert.equal(report.reviewActions.some((action) => action.topic === "jurisdiction-range"), true);
  assert.match(markdown, /직제 호 번호 소관 대조/);
  assert.match(markdown, /자동 확정:[\s\S]*지역정책관 > 지역총괄과/);
  assert.match(markdown, /확인 필요:[\s\S]*조정과/);
});

test("감사 리포트는 순서 기반 보좌기관 소관 보강을 표시한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(시험실) 시험실장 밑에 제도정책관ㆍ현장지원관 및 산업협력관을 둔다.
시험실에 제도총괄과ㆍ제도개선과ㆍ현장총괄과ㆍ현장지원과ㆍ협력총괄과ㆍ협력지원과를 둔다.
① 제도총괄과장은 다음 사항을 분장한다.
1. 그 밖에 제도정책관 내 다른 과의 주관에 속하지 않는 사항
② 제도개선과장은 다음 사항을 분장한다.
1. 제도 개선
③ 현장총괄과장은 다음 사항을 분장한다.
1. 그 밖에 현장지원관 내 다른 과의 주관에 속하지 않는 사항
④ 현장지원과장은 다음 사항을 분장한다.
1. 현장 지원
⑤ 협력총괄과장은 다음 사항을 분장한다.
1. 그 밖에 산업협력관 내 다른 과의 주관에 속하지 않는 사항
⑥ 협력지원과장은 다음 사항을 분장한다.
1. 협력 지원
`,
  ]);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  const markdown = formatAuditMarkdown(report);

  assert.equal(report.jurisdictionRunInferences.length, 3);
  assert.match(markdown, /순서 기반 소관 보강/);
  assert.match(markdown, /제도정책관: 제도개선과/);
  assert.match(markdown, /산업협력관: 협력지원과/);
});

test("감사 리포트는 확정 소관관계의 증거유형을 표시한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(시험실) 시험부에 시험실을 둔다.
시험실장 밑에 지역정책관을 둔다.
지역정책관에 지역총괄과를 둔다.
`,
  ]);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  const markdown = formatAuditMarkdown(report);

  assert.equal(report.jurisdictionRelations.length, 1);
  assert.match(markdown, /확정 소관관계/);
  assert.match(markdown, /지역정책관 > 지역총괄과: 직접 설치 문형/);
});

test("감사 리포트는 배치 문제가 있으면 작도 개선 제안을 덧붙인다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실에 제1과ㆍ제2과ㆍ제3과ㆍ제4과ㆍ제5과ㆍ제6과ㆍ제7과ㆍ제8과를 둔다.
`,
  ]);
  const root = graph.nodeByName("장관") || graph.findHead();
  const page = {
    kind: "compact",
    title: "시험부",
    subtitle: "초소형 면",
    rootIds: [root.id],
    nodeIds: [root.id, ...graph.descendantsOf(root.id).map((node) => node.id)],
    paper: { width: 160, height: 180, name: "tiny" },
    layoutStyle: "horizontal-bus",
    pageNumber: 1,
    pageCount: 1,
  };

  const report = buildAuditReport(graph, [page]);
  const markdown = formatAuditMarkdown(report);

  assert.equal(report.layoutRecommendations.length > 0, true);
  assert.match(markdown, /작도 개선 제안/);
  assert.match(markdown, /--max-nodes/);
});
