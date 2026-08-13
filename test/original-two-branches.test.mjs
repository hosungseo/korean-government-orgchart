import test from "node:test";
import assert from "node:assert/strict";
import { renderOriginalTwoBranchesSvg } from "../src/render-original-two-branches.mjs";

test("원형복원 2계선 조직도는 실·국·과를 독립 계선으로 그리고 평가대상을 표시한다", () => {
  const svg = renderOriginalTwoBranchesSvg({
    branches: [
      {
        name: "인공지능정부실",
        grade: "고위 가",
        bureaus: [{ name: "정책국", y: 100, items: ["정책과", { name: "포털과", evaluation: true }] }],
      },
      {
        name: "참여혁신조직실",
        grade: "고위 가",
        evaluation: true,
        bureaus: [{ name: "조직국", grade: "고위 나", y: 100, items: ["조직과"] }],
      },
    ],
  });

  assert.match(svg, /viewBox="0 0 510\.24 756\.84"/);
  assert.equal((svg.match(/data-branch-trunk=/g) || []).length, 2);
  assert.equal((svg.match(/data-bureau-link=/g) || []).length, 2);
  assert.equal((svg.match(/data-division-spine=/g) || []).length, 2);
  assert.equal((svg.match(/data-evaluation="true"/g) || []).length, 2);
  assert.match(svg, /#FFF20A/);
  assert.match(svg, /#BDF4C7/);
  assert.doesNotMatch(svg, /marker-end|stroke-dasharray="4 3"|data-change|변경 레인/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});
