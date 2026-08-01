import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseLayout, displayNodeName, layoutPage, nodeStyle, parseLayoutStyles, planLayoutVariants, planPages, resolvePageSize } from "../src/layout.mjs";
import { projectOperationalView, summarizeStructure } from "../src/model.mjs";
import { parseNameList, parseOrganizationTexts } from "../src/parser.mjs";
import { renderSvg } from "../src/render-svg.mjs";

const text = `
시험행정부와 그 소속기관 직제
제2조(소속기관) 시험행정부장관 소속으로 국가시험연구원 및 행정교육원을 둔다.
제4조(하부조직) 시험행정부에 운영지원과ㆍ디지털정부실 및 자치행정국을 둔다.
장관 밑에 대변인 1명을 두고, 차관 밑에 기획조정실장 및 감사관 각 1명을 둔다.
제5조(대변인) 대변인은 장관을 보좌한다.
제6조(디지털정부실) 디지털정부실에 인공지능정책국 및 공공데이터국을 둔다.
인공지능정책국에 인공지능정책과ㆍ서비스혁신과 및 디지털포용팀을 둔다.
제7조(미래행정추진단) 디지털정부실에 2027년 12월 31일까지 존속하는 한시조직으로 미래행정추진단을 둔다.
`;

test("직제 문언에서 조직과 관계를 추출한다", () => {
  const graph = parseOrganizationTexts([text], { asOf: "2025-11-25" });
  assert.equal(graph.meta.institution, "시험행정부");
  assert.ok(graph.nodeByName("장관"));
  assert.ok(graph.nodeByName("차관"));
  assert.ok(graph.nodeByName("디지털정부실"));
  assert.ok(graph.nodeByName("인공지능정책국"));
  assert.ok(graph.nodeByName("인공지능정책과"));
  assert.equal(graph.nodeByName("대변인").kind, "advisor");
  assert.equal(graph.nodeByName("국가시험연구원").kind, "affiliated");
  assert.equal(graph.nodeByName("미래행정추진단").metadata.expires, "2027-12-31");

  const edge = [...graph.edges.values()].find(
    (candidate) =>
      graph.nodes.get(candidate.parent)?.name === "디지털정부실" &&
      graph.nodes.get(candidate.child)?.name === "인공지능정책국",
  );
  assert.ok(edge);
});

test("한국어 열거를 조직명으로 정리한다", () => {
  assert.deepEqual(parseNameList("정책과ㆍ혁신과 및 디지털소통팀장 각 1명"), [
    "정책과",
    "혁신과",
    "디지털소통팀",
  ]);
});

test("자동 레이아웃은 페이지 계획을 만든다", () => {
  const graph = parseOrganizationTexts([text]);
  const pages = planPages(graph, { mode: "auto", maxNodes: 12 });
  assert.ok(pages.length >= 2);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages.at(-1).pageCount, pages.length);
});

test("A4 세로 형식은 반쪽 면에 맞는 세로 스택 레이아웃을 선택한다", () => {
  const graph = parseOrganizationTexts([text]);
  const pages = planPages(graph, { paper: "a4-portrait", mode: "auto" });
  assert.equal(pages[0].paper, "a4-portrait");
  assert.equal(pages[0].layoutStyle, "vertical-stack");
  assert.equal(resolvePageSize("a4-portrait").height > resolvePageSize("a4-portrait").width, true);
});

test("A4 반쪽 세로형은 단계 간격을 검토서형으로 압축한다", () => {
  const graph = parseOrganizationTexts([text]);
  const page = planPages(graph, { paper: "a4-half", layoutStyle: "vertical-stack", maxNodes: 50 })[0];
  const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
  const topByDepth = new Map();
  for (const { position } of layout.nodes) {
    if (!topByDepth.has(position.depth)) topByDepth.set(position.depth, position.top);
    else topByDepth.set(position.depth, Math.min(topByDepth.get(position.depth), position.top));
  }

  assert.equal(layout.diagnostics.ok, true);
  assert.ok(topByDepth.get(0) - layout.frame.top <= 32);
  assert.ok(topByDepth.get(1) - topByDepth.get(0) <= 100);
  assert.ok(topByDepth.get(2) - topByDepth.get(1) <= 100);
});

