import test from "node:test";
import assert from "node:assert/strict";
import { renderOriginalOrganizationComparisonSvg } from "../src/render-original-organization-comparison.mjs";

test("원형 복원 조직도는 좌우 독립 계선과 원본형 강조를 보존하고 변경선은 그리지 않는다", () => {
  const svg = renderOriginalOrganizationComparisonSvg({
    before: {
      groups: [{ y: 31, title: "기획관", grade: "고위 나", outlineTone: "magenta", items: [{ name: "담당관", tone: "green" }] }],
    },
    after: {
      groups: [{ y: 31, title: "연구실", grade: "고위 가", tone: "orange", outlineTone: "red", items: [{ name: "총괄부", tone: "purple", outlineTone: "blue" }] }],
    },
  });

  assert.match(svg, /viewBox="0 0 510\.24 756\.84"/);
  assert.equal((svg.match(/data-column-trunk=/g) || []).length, 2);
  assert.equal((svg.match(/data-child-spine=/g) || []).length, 2);
  assert.match(svg, /#FFF20A/);
  assert.match(svg, /#F36B14/);
  assert.match(svg, /stroke-dasharray="2\.5 3"/);
  assert.doesNotMatch(svg, /marker-end|data-change|row-arrow|변경 레인/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});
