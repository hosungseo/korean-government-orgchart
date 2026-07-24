import test from "node:test";
import assert from "node:assert/strict";
import { buildLawAppendixPages, enrichGraphWithLawMap } from "../src/law-map.mjs";
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
