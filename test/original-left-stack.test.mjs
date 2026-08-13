import test from "node:test";
import assert from "node:assert/strict";
import { renderOriginalLeftStackSvg } from "../src/render-original-left-stack.mjs";

test("왼쪽면 원형복원 조직도는 두 실을 같은 주계선에 위아래로 묶는다", () => {
  const svg = renderOriginalLeftStackSvg({
    offices: [
      {
        name: "제1실",
        y: 31,
        bureaus: [{ name: "제1국", y: 80, divisions: ["제1과", { name: "제2과", evaluation: true }] }],
      },
      {
        name: "제2실",
        y: 300,
        evaluation: true,
        bureaus: [{ name: "제2국", y: 350, divisions: ["제3과"] }],
      },
    ],
  });

  assert.match(svg, /viewBox="0 0 510\.24 756\.84"/);
  assert.equal((svg.match(/data-page-trunk=/g) || []).length, 1);
  assert.equal((svg.match(/data-office-link=/g) || []).length, 2);
  assert.equal((svg.match(/data-office-trunk=/g) || []).length, 2);
  assert.equal((svg.match(/data-bureau-link=/g) || []).length, 2);
  assert.equal((svg.match(/data-division-trunk=/g) || []).length, 2);
  assert.equal((svg.match(/data-evaluation="true"/g) || []).length, 2);
  assert.match(svg, /오른쪽면 배치 여백/);
  assert.doesNotMatch(svg, /marker-end|data-change|변경 레인|NaN|undefined/);
});