test("A4 반쪽 세로형은 조밀한 세로 과 상자를 겹치지 않게 압축한다", () => {
  const departments = Array.from({ length: 16 }, (_, index) => `제${index + 1}정책과`).join("ㆍ");
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실에 ${departments}를 둔다.
`,
  ]);
  const page = planPages(graph, { paper: "a4-half", layoutStyle: "vertical-stack", focus: "시험실" })[0];
  const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
  const leafWidths = layout.nodes
    .filter(({ position }) => position.vertical)
    .map(({ position }) => position.width);

  assert.equal(layout.diagnostics.overlaps.length, 0);
  assert.equal(layout.diagnostics.overflow.length, 0);
  assert.ok(Math.min(...leafWidths) <= 14);
});

test("같은 그래프를 여러 시각 유형으로 한 번에 계획한다", () => {
  const graph = parseOrganizationTexts([text]);
  assert.deepEqual(parseLayoutStyles("vertical,horizontal,two-column,matrix"), [
    "vertical-stack",
    "horizontal-bus",
    "two-column",
    "matrix",
  ]);
  const pages = planLayoutVariants(graph, {
    layouts: "vertical,horizontal,two-column,matrix",
    paper: "a4-landscape",
    maxNodes: 50,
  });
  assert.deepEqual([...new Set(pages.map((page) => page.layoutStyle))].sort(), [
    "horizontal-bus",
    "matrix",
    "two-column",
    "vertical-stack",
  ]);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages.at(-1).pageCount, pages.length);
  for (const style of ["horizontal-bus", "vertical-stack", "two-column", "matrix"]) {
    const page = pages.find((candidate) => candidate.layoutStyle === style);
    const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
    assert.ok(layout.nodes.length > 2, `${style} 노드가 있어야 함`);
    assert.ok(layout.edges.every((edge) => edge.from && edge.to), `${style} 연결선 좌표가 있어야 함`);
  }
});

test("검토서형 추가 프리셋은 흐름·변경·소속기관·카드 목록을 지원한다", () => {
  const graph = parseOrganizationTexts([text]);
  assert.equal(parseLayoutStyles("all").length, 8);
  const pages = planLayoutVariants(graph, {
    layouts: "flow,change-lanes,affiliate-strip,catalog",
    paper: "a4-landscape",
    maxNodes: 50,
  });
  assert.deepEqual([...new Set(pages.map((page) => page.layoutStyle))], [
    "flow",
    "change-lanes",
    "affiliate-strip",
    "catalog",
  ]);
  for (const page of pages) {
    const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
    assert.ok(layout.nodes.length > 0, `${page.layoutStyle} 노드가 있어야 함`);
    assert.ok(layout.edges.every((edge) => edge.from && edge.to), `${page.layoutStyle} 연결선 좌표가 있어야 함`);
    if (page.layoutStyle === "flow" && layout.edges.length) assert.ok(layout.edges.some((edge) => edge.orientation === "horizontal"));
    if (page.layoutStyle === "change-lanes") assert.equal(layout.edgeMode, "none");
    if (page.layoutStyle === "catalog") assert.equal(layout.edgeMode, "none");
  }
});

test("A4 모든 프리셋은 인쇄 프레임 안에 배치 진단을 남긴다", () => {
  const graph = parseOrganizationTexts([text]);
  const pages = planLayoutVariants(graph, { layouts: "all", paper: "a4-landscape", maxNodes: 50 });
  for (const page of pages) {
    const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
    assert.equal(layout.diagnostics.ok, true, `${page.layoutStyle}에 넘침·겹침이 없어야 함`);
    assert.deepEqual(diagnoseLayout(layout), layout.diagnostics);
  }
});

test("작도 연결선은 상자 좌표에 붙고 SVG에서는 연속 경로로 출력한다", () => {
  const graph = parseOrganizationTexts([text]);
  const page = planPages(graph, { paper: "a4-landscape", layoutStyle: "horizontal-bus", maxNodes: 50 })[0];
  const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
  for (const { position } of layout.nodes) {
    assert.equal(Number.isFinite(position.right), true);
    assert.equal(Number.isFinite(position.bottom), true);
    assert.equal(Number.isFinite(position.centerY), true);
  }
  assert.deepEqual(layout.diagnostics.edgeIssues, []);
  const svg = renderSvg(graph, [page]);
  assert.equal((svg.match(/stroke-linecap="round"/g) || []).length, layout.edges.length);
  assert.match(svg, /<path d="M [^"]+" stroke="#(?:6B7280|8B8B8B|3D8B3D|4F7EA8)"/);
});

test("배치 진단은 너무 짧거나 역방향인 연결선을 잡는다", () => {
  const short = diagnoseLayout(
    {
      frame: { left: 0, top: 0, width: 220, height: 160 },
      nodes: [],
      edges: [
        {
          parent: "a",
          child: "b",
          from: { left: 40, top: 20, width: 80, height: 30 },
          to: { left: 40, top: 53, width: 80, height: 30 },
        },
      ],
    },
    { minimumConnectorLength: 6 },
  );
  assert.equal(short.ok, false);
  assert.equal(short.edgeIssues[0].reason, "too-short-vertical");

  const reversed = diagnoseLayout({
    frame: { left: 0, top: 0, width: 220, height: 160 },
    nodes: [],
    edges: [
      {
        parent: "a",
        child: "b",
        orientation: "horizontal",
        from: { left: 120, top: 40, width: 60, height: 28 },
        to: { left: 80, top: 40, width: 50, height: 28 },
      },
    ],
  });
  assert.equal(reversed.ok, false);
  assert.equal(reversed.edgeIssues[0].reason, "reversed-horizontal");
});

test("카드 목록형은 상위 조직별 묶음으로 법정 계층을 보존한다", () => {
  const graph = parseOrganizationTexts([text]);
  const page = planPages(graph, { paper: "a4-landscape", layoutStyle: "catalog", maxNodes: 50 }).find((candidate) => candidate.nodeIds.length > 2);
  const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
  assert.ok(layout.groupBoxes.length > 0);
  assert.ok(layout.groupBoxes.some((group) => group.caption?.startsWith("상위:") || group.caption === "직속 하부조직"));
  assert.equal(new Set(layout.nodes.map(({ node }) => node.id)).size, layout.nodes.length);
  assert.equal(layout.edges.length, 0);
});

test("대량 소속기관 상세는 자동 모드에서 카드형으로 전환한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(소속기관) 시험청장 소속으로 서울지방시험청을 둔다.
`,
  ]);
  const regional = graph.nodeByName("서울지방시험청");
  for (let index = 1; index <= 30; index += 1) {
    const child = graph.addNode(`제${index}시험세무서`, {
      kind: "affiliated",
      forceKind: true,
      metadata: { unitRole: "affiliated-institution", affiliationType: "special-local" },
    });
    graph.addEdge(regional.id, child.id, { type: "affiliated" });
  }

  const autoPage = planPages(graph, { paper: "a4-landscape", mode: "auto", maxNodes: 50 }).find((page) =>
    page.nodeIds.includes(regional.id) && page.kind === "affiliate-detail"
  );
  assert.equal(autoPage.layoutStyle, "catalog");
  const autoLayout = layoutPage(graph, autoPage, { pageSize: resolvePageSize(autoPage.paper) });
  assert.equal(autoLayout.edges.length, 0);
  assert.equal(autoLayout.diagnostics.ok, true);

  const explicitPage = planPages(graph, { paper: "a4-landscape", layoutStyle: "horizontal-bus", maxNodes: 50 }).find((page) =>
    page.nodeIds.includes(regional.id) && page.kind === "affiliate-detail"
  );
  assert.equal(explicitPage.layoutStyle, "horizontal-bus");
});

