import test from "node:test";
import assert from "node:assert/strict";
import { nodeLabelLines, nodeLabelMetrics, wrapHorizontalLabel } from "../src/label.mjs";

test("긴 가로 조직명은 상자 폭에 맞춰 여러 줄로 줄바꿈한다", () => {
  const node = { name: "초장기전략산업정책총괄조정관리국", metadata: {} };
  const position = { width: 96, height: 32, vertical: false };
  const lines = nodeLabelLines(node, position);
  const metrics = nodeLabelMetrics(node, position, lines);

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => [...line].length <= 10));
  assert.ok(metrics.fontSize < 12.5);
});

test("가로 조직명 줄바꿈은 최대 줄 수를 넘으면 말줄임표를 붙인다", () => {
  const lines = wrapHorizontalLabel("매우긴조직명칭을좁은상자안에읽히게넣기", { width: 72, height: 28 });

  assert.equal(lines.length, 2);
  assert.match(lines.at(-1), /…$/);
});

test("세로 과 상자는 기존 한 글자 한 줄 방식을 유지한다", () => {
  const node = { name: "전략기획과", metadata: {} };
  const lines = nodeLabelLines(node, { width: 34, height: 96, vertical: true });

  assert.deepEqual(lines.slice(0, 4), ["전", "략", "기", "획"]);
});
