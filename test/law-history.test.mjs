import test from "node:test";
import assert from "node:assert/strict";
import { compareLawSnapshots, createLawSnapshot } from "../src/law-history.mjs";

function snapshot(asOf, nodes, edges) {
  return {
    schema: "kr.go.mois.orgchart.history/v1",
    institution: "테스트부",
    asOf,
    graph: {
      meta: { institution: "테스트부", asOf },
      rootId: "root",
      nodes: [
        { id: "root", name: "테스트부", kind: "institution" },
        ...nodes,
      ],
      edges,
    },
    laws: [],
  };
}

test("law history diff reports added, removed, moved, and renamed units", () => {
  const before = snapshot("2021-01-01", [
    { id: "head", name: "기획조정실", kind: "head", rank: 1 },
    { id: "old", name: "조직관리과", kind: "assistant", rank: 5 },
    { id: "move", name: "정보화과", kind: "assistant", rank: 5 },
    { id: "gone", name: "폐지과", kind: "assistant", rank: 5 },
  ], [
    { parent: "root", child: "head", type: "structural" },
    { parent: "head", child: "old", type: "assistant" },
    { parent: "head", child: "move", type: "assistant" },
    { parent: "head", child: "gone", type: "assistant" },
  ]);
  const after = snapshot("2026-01-01", [
    { id: "head", name: "기획조정실", kind: "head", rank: 1 },
    { id: "new", name: "조직혁신과", kind: "assistant", rank: 5 },
    { id: "move", name: "정보화과", kind: "assistant", rank: 5 },
    { id: "newparent", name: "디지털정책국", kind: "unit", rank: 4 },
  ], [
    { parent: "root", child: "head", type: "structural" },
    { parent: "head", child: "new", type: "assistant" },
    { parent: "head", child: "newparent", type: "assistant" },
    { parent: "newparent", child: "move", type: "assistant" },
  ]);
  const diff = compareLawSnapshots(before, after);
  assert.equal(diff.summary.renamed, 1);
  assert.equal(diff.summary.moved, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.renamed[0].before.name, "조직관리과");
  assert.equal(diff.renamed[0].after.name, "조직혁신과");
});

test("createLawSnapshot preserves edited law text and assigns a stable record shape", () => {
  const workflow = {
    snapshot: {
      institution: "테스트부",
      asOf: "2026-01-01",
      graph: { nodes: [], edges: [] },
      laws: [{ role: "decree", text: "수정 문언" }],
    },
  };
  const result = createLawSnapshot(workflow, { id: "manual-1", capturedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(result.id, "manual-1");
  assert.equal(result.schema, "kr.go.mois.orgchart.history/v1");
  assert.equal(result.laws[0].text, "수정 문언");
  assert.equal(result.capturedAt, "2026-01-02T00:00:00.000Z");
});
