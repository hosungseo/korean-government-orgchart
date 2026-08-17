import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLegalDutyFacts,
  dutyFunctionSimilarity,
  extractLegalDutyItems,
  formatLegalDutyCitation,
} from "../src/legal-duty.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

test("분장사무의 조·항·호·목 주소와 줄바꿈 문언을 보존한다", () => {
  const items = extractLegalDutyItems(`
1. 국제문화교류 진흥 종합계획의 수립 및
   시행에 관한 사항
1의2. 해외 언론매체 협력
  가. 외국 언론인 초청
  나. 취재 지원
2. 삭제 <2025. 1. 1.>
3. 그 밖에 다른 과의 주관에 속하지 않는 사항
`, {
    article: "제10조(국제문화정책과)",
    paragraph: 2,
    source: "직제 시행규칙",
    role: "rule",
  });

  assert.equal(items.length, 4);
  assert.equal(items[0].text, "국제문화교류 진흥 종합계획의 수립 및 시행에 관한 사항");
  assert.equal(items[0].citation, "제10조(국제문화정책과)제2항제1호");
  assert.equal(items[1].number, "1의2");
  assert.equal(items[1].items.length, 2);
  assert.equal(items[1].items[0].citation, "제10조(국제문화정책과)제2항제1의2호가목");
  assert.equal(items[2].deleted, true);
  assert.equal(items[3].residual, true);
});

test("직제와 시행규칙에서 읽은 각 호를 출처가 있는 법령 사실로 저장한다", () => {
  const graph = parseOrganizationTexts([
    `시험부 직제
제10조(문화정책실)
① 문화정책실장은 다음 사항을 분장한다.
1. 국제문화교류 정책의 수립
2. 해외 문화사업 지원`,
    `시험부 직제 시행규칙
제7조(문화정책실)
① 국제문화과장은 다음 사항을 분장한다.
1. 국제문화교류 정책의 수립
2. 해외 문화사업 지원`,
  ], {
    institution: "시험부",
    sources: ["시험부 직제", "시험부 직제 시행규칙"],
  });

  assert.equal(graph.meta.dutyFacts.length, 4);
  assert.deepEqual([...new Set(graph.meta.dutyFacts.map((fact) => fact.role))].sort(), ["decree", "rule"]);
  const departmentFact = graph.meta.dutyFacts.find((fact) => fact.owner === "국제문화과");
  assert.equal(departmentFact.ownerKind, "department");
  assert.equal(departmentFact.citation, "제7조(문화정책실)제1항제1호");
  assert.equal(departmentFact.source, "시험부 직제 시행규칙");
  const audit = auditLegalDutyFacts(graph);
  assert.equal(audit.status, "ok");
  assert.equal(audit.conflictingCitations.length, 0);
  assert.ok(audit.coveredDepartments >= 1);
});

test("표현이 달라도 핵심 기능이 같은 해외언론 사무는 높은 유사도로 읽는다", () => {
  const score = dutyFunctionSimilarity(
    "한국 관련 외신 보도의 수집 및 분석",
    "한국 관련 해외 언론매체의 보도 수집ㆍ분석",
  );
  assert.equal(score, 1);
  assert.equal(formatLegalDutyCitation({ article: "제9조", paragraph: 3, subparagraph: "1의2" }), "제9조제3항제1의2호");
});
