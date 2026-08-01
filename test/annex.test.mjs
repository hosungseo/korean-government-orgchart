import test from "node:test";
import assert from "node:assert/strict";
import { applyAnnexOrganizations, attachAnnexes, extractAnnexesFromLawJson, parseBoxTable } from "../src/annex.mjs";
import { buildAuditReport, formatAuditMarkdown } from "../src/audit.mjs";
import { planPages } from "../src/layout.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

const annexText = `
■ 시험청 직제 [별표 1]
  지방시험청의 명칭ㆍ위치 및 관할구역
┏━━━━━━━┯━━━━━┯━━━━━━━━┓
┃명칭          │위치      │관할구역        ┃
┠───────┼─────┼────────┨
┃서울지방시험청│서울특별시│서울특별시      ┃
┠───────┼─────┼────────┨
┃중부지방시험청│경기도    │경기도 수원시   ┃
┃              │          │강원특별자치도  ┃
┗━━━━━━━┷━━━━━┷━━━━━━━━┛
`;

test("법제처 별표 선그리기 표를 행 단위로 추출한다", () => {
  assert.deepEqual(parseBoxTable(annexText), [
    ["서울지방시험청", "서울특별시", "서울특별시"],
    ["중부지방시험청", "경기도", "경기도 수원시 강원특별자치도"],
  ]);
});

test("법제처 JSON에서 별표 인벤토리를 추출하고 감사 리포트에 연결한다", () => {
  const annexes = extractAnnexesFromLawJson(
    {
      법령: {
        별표: {
          별표단위: {
            별표번호: "0001",
            별표제목: "지방시험청의 명칭ㆍ위치 및 관할구역(제3조 관련)",
            별표키: "000100E",
            별표시행일자: "20260701",
            별표내용: [[annexText]],
          },
        },
      },
    },
    { source: "시험청 직제 [시행 20260701]" },
  );
  assert.equal(annexes.length, 1);
  assert.equal(annexes[0].annex, "별표 1");
  assert.equal(annexes[0].type, "jurisdiction");
  assert.equal(annexes[0].rowCount, 2);

  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(하부조직) 시험청에 운영지원과를 둔다.
지방시험청의 명칭ㆍ위치 및 관할구역은 별표 1과 같다.
`,
  ]);
  attachAnnexes(graph, annexes);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  assert.equal(report.annexes.length, 1);
  assert.equal(report.annexRequirements[0].matchedAnnex.rowCount, 2);
  assert.match(formatAuditMarkdown(report), /별표 인벤토리/);
  assert.match(formatAuditMarkdown(report), /별표 1 · jurisdiction · 지방시험청/);
});

test("지방국세청 명칭·위치·소속세무서 별표를 소속기관 트리로 반영한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 국세청
제24조(지방국세청) 국세청장 소속하에 두는 지방국세청의 명칭ㆍ위치 및 소속세무서는 별표 1과 같다.
제19조(관할구역) 지방국세청의 관할구역은 별표 1과 같다.
`,
  ]);
  const annexes = [
    {
      annex: "별표 1",
      title: "지방국세청의 명칭ㆍ위치 및 소속세무서(제24조제1항 관련)",
      source: "국세청과 그 소속기관 직제 [시행 20260701]",
      rows: [
        ["서울지방국세청", "서울특별시", "종로, 중부, 관 악"],
        ["중부지방국세청", "경 기 도", "안양, 화 성"],
      ],
    },
    {
      annex: "별표 1",
      title: "지방국세청의 관할구역(제19조제1항 관련)",
      source: "국세청과 그 소속기관 직제 시행규칙 [시행 20260701]",
      rows: [
        ["서울지방국세청", "서울특별시", "서울특별시"],
        ["중부지방국세청", "경 기 도", "경기도 안양시ㆍ수원시"],
      ],
    },
  ];
  attachAnnexes(graph, annexes);
  applyAnnexOrganizations(graph);

  const seoul = graph.nodeByName("서울지방국세청");
  const jungbu = graph.nodeByName("중부지방국세청");
  const jongno = graph.nodeByName("종로세무서");
  const gwanak = graph.nodeByName("관악세무서");
  assert.equal(seoul.kind, "affiliated");
  assert.equal(jungbu.metadata.location, "경기도");
  assert.equal(jungbu.metadata.jurisdictionArea, "경기도 안양시ㆍ수원시");
  assert.equal(jongno.kind, "affiliated");
  assert.equal(gwanak.metadata.parentRegionalOffice, "서울지방국세청");
  assert.equal(
    graph.parentsOf(jongno).some(({ node, edge }) => node.name === "서울지방국세청" && edge.type === "affiliated"),
    true,
  );
  assert.deepEqual(graph.meta.annexOrganizations.map((item) => item.type), [
    "regional-tax-office-tree",
    "regional-tax-office-jurisdiction",
  ]);
  graph.meta.annexRequirements ||= [];
  graph.meta.annexRequirements.push({
    type: "jurisdiction",
    annex: "별표 1",
    description: "시행규칙 관할구역 확인",
    source: "국세청과 그 소속기관 직제 시행규칙 [시행 20260701]",
  });
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  assert.equal(report.annexOrganizations.length, 2);
  assert.equal(report.annexRequirements.at(-1).matchedAnnex.title, "지방국세청의 관할구역(제19조제1항 관련)");
  assert.match(formatAuditMarkdown(report), /별표 조직 반영/);
  assert.match(formatAuditMarkdown(report), /지방청 2개, 세무서 5개/);
});
