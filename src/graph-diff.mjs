import { OrgGraph } from "./model.mjs";

const IGNORE_KINDS = new Set(["institution", "head", "deputy"]);

export function compareOrgGraphs(beforeGraph, afterGraph, options = {}) {
  const result = OrgGraph.fromJSON(afterGraph.toJSON());
  result.meta.title = options.title || `${afterGraph.meta.title || afterGraph.meta.institution} 변경 비교`;
  result.meta.comparison = {
    before: comparisonSource(beforeGraph),
    after: comparisonSource(afterGraph),
    added: [],
    removed: [],
    moved: [],
    renamed: [],
    unchanged: 0,
  };

  const beforeByKey = comparableNodeMap(beforeGraph);
  const afterByKey = comparableNodeMap(afterGraph);
  const removedKeys = new Set([...beforeByKey.keys()].filter((key) => !afterByKey.has(key)));
  const addedKeys = new Set([...afterByKey.keys()].filter((key) => !beforeByKey.has(key)));
  const renamed = matchRenames({
    beforeGraph,
    afterGraph,
    removed: [...removedKeys].map((key) => beforeByKey.get(key)),
    added: [...addedKeys].map((key) => afterByKey.get(key)),
  });

  for (const item of renamed) {
    removedKeys.delete(nodeKey(item.before));
    addedKeys.delete(nodeKey(item.after));
    const node = result.nodes.get(item.after.id);
    if (!node) continue;
    node.metadata.change = "명칭변경";
    node.metadata.previousName = item.before.name;
    node.metadata.changeSource = "compare-json";
    node.metadata.changeScore = Number(item.score.toFixed(3));
    result.meta.comparison.renamed.push({
      from: item.before.name,
      to: item.after.name,
      parent: primaryParentNames(afterGraph, item.after).join(", "),
      score: Number(item.score.toFixed(3)),
    });
  }

  for (const key of addedKeys) {
    const afterNode = afterByKey.get(key);
    const node = result.nodes.get(afterNode.id);
    if (!node) continue;
    node.metadata.change = "신설";
    node.metadata.changeSource = "compare-json";
    result.meta.comparison.added.push(changeEntry(afterGraph, afterNode));
  }

  const removedIds = new Set();
  for (const key of removedKeys) {
    const beforeNode = beforeByKey.get(key);
    const node = cloneNodeInto(result, beforeNode);
    node.metadata.change = "폐지";
    node.metadata.changeSource = "compare-json";
    removedIds.add(beforeNode.id);
    result.meta.comparison.removed.push(changeEntry(beforeGraph, beforeNode));
  }
  copyRemovedEdges({ beforeGraph, result, removedIds });

  for (const [key, beforeNode] of beforeByKey.entries()) {
    if (!afterByKey.has(key) || addedKeys.has(key) || removedKeys.has(key)) continue;
    const afterNode = afterByKey.get(key);
    const beforeParents = parentSignature(beforeGraph, beforeNode);
    const afterParents = parentSignature(afterGraph, afterNode);
    if (sameList(beforeParents, afterParents)) {
      result.meta.comparison.unchanged += 1;
      continue;
    }
    const node = result.nodes.get(afterNode.id);
    if (!node) continue;
    node.metadata.change = "이체";
    node.metadata.previousParents = beforeParents;
    node.metadata.nextParents = afterParents;
    node.metadata.changeSource = "compare-json";
    result.meta.comparison.moved.push({
      name: afterNode.name,
      from: beforeParents,
      to: afterParents,
      kind: afterNode.kind,
    });
  }

  sortComparison(result.meta.comparison);
  return result;
}

function comparisonSource(graph) {
  return {
    institution: graph.meta.institution,
    title: graph.meta.title,
    asOf: graph.meta.asOf || null,
    nodes: graph.nodes.size,
    edges: graph.edges.size,
  };
}

function comparableNodeMap(graph) {
  const map = new Map();
  for (const node of graph.nodes.values()) {
    if (!isComparable(node)) continue;
    map.set(nodeKey(node), node);
  }
  return map;
}

