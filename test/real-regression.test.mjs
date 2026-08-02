import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAuditReport } from "../src/audit.mjs";
import { planBestPages, scoreLayoutPages } from "../src/layout.mjs";
import { OrgGraph } from "../src/model.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CASES = [
  {
    label: "행정안전부",
    file: "outputs/행정안전부-20251125.json",
    focus: "재난안전관리본부",
    minNodes: 220,
    minEdges: 295,
    nodes: {
      행정안전부: "institution",
      장관: "head",
      차관: "deputy",
      재난안전관리본부: "assistant",
      중앙재난안전상황실: "advisor",
      국가기록원: "affiliated",
      국립과학수사연구원: "affiliated",
    },
    edges: [
      ["행정안전부", "국가기록원", "affiliated", { affiliationType: "subsidiary" }],
      ["행정안전부", "국립과학수사연구원", "affiliated", { affiliationType: "responsible" }],
      ["차관", "재난안전관리본부", "assistant"],
      ["재난안전관리본부", "중앙재난안전상황실", "advisor"],
      ["재난안전관리본부", "안전예방정책실", "assistant"],
    ],
  },
  {
    label: "문화체육관광부",
    file: "outputs/문화체육관광부-20250701.json",
    focus: "문화예술정책실",
    minNodes: 180,
    minEdges: 195,
    nodes: {
      문화체육관광부: "institution",
      장관: "head",
      제1차관: "deputy",
      제2차관: "deputy",
      문화예술정책실: "assistant",
      국민소통실: "assistant",
      차관보: "advisor",
      국립중앙박물관: "affiliated",
      국립현대미술관: "affiliated",
    },
    edges: [
      ["장관", "제1차관", "structural"],
      ["장관", "제2차관", "structural"],
      ["제1차관", "문화예술정책실", "assistant"],
      ["제2차관", "국민소통실", "assistant"],
      ["문화체육관광부", "국립중앙박물관", "affiliated", { affiliationType: "subsidiary" }],
      ["문화체육관광부", "국립현대미술관", "affiliated", { affiliationType: "responsible" }],
    ],
  },
  {
    label: "공정거래위원회",
    file: "outputs/공정거래위원회-20251013.json",
    focus: "사무처",
    minNodes: 70,
    minEdges: 75,
    nodes: {
      공정거래위원회: "institution",
      위원장: "head",
      부위원장: "deputy",
      사무처: "assistant",
      경쟁정책국: "assistant",
      기업협력정책관: "advisor",
      서울지방공정거래사무소: "affiliated",
    },
    edges: [
      ["공정거래위원회", "위원장", "structural"],
      ["위원장", "부위원장", "structural"],
      ["부위원장", "사무처", "assistant"],
      ["사무처", "경쟁정책국", "assistant"],
      ["경쟁정책국", "기업협력정책관", "advisor"],
      ["공정거래위원회", "서울지방공정거래사무소", "affiliated"],
    ],
  },
];

function loadGraph(relativePath) {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
  return { raw, graph: OrgGraph.fromJSON(raw) };
}

function nodeByName(graph, name) {
  const node = graph.nodeByName(name);
  assert.ok(node, `${name} 노드가 있어야 함`);
  return node;
}

function edgeByName(graph, parentName, childName, type) {
  const edge = [...graph.edges.values()].find((candidate) => {
    const parent = graph.nodes.get(candidate.parent);
    const child = graph.nodes.get(candidate.child);
    return parent?.name === parentName && child?.name === childName && (!type || candidate.type === type);
  });
  assert.ok(edge, `${parentName} → ${childName}${type ? ` [${type}]` : ""} 관계가 있어야 함`);
  return edge;
}

test("커밋된 실제 기관 JSON을 OrgGraph로 역복원한다", () => {
  for (const item of CASES) {
    const { raw, graph } = loadGraph(item.file);
    assert.equal(graph.meta.institution, item.label);
    assert.equal(graph.nodes.size, raw.nodes.length, `${item.label} 노드 수가 보존되어야 함`);
    assert.equal(graph.edges.size, raw.edges.length, `${item.label} 관계 수가 보존되어야 함`);
    assert.equal(graph.rootId, raw.rootId, `${item.label} 루트 ID가 보존되어야 함`);
  }
});

test("실제 기관 골든 케이스의 법정 구조와 기관 유형 구분을 보존한다", () => {
  for (const item of CASES) {
    const { graph } = loadGraph(item.file);
    assert.ok(graph.nodes.size >= item.minNodes, `${item.label} 노드 수가 과도하게 줄면 안 됨`);
    assert.ok(graph.edges.size >= item.minEdges, `${item.label} 관계 수가 과도하게 줄면 안 됨`);

    for (const [name, kind] of Object.entries(item.nodes)) {
      assert.equal(nodeByName(graph, name).kind, kind, `${item.label} ${name} kind`);
    }
    for (const [parent, child, type, metadata] of item.edges) {
      const edge = edgeByName(graph, parent, child, type);
      for (const [key, value] of Object.entries(metadata || {})) {
        assert.equal(edge.metadata?.[key], value, `${item.label} ${parent} → ${child} metadata.${key}`);
      }
    }
  }
});

test("실제 기관 핵심 분기는 A4 반쪽면 best-fit에서 깨끗하게 배치된다", () => {
  for (const item of CASES) {
    const { graph } = loadGraph(item.file);
    const pages = planBestPages(graph, {
      paper: "a4-half",
      focus: item.focus,
      maxNodes: 80,
    });
    const score = scoreLayoutPages(graph, pages);
    const report = buildAuditReport(graph, pages);

    assert.equal(pages.length, 1, `${item.label} ${item.focus}는 한쪽 면 1쪽으로 계획되어야 함`);
    assert.equal(score.totalIssues, 0, `${item.label} hard layout issues`);
    assert.equal(score.qualityIssues, 0, `${item.label} quality layout issues`);
    assert.equal(report.layoutDiagnostics[0].diagnostics.ok, true, `${item.label} hard diagnostics`);
    assert.equal(report.layoutDiagnostics[0].diagnostics.qualityOk, true, `${item.label} quality diagnostics`);
  }
});
