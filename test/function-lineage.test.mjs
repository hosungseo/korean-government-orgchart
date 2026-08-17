import assert from "node:assert/strict";
import test from "node:test";
import { buildFunctionLineage } from "../src/function-lineage.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

const before = parseOrganizationTexts([`
시험부 직제 시행규칙
제5조(녹색문화실)
녹색문화실에 기후문화정책과를 둔다.
① 기후문화정책과장은 다음 사항을 분장한다.
1. 녹색문화 종합계획의 수립
2. 기후문화 조사 및 연구
3. 녹색문화 사업의 지원
4. 지역 기후문화 확산
`], { institution: "시험부", asOf: "2025-01-01" });

const after = parseOrganizationTexts([`
시험부 직제 시행규칙
제5조(녹색문화실)
녹색문화실에 녹색문화기획과ㆍ문화확산과를 둔다.
① 녹색문화기획과장은 다음 사항을 분장한다.
1. 녹색문화 종합계획의 수립
2. 기후문화 조사 및 연구
② 문화확산과장은 다음 사항을 분장한다.
1. 녹색문화 사업의 지원
2. 지역 기후문화 확산
`], { institution: "시험부", asOf: "2026-01-01" });

test("항등성: 같은 스냅샷은 전량 유지로 판정한다", () => {
  const result = buildFunctionLineage(before, before);
  const v = result.stats.verdicts;
  assert.equal(v["유지"], result.stats.beforeFunctions);
  for (const key of ["문언변경", "이관", "통합", "분할", "폐지후보", "신설후보"]) {
    assert.equal(v[key], 0, `${key}는 0이어야 한다`);
  }
});

test("과 분리 개편은 이관으로 추적되고 폐지·신설이 생기지 않는다", () => {
  const result = buildFunctionLineage(before, after);
  const v = result.stats.verdicts;
  assert.equal(v["폐지후보"], 0);
  assert.equal(v["신설후보"], 0);
  assert.equal(v["이관"], 4, "네 사무 모두 새 과로 이관");
  const targets = new Set(result.entries.map((entry) => entry.to));
  assert.ok(targets.has("녹색문화기획과") && targets.has("문화확산과"));
});

const homonymBefore = parseOrganizationTexts([`
시험부 직제 시행규칙
제5조(국립시험원)
① 기획과장은 다음 사항을 분장한다.
1. 시험원 예산의 편성 및 집행
2. 시험원 보안 및 관인 관리
제6조(국립검정원)
① 기획과장은 다음 사항을 분장한다.
1. 검정원 예산의 편성 및 집행
2. 검정원 보안 및 관인 관리
`], { institution: "시험부", asOf: "2025-01-01" });

const homonymAfter = parseOrganizationTexts([`
시험부 직제 시행규칙
제5조(국립시험원)
① 기획과장은 다음 사항을 분장한다.
1. 시험원 예산의 편성 및 집행
2. 시험원 보안 및 관인 관리
`], { institution: "시험부", asOf: "2026-01-01" });

test("동명이과: 소속기관이 다른 같은 과명은 서로 흡수되지 않는다", () => {
  const identity = buildFunctionLineage(homonymBefore, homonymBefore);
  assert.equal(identity.stats.verdicts["유지"], identity.stats.beforeFunctions, "항등성 유지");
  assert.equal(identity.stats.verdicts["통합"], 0);

  const result = buildFunctionLineage(homonymBefore, homonymAfter);
  const v = result.stats.verdicts;
  assert.equal(v["폐지후보"], 2, "검정원 기획과 사무 2건은 폐지후보여야 한다");
  const absorbed = result.entries.filter((entry) => entry.verdict === "이관" || entry.verdict === "통합");
  assert.equal(absorbed.length, 0, "검정원 사무가 시험원 기획과로 흡수되면 안 된다");
});
