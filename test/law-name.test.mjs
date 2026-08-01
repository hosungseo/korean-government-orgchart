import test from "node:test";
import assert from "node:assert/strict";
import {
  inferredOrganizationLawNames,
  organizationLawNameCandidateGroups,
} from "../src/law-name.mjs";

test("기관명에서 직제와 시행규칙 후보 제명을 만든다", () => {
  const groups = organizationLawNameCandidateGroups("산업통상부");

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].candidates, ["산업통상부와 그 소속기관 직제", "산업통상부 직제"]);
  assert.deepEqual(groups[1].candidates, [
    "산업통상부와 그 소속기관 직제 시행규칙",
    "산업통상부 직제 시행규칙",
  ]);
});

test("이미 직제명이 들어와도 기관명으로 정리한 뒤 후보를 만든다", () => {
  assert.deepEqual(inferredOrganizationLawNames("재정경제부 직제"), [
    "재정경제부와 그 소속기관 직제",
    "재정경제부 직제",
    "재정경제부와 그 소속기관 직제 시행규칙",
    "재정경제부 직제 시행규칙",
  ]);
});