test("같은 표시명의 과도 부모별 scoped node로 따로 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(소속기관) 시험청장 소속으로 강남세무서 및 삼성세무서를 둔다.
`,
  ]);
  const gangnam = graph.nodeByName("강남세무서");
  const samsung = graph.nodeByName("삼성세무서");
  const first = graph.addNode("징세과", { id: "강남세무서/징세과", kind: "assistant" });
  const second = graph.addNode("징세과", { id: "삼성세무서/징세과", kind: "assistant" });
  graph.addEdge(gangnam.id, first.id, { type: "assistant" });
  graph.addEdge(samsung.id, second.id, { type: "assistant" });

  assert.notEqual(first.id, second.id);
  assert.equal(first.name, "징세과");
  assert.equal(second.name, "징세과");
  assert.equal(graph.childrenOf(gangnam).map(({ node }) => node.id).includes(first.id), true);
  assert.equal(graph.childrenOf(samsung).map(({ node }) => node.id).includes(second.id), true);
  assert.equal(displayNodeName(first), "징세과");
});

test("본부와 소속기관은 작도 색·표식으로 구분한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(소속기관) 장관 소속으로 정부청사관리본부 및 북부시험사무소를 둔다.
제3조(하부조직) 시험부에 재난안전관리본부를 둔다.
`,
  ]);
  const headquarters = graph.nodeByName("재난안전관리본부");
  const subsidiary = graph.nodeByName("정부청사관리본부");
  assert.notEqual(nodeStyle(headquarters).fill, nodeStyle(subsidiary).fill);
  assert.match(displayNodeName(headquarters), /본부/);
  assert.match(displayNodeName(subsidiary), /부속|특지|소속/);
});

