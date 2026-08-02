import test from "node:test";
import assert from "node:assert/strict";
import { compareOrgGraphs, formatComparisonCsv, formatComparisonMarkdown } from "../src/graph-diff.mjs";
import { displayNodeName, planPages, layoutPage, resolvePageSize } from "../src/layout.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

const beforeText = `
@기관: 시험부
제2조(하부조직) 시험부에 시험실 및 다른실을 둔다.
시험실에 산업정책과ㆍ안전과ㆍ이체과를 둔다.
다른실에 기존과를 둔다.
`;

const afterText = `
@기관: 시험부
제2조(하부조직) 시험부에 시험실 및 다른실을 둔다.
시험실에 산업전략과ㆍ신설과를 둔다.
다른실에 기존과ㆍ이체과를 둔다.
`;

test("조직도 JSON 비교 모델은 신설·폐지·명칭변경·이체를 표식으로 보존한다", () => {
  const before = parseOrganizationTexts([beforeText], { asOf: "2026-01-01" });
  const after = parseOrganizationTexts([afterText], { asOf: "2026-02-01" });
  const compared = compareOrgGraphs(before, after);

  assert.equal(compared.nodeByName("산업전략과").metadata.change, "명칭변경");
  assert.equal(compared.nodeByName("산업전략과").metadata.previousName, "산업정책과");
  assert.equal(compared.nodeByName("신설과").metadata.change, "신설");
  assert.equal(compared.nodeByName("안전과").metadata.change, "폐지");
  assert.equal(compared.nodeByName("이체과").metadata.change, "이체");
  assert.deepEqual(compared.nodeByName("이체과").metadata.previousParents, ["assistant:시험실"]);
  assert.deepEqual(compared.nodeByName("이체과").metadata.nextParents, ["assistant:다른실"]);

  assert.equal(compared.meta.comparison.added.length, 1);
  assert.equal(compared.meta.comparison.removed.length, 1);
  assert.equal(compared.meta.comparison.renamed.length, 1);
  assert.equal(compared.meta.comparison.moved.length, 1);
  assert.equal(compared.meta.comparison.review.length, 0);
  assert.equal(compared.meta.comparison.renamed[0].from, "산업정책과");
  assert.equal(compared.meta.comparison.renamed[0].to, "산업전략과");
  assert.match(displayNodeName(compared.nodeByName("산업전략과")), /산업전략과 ← 산업정책과 .*명칭변경/);
});

test("비교 그래프는 변경 전후 레인형으로 배치할 수 있다", () => {
  const compared = compareOrgGraphs(parseOrganizationTexts([beforeText]), parseOrganizationTexts([afterText]));
  const pages = planPages(compared, {
    paper: "a4-landscape",
    layoutStyle: "change-lanes",
    maxNodes: 40,
  });
  const layout = layoutPage(compared, pages[0], { pageSize: resolvePageSize("a4-landscape") });

  assert.equal(layout.edgeMode, "none");
  assert.equal(layout.diagnostics.ok, true);
  assert.equal(layout.diagnostics.qualityOk, true);
  assert.ok(layout.nodes.some(({ node }) => node.name === "안전과" && node.metadata.change === "폐지"));
});

test("비교 결과는 검토서용 Markdown과 CSV 변경목록으로 출력할 수 있다", () => {
  const compared = compareOrgGraphs(parseOrganizationTexts([beforeText]), parseOrganizationTexts([afterText]));
  const markdown = formatComparisonMarkdown(compared);
  const csv = formatComparisonCsv(compared);

  assert.match(markdown, /# 시험부 변경목록/);
  assert.match(markdown, /## 신설/);
  assert.match(markdown, /신설과/);
  assert.match(markdown, /## 폐지/);
  assert.match(markdown, /안전과/);
  assert.match(markdown, /## 명칭변경/);
  assert.match(markdown, /산업정책과/);
  assert.match(markdown, /산업전략과/);
  assert.match(markdown, /## 이체/);
  assert.match(markdown, /시험실/);
  assert.match(csv, /^변경유형,조직,변경전조직,변경후조직,변경전상위,변경후상위,종류,유사도,사유/m);
  assert.match(csv, /신설,신설과,,신설과,,시험실,보조기관,/);
  assert.match(csv, /폐지,안전과,안전과,,시험실,,보조기관,/);
  assert.match(csv, /명칭변경,산업전략과,산업정책과,산업전략과,시험실,시험실,,/);
  assert.match(csv, /이체,이체과,이체과,이체과,시험실,다른실,보조기관,/);
});

test("자동 판정하지 않은 유사 명칭·이체 조합은 검토 필요 후보로 남긴다", () => {
  const before = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 가실 및 나실을 둔다.
가실에 국제정책과를 둔다.
`,
  ]);
  const after = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 가실 및 나실을 둔다.
나실에 국제전략과를 둔다.
`,
  ]);
  const compared = compareOrgGraphs(before, after);
  const candidate = compared.meta.comparison.review[0];
  const markdown = formatComparisonMarkdown(compared);
  const csv = formatComparisonCsv(compared);

  assert.equal(compared.nodeByName("국제전략과").metadata.change, "신설");
  assert.equal(compared.nodeByName("국제정책과").metadata.change, "폐지");
  assert.equal(candidate.type, "명칭변경·이체 후보");
  assert.equal(candidate.before, "국제정책과");
  assert.equal(candidate.after, "국제전략과");
  assert.deepEqual(candidate.beforeParents, ["가실"]);
  assert.deepEqual(candidate.afterParents, ["나실"]);
  assert.match(markdown, /## 검토 필요 후보/);
  assert.match(markdown, /명칭변경·이체 후보/);
  assert.match(csv, /명칭변경·이체 후보,국제정책과 → 국제전략과,국제정책과,국제전략과,가실,나실,보조기관,/);
});
