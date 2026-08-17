import assert from "node:assert/strict";
import test from "node:test";
import { compareDepartmentDutyFunctions } from "../src/duty-lineage.mjs";
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

test("각 호 기능이 둘로 나뉘면 두 과의 점선 근거와 조문 쌍을 만든다", () => {
  const result = compareDepartmentDutyFunctions(before, after);
  const links = result.links.filter((link) => link.from === "기후문화정책과");
  assert.deepEqual(links.map((link) => link.to).sort(), ["녹색문화기획과", "문화확산과"]);
  assert.ok(links.every((link) => link.basis === "duty-function"));
  assert.ok(links.every((link) => link.matchedFunctions === 2));
  assert.ok(links.every((link) => link.sharePercent === 50));
  assert.ok(links.every((link) => link.evidence.every((item) => item.beforeCitation && item.afterCitation)));
  assert.equal(result.stats.acceptedFunctionMatches, 4);
  assert.equal(result.stats.unmatchedBeforeFunctions, 0);
});

test("잔여호와 삭제호는 기능 승계 점선의 분모에서 제외한다", () => {
  const left = parseOrganizationTexts([`
시험부 직제 시행규칙
제4조(기획실)
① 기획과장은 다음 사항을 분장한다.
1. 기획 총괄
2. 삭제 <2025. 1. 1.>
3. 그 밖에 다른 과의 주관에 속하지 않는 사항
`], { institution: "시험부" });
  const right = parseOrganizationTexts([`
시험부 직제 시행규칙
제4조(기획실)
① 총괄과장은 다음 사항을 분장한다.
1. 기획 총괄
`], { institution: "시험부" });
  const result = compareDepartmentDutyFunctions(left, right);
  assert.equal(result.before.functions, 1);
  assert.equal(result.after.functions, 1);
  assert.equal(result.stats.acceptedFunctionMatches, 1);
});
