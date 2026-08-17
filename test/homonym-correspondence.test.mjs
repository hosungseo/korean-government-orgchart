import test from "node:test";
import assert from "node:assert/strict";
import { buildNativeComparisonWorkflow } from "../src/native-law-workflow.mjs";

const DECREE = `시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 국립시험원 및 국립검정원을 둔다.`;

const RULE_BOTH = `시험부와 그 소속기관 직제 시행규칙
제5조(국립시험원) 국립시험원에 기획과를 둔다.
① 기획과장은 다음 사항을 분장한다.
1. 시험원 예산의 편성 및 집행
2. 시험원 보안 및 관인 관리
제6조(국립검정원) 국립검정원에 기획과를 둔다.
① 기획과장은 다음 사항을 분장한다.
1. 검정원 예산의 편성 및 집행
2. 검정원 보안 및 관인 관리`;

const RULE_ONE = `시험부와 그 소속기관 직제 시행규칙
제5조(국립시험원) 국립시험원에 기획과를 둔다.
① 기획과장은 다음 사항을 분장한다.
1. 시험원 예산의 편성 및 집행
2. 시험원 보안 및 관인 관리`;

function correspondenceWraps(workflow) {
  return workflow.manifests.flatMap((manifest) => manifest.objects)
    .map((object) => object.metadata || {})
    .filter((metadata) => metadata.role === "correspondence-wrap");
}

test("동명이과 작도: 소속이 다른 같은 과명 사이에는 존속선을 긋지 않는다", () => {
  const identical = buildNativeComparisonWorkflow({
    stages: [
      { decreeText: DECREE, ruleText: RULE_BOTH, institution: "시험부", asOf: "2025-01-01" },
      { decreeText: DECREE, ruleText: RULE_BOTH, institution: "시험부", asOf: "2026-01-01" },
    ],
    onePage: true,
  });
  assert.equal(correspondenceWraps(identical).length, 0, "동일 구조 대비에는 변경선이 없어야 한다");

  const abolished = buildNativeComparisonWorkflow({
    stages: [
      { decreeText: DECREE, ruleText: RULE_BOTH, institution: "시험부", asOf: "2025-01-01" },
      { decreeText: DECREE, ruleText: RULE_ONE, institution: "시험부", asOf: "2026-01-01" },
    ],
    onePage: true,
  });
  const crossSurvivor = correspondenceWraps(abolished)
    .filter((metadata) => metadata.basis === "exact-name" && metadata.unit === "기획과");
  assert.equal(crossSurvivor.length, 0, "검정원 기획과가 시험원 기획과로 존속 처리되면 안 된다");
});
