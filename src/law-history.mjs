import { stableId } from "./utils-core.mjs";

export const LAW_HISTORY_SCHEMA = "kr.go.mois.orgchart.history/v1";

export function createLawSnapshot(workflow, options = {}) {
  if (!workflow?.snapshot || typeof workflow.snapshot !== "object") {
    throw new TypeError("조직도 workflow에 저장할 스냅샷이 없습니다.");
  }
  const snapshot = structuredClone(workflow.snapshot);
  const capturedAt = options.capturedAt || new Date().toISOString();
  const id = options.id || `snapshot-${Date.now()}-${stableId(`${snapshot.institution}|${snapshot.asOf || ""}|${capturedAt}`).slice(2, 10)}`;
  return {
    ...snapshot,
    schema: LAW_HISTORY_SCHEMA,
    id,
    capturedAt,
    label: options.label || `${snapshot.institution || "행정기관"} · ${snapshot.asOf || "기준일 없음"}`,
  };
}

export function summarizeLawSnapshot(snapshot) {
  const graph = snapshot?.graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const visibleNodes = nodes.filter((node) => node?.kind !== "institution");
  return {
    id: String(snapshot?.id || ""),
    label: String(snapshot?.label || snapshot?.institution || "조직도"),
    institution: String(snapshot?.institution || ""),
    asOf: snapshot?.asOf || null,
    capturedAt: snapshot?.capturedAt || null,
    nodeCount: visibleNodes.length,
    relationCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
    lawNames: Array.isArray(snapshot?.laws) ? snapshot.laws.map((law) => law?.name).filter(Boolean) : [],
  };
}

export function compareLawSnapshots(previous, current) {
  const before = normalizeSnapshot(previous);
  const after = normalizeSnapshot(current);
  if (before.institution && after.institution && before.institution !== after.institution) {
    throw new Error("서로 다른 기관의 조직도는 비교할 수 없습니다.");
  }

  const beforeParents = parentMap(before.graph);
  const afterParents = parentMap(after.graph);
  const beforeNodes = new Map(before.graph.nodes.filter(isVisibleNode).map((node) => [node.id, node]));
  const afterNodes = new Map(after.graph.nodes.filter(isVisibleNode).map((node) => [node.id, node]));
  const removed = [...beforeNodes.values()].filter((node) => !afterNodes.has(node.id));
  const added = [...afterNodes.values()].filter((node) => !beforeNodes.has(node.id));
  const renamed = detectRenames(removed, added, beforeParents, afterParents, before.graph, after.graph);
  const renamedBefore = new Set(renamed.map((item) => item.before.id));
  const renamedAfter = new Set(renamed.map((item) => item.after.id));

  const moved = [];
  const changed = [];
  for (const [id, oldNode] of beforeNodes) {
    const newNode = afterNodes.get(id);
    if (!newNode) continue;
    const oldPath = pathForNode(oldNode, before.graph, beforeParents);
    const newPath = pathForNode(newNode, after.graph, afterParents);
    if (oldPath.slice(0, -1).join("/") !== newPath.slice(0, -1).join("/")) {
      moved.push({ node: newNode, beforePath: oldPath, afterPath: newPath });
    }
    if (oldNode.kind !== newNode.kind || oldNode.rank !== newNode.rank) {
      changed.push({ node: newNode, before: oldNode, after: newNode, beforePath: oldPath, afterPath: newPath });
    }
  }

  const remainingRemoved = removed.filter((node) => !renamedBefore.has(node.id));
  const remainingAdded = added.filter((node) => !renamedAfter.has(node.id));
  const result = {
    schema: `${LAW_HISTORY_SCHEMA}/diff`,
    institution: after.institution || before.institution,
    previous: summarizeLawSnapshot(previous),
    current: summarizeLawSnapshot(current),
    added: remainingAdded.map((node) => changeNode(node, after.graph, afterParents)),
    removed: remainingRemoved.map((node) => changeNode(node, before.graph, beforeParents)),
    renamed: renamed.map((item) => ({
      before: changeNode(item.before, before.graph, beforeParents),
      after: changeNode(item.after, after.graph, afterParents),
    })),
    moved,
    changed,
  };
  result.summary = {
    added: result.added.length,
    removed: result.removed.length,
    renamed: result.renamed.length,
    moved: result.moved.length,
    changed: result.changed.length,
    totalChanges: result.added.length + result.removed.length + result.renamed.length + result.moved.length + result.changed.length,
  };
  return result;
}

function normalizeSnapshot(snapshot) {
  const graph = snapshot?.graph || snapshot;
  return {
    institution: String(snapshot?.institution || graph?.meta?.institution || ""),
    asOf: snapshot?.asOf || graph?.meta?.asOf || null,
    graph: {
      nodes: Array.isArray(graph?.nodes) ? graph.nodes.filter((node) => node?.id && node?.name) : [],
      edges: Array.isArray(graph?.edges) ? graph.edges.filter((edge) => edge?.parent && edge?.child) : [],
      rootId: graph?.rootId || null,
    },
  };
}

function isVisibleNode(node) {
  return node?.kind !== "institution";
}

function parentMap(graph) {
  const map = new Map();
  for (const edge of graph.edges || []) {
    if (!map.has(edge.child)) map.set(edge.child, []);
    map.get(edge.child).push(edge.parent);
  }
  return map;
}

function pathForNode(node, graph, parents) {
  const nodes = new Map((graph.nodes || []).map((item) => [item.id, item]));
  const path = [node.name];
  let current = node.id;
  const seen = new Set([current]);
  while (parents.get(current)?.length) {
    const parentId = parents.get(current)[0];
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = nodes.get(parentId);
    if (!parent || parent.kind === "institution") break;
    path.unshift(parent.name);
    current = parentId;
  }
  return path;
}

function changeNode(node, graph, parents) {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    path: pathForNode(node, graph, parents),
    parent: pathForNode(node, graph, parents).at(-2) || null,
  };
}

function detectRenames(removed, added, beforeParents, afterParents, beforeGraph, afterGraph) {
  const matches = [];
  const used = new Set();
  for (const oldNode of removed) {
    const oldPath = pathForNode(oldNode, beforeGraph, beforeParents);
    const candidates = added
      .filter((newNode) => !used.has(newNode.id))
      .map((newNode) => {
        const newPath = pathForNode(newNode, afterGraph, afterParents);
        const sameParent = oldPath.at(-2) && oldPath.at(-2) === newPath.at(-2);
        const sameKind = oldNode.kind === newNode.kind;
        const score = nameSimilarity(oldNode.name, newNode.name) + (sameParent ? 0.45 : 0) + (sameKind ? 0.25 : 0);
        return { newNode, score, sameParent, sameKind };
      })
      .filter((candidate) => candidate.sameParent && candidate.sameKind && candidate.score >= 0.85 && nameSimilarity(oldNode.name, candidate.newNode.name) >= 0.4)
      .sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best) continue;
    used.add(best.newNode.id);
    matches.push({ before: oldNode, after: best.newNode });
  }
  return matches;
}

function nameSimilarity(left, right) {
  const a = String(left).replace(/\s/g, "").replace(/(?:부서|실|국|과|팀|관|단|원|소)$/, "");
  const b = String(right).replace(/\s/g, "").replace(/(?:부서|실|국|과|팀|관|단|원|소)$/, "");
  if (a === b) return 1;
  const common = [...a].filter((character) => b.includes(character)).length;
  const denominator = Math.max(a.length, b.length, 1);
  return common / denominator;
}