function isComparable(node) {
  return node?.id && node?.name && !IGNORE_KINDS.has(node.kind);
}

function nodeKey(node) {
  if (node.metadata?.qualifiedName) return node.metadata.qualifiedName;
  if (node.metadata?.scoped && node.metadata?.parentTaxOffice) return `${node.metadata.parentTaxOffice}/${node.name}`;
  if (node.metadata?.scoped && node.metadata?.scope) return `${node.metadata.scope}/${node.name}`;
  return node.name;
}

function matchRenames({ beforeGraph, afterGraph, removed, added }) {
  const pairs = [];
  const usedAdded = new Set();
  const candidates = removed
    .map((beforeNode) => {
      let best = null;
      for (const afterNode of added) {
        if (usedAdded.has(afterNode.id)) continue;
        if (beforeNode.kind !== afterNode.kind) continue;
        const sameParent = intersects(primaryParentNames(beforeGraph, beforeNode), primaryParentNames(afterGraph, afterNode));
        const score = nameSimilarity(beforeNode.name, afterNode.name) + (sameParent ? 0.18 : 0);
        const threshold = sameParent ? 0.66 : 0.86;
        if (score < threshold) continue;
        if (!best || score > best.score) best = { before: beforeNode, after: afterNode, score };
      }
      return best;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    if (usedAdded.has(candidate.after.id)) continue;
    pairs.push(candidate);
    usedAdded.add(candidate.after.id);
  }
  return pairs;
}

function nameSimilarity(left, right) {
  const a = normalizeNameForCompare(left);
  const b = normalizeNameForCompare(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  const editScore = 1 - distance / Math.max(a.length, b.length);
  const lcsScore = longestCommonSubsequence(a, b) / Math.max(a.length, b.length);
  return Math.max(editScore, lcsScore);
}

function normalizeNameForCompare(value) {
  return String(value || "")
    .replace(/[()\[\]\s·ㆍ]/g, "")
    .replace(/(?:과|팀|담당관|정책관|기획관|관리관|실|국|본부|단|센터|사무소)$/g, "")
    .trim();
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function longestCommonSubsequence(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function parentSignature(graph, node) {
  return graph
    .parentsOf(node.id)
    .filter(({ node: parent }) => parent && !IGNORE_KINDS.has(parent.kind))
    .map(({ edge, node: parent }) => `${edge.type}:${parent.name}`)
    .sort();
}

function primaryParentNames(graph, node) {
  return graph
    .parentsOf(node.id)
    .filter(({ node: parent }) => parent && !IGNORE_KINDS.has(parent.kind))
    .map(({ node: parent }) => parent.name)
    .sort();
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function cloneNodeInto(graph, node) {
  const existing = graph.nodes.get(node.id);
  if (existing) return existing;
  const clone = structuredClone(node);
  clone.metadata = structuredClone(node.metadata || {});
  clone.sources = Array.isArray(node.sources) ? [...node.sources] : [];
  graph.nodes.set(clone.id, clone);
  return clone;
}

function copyRemovedEdges({ beforeGraph, result, removedIds }) {
  for (const edge of beforeGraph.edges.values()) {
    if (!removedIds.has(edge.child) && !removedIds.has(edge.parent)) continue;
    const parent = beforeGraph.nodes.get(edge.parent);
    const child = beforeGraph.nodes.get(edge.child);
    if (!parent || !child) continue;
    cloneNodeInto(result, parent);
    cloneNodeInto(result, child);
    const key = `${edge.parent}>${edge.child}`;
    if (result.edges.has(key)) continue;
    result.edges.set(key, {
      ...structuredClone(edge),
      metadata: {
        ...(edge.metadata || {}),
        comparison: "before-only",
      },
    });
  }
}

function changeEntry(graph, node) {
  return {
    name: node.name,
    kind: node.kind,
    parents: primaryParentNames(graph, node),
  };
}

function sortComparison(comparison) {
  for (const key of ["added", "removed", "moved", "renamed"]) {
    comparison[key].sort((a, b) => (a.name || a.to || "").localeCompare(b.name || b.to || "", "ko"));
  }
}
