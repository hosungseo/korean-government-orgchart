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