test("focus 옵션은 한 실·국의 한쪽 조직도만 남긴다", () => {
  const graph = parseOrganizationTexts([text]);
  const pages = planPages(graph, { paper: "a4-half", mode: "vertical", focus: "디지털정부실" });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].subtitle, "디지털정부실");
  assert.equal(pages[0].paper, "a4-half");
  assert.ok(pages[0].nodeIds.includes(graph.nodeByName("인공지능정책국").id));
  assert.equal(pages[0].nodeIds.includes(graph.nodeByName("자치행정국").id), false);
});

test("검토서의 신설·이체 표식을 지시문으로 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
@변경: 신설과 = 신설
@변경: 이체과 = 이체
시험부에 신설과 및 이체과를 둔다.
`,
  ]);
  assert.equal(graph.nodeByName("신설과").metadata.change, "신설");
  assert.equal(graph.nodeByName("이체과").metadata.change, "이체");
  assert.match(displayNodeName(graph.nodeByName("신설과")), /신설/);
});

test("법령의 약칭과 복수 부기관장을 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험문화부
@기관장: 장관
제2조(하부조직) 시험문화부에 문화정책실(이하 "정책실"이라 한다)을 둔다.
정책실에 문화정책국을 둔다.
장관 밑에 제1차관 및 제2차관을 둔다.
`,
  ]);

  assert.ok(graph.nodeByName("문화정책실"));
  assert.equal(graph.nodeByName("정책실")?.id, graph.nodeByName("문화정책실")?.id);
  assert.ok(graph.nodeByName("문화정책국"));
  assert.equal(graph.findDeputies().length, 2);
  for (const deputy of graph.findDeputies()) {
    assert.equal(graph.parentsOf(deputy).some(({ node }) => node.name === "장관"), true);
  }
});

test("조문 경계를 넘는 오탐을 막고 재사용 약칭을 문맥별로 해석한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험행정부
제2조(직무) 제1연구원(이하 "연구원"이라 한다)은 연구 업무를 수행한다.
제3조(하부조직) 연구원에 분석과를 둔다.
제4조(직무) 제2연구원(이하 이 장에서 "연구원"이라 한다)은 교육 업무를 수행한다.
제5조(하부조직) 연구원에 교육과를 둔다.
제6조(대변인) 대변인은 고위공무원단에 속하는 일반직공무원으로 보한다. 다음 조에서 운영지원과를 둔다.
`,
  ]);

  assert.equal(graph.nodeByName("고위공무원단"), undefined);
  assert.equal(graph.nodeByName("연구원")?.name, "제2연구원");
  assert.equal(
    graph.parentsOf("분석과").some(({ node }) => node.name === "제1연구원"),
    true,
  );
  assert.equal(
    graph.parentsOf("교육과").some(({ node }) => node.name === "제2연구원"),
    true,
  );
});

test("문형이 접미사보다 우선하여 보조기관과 보좌기관을 구분한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제4조(하부조직) 시험부에 정책실 및 독립정책관을 둔다.
장관 밑에 기획조정실장 및 감사관 각 1명을 둔다.
차관 밑에 정책지원본부를 둔다.
정책실에 정책국을 둔다.
`,
  ]);

  assert.equal(graph.nodeByName("기획조정실").kind, "advisor");
  assert.equal(graph.nodeByName("감사관").kind, "advisor");
  assert.equal(graph.nodeByName("정책지원본부").kind, "advisor");
  assert.equal(graph.nodeByName("정책지원본부").metadata.unitRole, undefined);
  assert.equal(graph.nodeByName("독립정책관").kind, "assistant");
  assert.equal(
    graph.parentsOf("기획조정실").some(({ edge, node }) => node.name === "장관" && edge.type === "advisor"),
    true,
  );
  assert.equal(
    graph.parentsOf("정책국").some(({ edge, node }) => node.name === "정책실" && edge.type === "assistant"),
    true,
  );
});

