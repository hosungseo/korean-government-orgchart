import test from "node:test";
import assert from "node:assert/strict";
import { renderOrganizationComparisonSheetSvg } from "../src/render-organization-comparison-sheet.mjs";

test("변경선 없는 조직체계 비교도는 독립 계선 두 개와 정확한 하부조직 접점을 사용한다", () => {
  const svg = renderOrganizationComparisonSheetSvg({
    title: "시험기관 조직체계 전후 비교",
    rows: [
      {
        key: "policy",
        height: 120,
        before: { title: "정책실", grade: "고위 나", units: ["정책과", "지원과"], duties: "정책 기획·지원" },
        after: { title: "정책실", grade: "고위 가", units: ["정책총괄과", "지원과"], duties: "정책 총괄·지원" },
      },
      {
        key: "branches",
        height: 48,
        before: { title: "소속기관 13개", compact: true },
        after: { title: "소속기관 14개", compact: true },
      },
    ],
  });

  assert.match(svg, /viewBox="0 0 510\.24 756\.84"/);
  assert.equal((svg.match(/data-backbone=/g) || []).length, 2);
  assert.equal((svg.match(/data-comparison-row=/g) || []).length, 2);
  assert.equal((svg.match(/data-unit-stem=/g) || []).length, 2);
  assert.doesNotMatch(svg, /marker-end|stroke-dasharray|row-arrow|변경 레인|이관·통합/);
  assert.doesNotMatch(svg, /NaN|undefined/);
  assert.match(svg, /A4 세로 · 1쪽/);
  assert.match(svg, /정책총괄과/);
});
