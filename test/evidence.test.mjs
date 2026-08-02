import test from "node:test";
import assert from "node:assert/strict";
import { enrichGraphWithLawMap } from "../src/law-map.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";
import { summarizeEvidence } from "../src/evidence.mjs";

test("근거 요약은 입력 자료·관계별 조문 표시·소관법령 매칭을 한 번에 집계한다", () => {
  const graph = parseOrganizationTexts(
    [
      `시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 정책실을 둔다.`,
      `시험부와 그 소속기관 직제 시행규칙
제3조(정책실) 정책실에 정책과 및 지원과를 둔다.`,
    ],
    { asOf: "2026-07-24", sources: ["시험부 직제", "시험부 시행규칙"] },
  );
  enrichGraphWithLawMap(graph, {
    시험부: {
      정책과: { laws: [{ 법령명: "시험법" }] },
      없는과: { laws: [{ 법령명: "미연결법" }] },
    },
  }, { asOf: "2026-07-24", source: "dept-map.json" });

  const summary = summarizeEvidence(graph);
  assert.deepEqual(summary.sourceRoles, { decree: 1, rule: 1 });
  assert.ok(summary.traceRows >= 4);
  assert.ok(summary.citedRows >= 1);
  assert.equal(summary.lawMap.matchedDepartments, 1);
  assert.equal(summary.lawMap.lawCount, 1);
  assert.equal(summary.lawMap.unmatchedDepartments, 1);
  assert.ok(summary.relationStats.some((item) => item.relation === "보조기관"));
});