test("복수차관 소관 열거를 각 차관의 계선으로 배치한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험문화부
제4조(차관) 시험문화부에 제1차관 및 제2차관을 둔다.
제1차관은 운영지원과ㆍ문화정책실 및 저작권국의 소관업무에 관하여 장관을 보조한다.
제2차관은 국민소통실ㆍ체육국 및 관광정책국의 소관업무에 관하여 장관을 보조한다.
`,
  ]);

  assert.equal(graph.parentsOf("문화정책실").some(({ node }) => node.name === "제1차관"), true);
  assert.equal(graph.parentsOf("관광정책국").some(({ node }) => node.name === "제2차관"), true);
  assert.equal(graph.parentsOf("관광정책국").some(({ node }) => node.name === "제1차관"), false);
});

test("소속기관 유형과 한시조직·한시정원을 분리한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험행정부
제2조(소속기관) 장관의 관장 사무를 지원하기 위하여 장관 소속으로 국가시험박물관을 둔다.
소관 사무를 분장하기 위하여 장관 소속으로 북부시험사무소를 둔다.
「책임운영기관의 설치ㆍ운영에 관한 법률」에 따라 장관 소속의 책임운영기관으로 국가시험연구원을 둔다.
제20조(한시조직) 시험행정부 정책실에 2028년 2월 29일까지 존속하는 한시조직으로 신제도과를 둔다.
제21조(한시정원) 신규 사업을 위하여 2027년 12월 31일까지 별표 5에 따른 한시정원을 시험행정부에 둔다.
`,
  ]);

  assert.equal(graph.nodeByName("국가시험박물관").metadata.affiliationType, "subsidiary");
  assert.equal(graph.nodeByName("북부시험사무소").metadata.affiliationType, "special-local");
  assert.equal(graph.nodeByName("국가시험연구원").metadata.responsible, true);
  assert.equal(graph.nodeByName("신제도과").metadata.expires, "2028-02-29");
  assert.equal(graph.nodeByName("한시정원"), undefined);
  assert.deepEqual(graph.meta.temporaryHeadcounts.map(({ target, expires }) => ({ target, expires })), [
    { target: "시험행정부", expires: "2027-12-31" },
  ]);
});

test("본부 명칭과 부속기관은 설치 문형으로 구분한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(소속기관) 장관의 관장 사무를 지원하기 위하여 장관 소속으로 정부청사관리본부를 둔다.
제4조(하부조직) 시험부에 재난안전관리본부를 둔다.
`,
  ]);

  const headquarters = graph.nodeByName("재난안전관리본부");
  const subsidiary = graph.nodeByName("정부청사관리본부");
  assert.equal(headquarters.kind, "assistant");
  assert.equal(headquarters.metadata.unitRole, "headquarters");
  assert.equal(graph.parentsOf(headquarters).some(({ edge }) => edge.type === "assistant"), true);
  assert.equal(subsidiary.kind, "affiliated");
  assert.equal(subsidiary.metadata.unitRole, "affiliated-institution");
  assert.equal(subsidiary.metadata.affiliationType, "subsidiary");
  assert.equal(graph.parentsOf(subsidiary).some(({ edge }) => edge.type === "affiliated"), true);
});

test("직무등급·특정직 보직·겸직·합의제 구성을 메타데이터로 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험위원회
제2조(구성) 위원회는 위원장 1명과 부위원장 1명을 포함한 11명의 위원으로 구성하며, 그 중 5명은 비상임위원으로 한다.
제3조(사무처) 위원회의 사무를 처리하기 위하여 위원회에 사무처를 둔다.
사무처장 1명을 두되, 부위원장 1명이 겸직한다.
제4조(조사관리관) 조사관리관은 고위공무원단에 속하는 임기제공무원으로 보하되, 그 직위의 직무등급은 나등급으로 한다.
제5조(위원장) 위원장은 소방총감으로 보한다.
`,
  ]);

  assert.deepEqual(
    {
      total: graph.meta.commissionComposition.total,
      standing: graph.meta.commissionComposition.standing,
      nonStanding: graph.meta.commissionComposition.nonStanding,
    },
    { total: 11, standing: 4, nonStanding: 5 },
  );
  assert.equal(graph.nodeByName("상임위원").metadata.count, 4);
  assert.equal(graph.nodeByName("사무처").metadata.concurrentWith, "부위원장");
  assert.equal(graph.nodeByName("조사관리관").metadata.grade, "나");
  assert.equal(graph.nodeByName("조사관리관").metadata.employmentType, "임기제");
  assert.equal(graph.nodeByName("위원장").metadata.specificRank, "소방총감");
});

