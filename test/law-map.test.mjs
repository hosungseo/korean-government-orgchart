import test from "node:test";
import assert from "node:assert/strict";
import { buildLawAppendixPages, enrichGraphWithLawMap } from "../src/law-map.mjs";
import { buildAuditReport, formatAuditMarkdown } from "../src/audit.mjs";
import { planPages } from "../src/layout.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

test("과 단위 소관법령 지도를 정확히 일치하는 조직 노드에 연결한다", () => {
  const graph = parseOrganizationTexts([
    `@기관: 시험행정부
제2조(하부조직) 시험행정부에 정책과 및 운영지원과를 둔다.`,
  ], { asOf: "2026-07-24" });
  const result = enrichGraphWithLawMap(graph, {
    시험행정부: {
      정책과: {
        부서키: "100",
        부서연락처: "044-000-0000",
        laws: [{ 법령ID: "001", 법령명: "시험법" }, { 법령ID: "002", 법령명: "시험법 시행령" }],
      },
      존재하지않는과: { 부서키: "101", laws: [{ 법령ID: "003", 법령명: "미연결법" }] },
    },
  }, { asOf: "2026-07-24", source: "fixture" });

  assert.equal(result.matchedDepartments, 1);
  assert.equal(result.lawCount, 2);
  assert.deepEqual(result.unmatchedDepartments, [{ name: "존재하지않는과", lawCount: 1 }]);
  assert.equal(graph.nodeByName("정책과").metadata.lawResponsibility.lawCount, 2);
  assert.equal(graph.meta.warnings.length, 0);
});

test("소관법령 지도의 기준일 불일치를 경고로 남긴다", () => {
  const graph = parseOrganizationTexts(["@기관: 시험부"], { asOf: "2025-01-01" });
  enrichGraphWithLawMap(graph, { 시험부: {} }, { asOf: "2026-01-01" });
  assert.equal(graph.meta.warnings.some((message) => message.includes("기준일")), true);
});

test("소관법령 지도는 scoped 하위기관 내부조직을 자동 매칭에서 제외한다", () => {
  const graph = parseOrganizationTexts([
    `@기관: 국세청
제2조(소속기관) 국세청장 소속으로 강남세무서를 둔다.
제3조(하부조직) 국세청에 징세과를 둔다.`,
  ]);
  const taxOffice = graph.nodeByName("강남세무서");
  const scoped = graph.addNode("징세과", {
    id: "강남세무서/징세과",
    kind: "assistant",
    metadata: {
      scoped: true,
      parentTaxOffice: "강남세무서",
      countsTowardStructure: false,
    },
  });
  graph.addEdge(taxOffice.id, scoped.id, { type: "assistant" });

  const result = enrichGraphWithLawMap(graph, {
    국세청: {
      징세과: { laws: [{ 법령명: "국세징수법" }] },
    },
  });

  assert.equal(result.excludedScopedNodes, 1);
  assert.equal(result.matchedDepartments, 1);
  assert.equal(graph.nodeByName("징세과").metadata.lawResponsibility.lawCount, 1);
  assert.equal(scoped.metadata.lawResponsibility, undefined);
});

test("소관법령 지도는 같은 이름의 비 scoped 후보가 여럿이면 임의 매칭하지 않는다", () => {
  const graph = parseOrganizationTexts([
    `@기관: 시험부
제2조(하부조직) 시험부에 정책과를 둔다.`,
  ]);
  graph.addNode("정책과", { id: "별도기관/정책과", kind: "assistant" });

  const result = enrichGraphWithLawMap(graph, {
    시험부: {
      정책과: { laws: [{ 법령명: "정책법" }] },
    },
  });

  assert.equal(result.matchedDepartments, 0);
  assert.equal(result.ambiguousDepartments.length, 1);
  assert.equal(result.ambiguousDepartments[0].candidates.length, 2);
  assert.equal(graph.nodeByName("정책과").metadata.lawResponsibility, undefined);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half" }));
  assert.equal(report.reviewActions.some((action) => action.topic === "law-map" && /충돌/.test(action.message)), true);
  assert.match(formatAuditMarkdown(report), /중복 후보 부서/);
});

test("소관법령 색인 페이지는 법령 수 순으로 대표 법령을 묶는다", () => {
  const graph = parseOrganizationTexts([
    `@기관: 시험부
제2조(하부조직) 시험부에 정책과 및 운영과를 둔다.`,
  ]);
  enrichGraphWithLawMap(graph, {
    시험부: {
      정책과: { laws: [{ 법령명: "정책법" }, { 법령명: "정책령" }] },
      운영과: { laws: [{ 법령명: "운영법" }] },
    },
  });
  const pages = buildLawAppendixPages(graph, { entriesPerPage: 1, representativesPerDepartment: 1 });
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.lawEntries[0].name), ["정책과", "운영과"]);
  assert.deepEqual(pages[0].lawEntries[0].laws, [{ 법령명: "정책법" }]);
});