test("조직통칙 위반 가능성을 검증 결과로 남긴다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
@관계: 차관보 > 지원과
@관계: 정책실 > 혁신실
`,
  ]);

  assert.equal(graph.meta.validation.some((message) => message.includes("차관보 밑")), true);
  assert.equal(graph.meta.validation.some((message) => message.includes("실 밑에 실")), true);
});

test("시행규칙의 보좌기관 하부조직과 팀을 보좌 계열로 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 장관 밑에 대변인 1명을 둔다.
제3조(대변인) 대변인 밑에 홍보담당관ㆍ안전소통담당관 및 디지털소통팀장 각 1명을 두되, 디지털소통팀장은 대변인을 보좌한다.
`,
  ]);

  for (const name of ["홍보담당관", "안전소통담당관", "디지털소통팀"]) {
    assert.equal(graph.nodeByName(name).kind, "advisor");
    assert.equal(
      graph.parentsOf(name).some(({ edge, node }) => node.name === "대변인" && edge.type === "advisor"),
      true,
    );
  }
});

test("시행규칙의 정책관 소관 과는 법정 설치 계선과 별도로 기록한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(시험실) 시험실장 밑에 지역정책관을 둔다.
시험실에 지역총괄과ㆍ지역진흥과 및 입지과를 둔다.
① 지역총괄과장은 다음 사항을 분장한다.
1. 지역 산업 정책 총괄
2. 그 밖에 지역정책관 내 다른 과의 주관에 속하지 않는 사항
② 지역진흥과장은 다음 사항을 분장한다.
1. 지역 진흥 사업
`,
  ]);

  // "시험실에 …과를 둔다"는 법정 설치관계로 남는다.
  assert.equal(
    graph.parentsOf("지역총괄과").some(({ edge, node }) => node.name === "시험실" && edge.type === "assistant"),
    true,
  );
  // "지역정책관 내 다른 과"는 별도의 소관관계다.
  assert.deepEqual(graph.nodeByName("지역총괄과").metadata.jurisdiction, {
    parent: "지역정책관",
    evidence: "explicit-duty-clause",
    legalBasis: "보좌기관 내 다른 과의 주관·소관",
    source: "입력 1",
  });
  assert.deepEqual(graph.meta.jurisdictionRelations, [
    {
      parent: "지역정책관",
      child: "지역총괄과",
      source: "입력 1",
      evidence: "explicit-duty-clause",
      legalBasis: "보좌기관 내 다른 과의 주관·소관",
    },
  ]);
  // 인접한 과는 문언만으로 추정해 붙이지 않는다.
  assert.equal(graph.nodeByName("지역진흥과").metadata.jurisdiction, undefined);
});

test("시행규칙의 다양한 보좌기관 소관 문형을 과 소관관계로 기록한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(통상교섭실) 통상교섭실장 밑에 자유무역협정교섭관 및 전력정책관을 둔다.
통상교섭실에 자유무역협정협상총괄과ㆍ자유무역협정무역규범과ㆍ전력산업정책과 및 전력시장과를 둔다.
⑩ 자유무역협정협상총괄과장은 다음 사항을 분장한다.
1. 자유무역협정 협상의 총괄ㆍ조정
2. 그 밖에 자유무역협정교섭관 내 다른 과의 주관에 속하지 아니하는 사항
<19> 자유무역협정무역규범과장은 다음 사항을 분장한다.
1. 자유무역협정 무역규범 분야 교섭에 관한 업무
2. 자유무역협정 무역규범 분야 교섭에 관한 업무 중 자유무역협정교섭관 내 다른 과의 주관에 속하지 않는 사항
⑫ 전력산업정책과장은 다음 사항을 분장한다.
1. 전력산업 정책의 수립
2. 그 밖에 전력정책관이 보좌하는 사항 중에서 다른 과의 주관에 속하지 않는 사항
⑬ 전력시장과장은 다음 사항을 분장한다.
1. 전력시장 운영에 관한 사항
`,
  ]);

  assert.equal(graph.nodeByName("자유무역협정협상총괄과").metadata.jurisdiction.parent, "자유무역협정교섭관");
  assert.equal(graph.nodeByName("자유무역협정무역규범과").metadata.jurisdiction.parent, "자유무역협정교섭관");
  assert.equal(graph.nodeByName("전력산업정책과").metadata.jurisdiction.parent, "전력정책관");
  assert.equal(graph.nodeByName("전력시장과").metadata.jurisdiction, undefined);
  assert.deepEqual(
    graph.meta.jurisdictionRelations.map((item) => [item.parent, item.child]),
    [
      ["자유무역협정교섭관", "자유무역협정협상총괄과"],
      ["자유무역협정교섭관", "자유무역협정무역규범과"],
      ["전력정책관", "전력산업정책과"],
    ],
  );
});

test("직제 호 번호 범위가 과 분장 조문에 재인용되면 보좌기관 소관으로 기록한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(시험실) 시험실장 밑에 지역정책관 및 산업정책관을 둔다.
시험실에 지역총괄과ㆍ지역개발과ㆍ산업지원과를 둔다.
지역정책관은 직제 제10조제3항제1호부터 제4호까지의 사항에 관하여 시험실장을 보좌한다.
산업정책관은 직제 제10조제3항제5호부터 제9호까지의 사항에 관하여 시험실장을 보좌한다.
① 지역총괄과장은 직제 제10조제3항제1호부터 제2호까지의 사항을 분장한다.
② 지역개발과장은 직제 제10조제3항제3호 및 제4호의 사항을 분장한다.
③ 산업지원과장은 직제 제10조제3항제5호부터 제6호까지의 사항을 분장한다.
`,
  ]);

  assert.equal(graph.nodeByName("지역총괄과").metadata.jurisdiction.parent, "지역정책관");
  assert.equal(graph.nodeByName("지역개발과").metadata.jurisdiction.parent, "지역정책관");
  assert.equal(graph.nodeByName("산업지원과").metadata.jurisdiction.parent, "산업정책관");
  assert.equal(graph.nodeByName("지역총괄과").metadata.jurisdiction.evidence, "duty-item-range");
  assert.match(graph.nodeByName("지역개발과").metadata.jurisdiction.reference, /제10조제3항/);
  assert.deepEqual(
    graph.meta.jurisdictionRangeHints.map((item) => [item.advisor, item.reference]),
    [
      ["지역정책관", "제10조제3항 제1호부터 제4호까지"],
      ["산업정책관", "제10조제3항 제5호부터 제9호까지"],
    ],
  );
});

test("직제 호 번호 범위가 둘 이상에 걸치면 보좌기관 소관을 추정하지 않는다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(시험실) 시험실장 밑에 지역정책관 및 산업정책관을 둔다.
시험실에 조정과를 둔다.
지역정책관은 직제 제10조제3항제1호부터 제4호까지의 사항에 관하여 시험실장을 보좌한다.
산업정책관은 직제 제10조제3항제5호부터 제9호까지의 사항에 관하여 시험실장을 보좌한다.
① 조정과장은 직제 제10조제3항제4호 및 제5호의 사항을 분장한다.
`,
  ]);

  assert.equal(graph.nodeByName("조정과").metadata.jurisdiction, undefined);
  assert.deepEqual(graph.meta.jurisdictionRangeCandidates.at(-1), {
    department: "조정과",
    reference: "제10조제3항 제4호ㆍ제5호",
    advisors: [],
    source: "입력 1",
  });
});

test("@소관 지시문으로 확인된 운영 소관 묶음을 보강한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
@소관: 지역정책관 > 지역총괄과ㆍ지역진흥과 [공식 조직표]
제2조(시험실) 시험실장 밑에 지역정책관을 둔다.
시험실에 지역총괄과ㆍ지역진흥과를 둔다.
`,
  ]);

  assert.equal(graph.nodeByName("지역총괄과").metadata.jurisdiction.parent, "지역정책관");
  assert.equal(graph.nodeByName("지역진흥과").metadata.jurisdiction.source, "공식 조직표");
  assert.equal(graph.meta.jurisdictionRelations.length, 2);
});

test("운영형 투영은 법정 설치계선을 보존한 채 소관 관계만 재배치한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
@소관: 지역정책관 > 지역총괄과 [공식 조직표]
제2조(시험실) 시험실장 밑에 지역정책관을 둔다.
시험실에 지역총괄과를 둔다.
`,
  ]);
  const operational = projectOperationalView(graph);

  assert.equal(
    graph.parentsOf("지역총괄과").some(({ edge, node }) => node.name === "시험실" && edge.type === "assistant"),
    true,
  );
  assert.equal(
    operational.parentsOf("지역총괄과").some(({ edge, node }) => node.name === "지역정책관" && edge.type === "jurisdiction"),
    true,
  );
  assert.equal(
    operational.parentsOf("지역총괄과").some(({ node }) => node.name === "시험실"),
    false,
  );
  assert.equal(operational.meta.renderView, "operational");
});

test("보직 조문의 연구·지도·전문직·전문경력·특정직 표식을 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(하부조직) 시험청에 연구과ㆍ지도과ㆍ전문직과ㆍ전문과 및 소방과를 둔다.
제3조(보직) 연구과장은 연구관으로, 지도과장은 지도관으로, 전문직과장은 전문직공무원으로, 전문과장은 전문경력관으로, 소방과장은 특정직공무원으로 보한다.
`,
  ]);
  assert.deepEqual(graph.nodeByName("연구과").metadata.staffCategories, ["연구직"]);
  assert.deepEqual(graph.nodeByName("지도과").metadata.staffCategories, ["지도직"]);
  assert.deepEqual(graph.nodeByName("전문직과").metadata.staffCategories, ["전문직"]);
  assert.deepEqual(graph.nodeByName("전문과").metadata.staffCategories, ["전문경력관"]);
  assert.deepEqual(graph.nodeByName("소방과").metadata.staffCategories, ["특정직"]);
});

test("시행규칙 보직 범위·혼합보직·별표 요구를 메타데이터로 남긴다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(하부조직) 시험청에 정책과 및 구급의료팀을 둔다.
제3조(보직) 각 과장은 부이사관 또는 서기관으로 보한다. 구급의료팀장은 과학기술서기관ㆍ의무사무관ㆍ소방정 또는 소방령으로 보한다.
제4조(현장조직) 각 세무서에 두는 과 및 이에 상당하는 담당관은 별표 5와 같다. 직급별 정원은 별표 7과 같다.
`,
  ]);

  assert.equal(graph.nodeByName("정책과").metadata.gradeRange, "3.4급");
  assert.equal(graph.nodeByName("구급의료팀").metadata.gradeRange, "4.5급");
  assert.equal(graph.nodeByName("구급의료팀").metadata.mixedAppointment, true);
  assert.deepEqual(
    graph.meta.annexRequirements.map(({ type, annex }) => ({ type, annex })),
    [
      { type: "organization-matrix", annex: "별표 5" },
      { type: "headcount", annex: "별표 7" },
    ],
  );
});

test("직종 복수 보임은 배지 집합으로 보존하고 일반직 단독은 숨긴다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(하부조직) 시험부에 연구과ㆍ임기과ㆍ일반과를 둔다.
제3조(보직) 연구과장은 일반직 또는 연구직으로 보한다. 임기과장은 일반직 또는 임기제공무원으로 보한다. 일반과장은 일반직공무원으로 보한다.
`,
  ]);
  assert.deepEqual(graph.nodeByName("연구과").metadata.staffCategories, ["일반직", "연구직"]);
  assert.deepEqual(graph.nodeByName("임기과").metadata.staffCategories, ["일반직", "임기제"]);
  assert.deepEqual(graph.nodeByName("일반과").metadata.staffCategories, ["일반직"]);
  assert.match(displayNodeName(graph.nodeByName("연구과")), /\(일\).*\(연\)/);
  assert.doesNotMatch(displayNodeName(graph.nodeByName("일반과")), /\(일\)/);
});

test("자율기구 훈령의 제2조 소속 위치와 존속기한을 읽고 기구 수에서 제외한다", () => {
  const graph = parseOrganizationTexts([
    `
「자율기구 정보자원관리혁신과 설치 및 운영에 관한 규정」
제2조(조직의 설치) 정보자원관리혁신과는 인공지능정부실 인공지능정부기반국에 둔다.
제6조(존속기한) 이 훈령은 2026년 12월 31일까지 효력을 가진다.
`,
  ]);
  const node = graph.nodeByName("정보자원관리혁신과");
  assert.equal(node.metadata.autonomous, true);
  assert.equal(node.metadata.countsTowardStructure, false);
  assert.equal(node.metadata.expires, "2026-12-31");
  assert.equal(graph.parentsOf(node).some(({ node: parent }) => parent.name === "인공지능정부기반국"), true);
  assert.equal(summarizeStructure(graph).countingRules.autonomousIncluded, false);
});

test("조직도 숫자 표기와 국별 관리폭 진단을 보존한다", () => {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
제2조(소속기관) 시험부 장관 소속으로 지방사무소(5)를 둔다.
제3조(하부조직) 시험부에 정책국을 둔다. 정책국에 산업과ㆍ지역과ㆍ기획과ㆍ예산과ㆍ법무과ㆍ홍보과ㆍ운영과ㆍ관리과ㆍ조정과ㆍ지원과를 둔다.
`,
  ]);
  assert.equal(graph.nodeByName("지방사무소").metadata.institutionCount, 5);
  assert.equal(graph.meta.spanDiagnostics.some((item) => item.node === "정책국" && item.status === "split-candidate"), true);
});
