import { inferRank } from "./model.mjs";

export const SLIDE_SIZE = { width: 1122.67, height: 720 };

export function planPages(graph, { mode = "auto", maxNodes = 38 } = {}) {
  const head = graph.findHead() || graph.nodes.get(graph.rootId);
  const deputy = graph.findDeputy();
  const affiliates = graph
    .childrenOf(graph.rootId)
    .filter(({ edge, node }) => edge.type === "affiliated" || node.kind === "affiliated")
    .map(({ node }) => node);
  const ordinaryCount = [...graph.nodes.values()].filter(
    (node) => node.kind !== "institution" && node.kind !== "affiliated",
  ).length;
  const compactLimit = Math.min(maxNodes, 32);
  const selectedMode = mode === "auto" ? (ordinaryCount <= compactLimit ? "compact" : "split") : mode;
  const pages = [];
  const mainDetails = [];
  const affiliateDetails = [];

  if (selectedMode === "compact") {
    const nodeIds = new Set([head.id, ...graph.descendantsOf(head.id).map((node) => node.id)]);
    pages.push({
      kind: "compact",
      title: graph.meta.title,
      subtitle: "직제 문언 기반 조직도",
      rootIds: [head.id],
      nodeIds: [...nodeIds],
      breadcrumb: [],
    });
  } else {
    const overviewNodes = new Set([
      head.id,
      ...graph.descendantsOf(head.id, { depth: 2 }).map((node) => node.id),
    ]);
    pages.push({
      kind: "overview",
      title: graph.meta.title,
      subtitle: "본부 기구 개요",
      rootIds: [head.id],
      nodeIds: [...overviewNodes],
      breadcrumb: [],
    });

    const branchParent = deputy || head;
    const branchCandidates = graph
      .childrenOf(branchParent.id)
      .filter(
        ({ node }) =>
          node.id !== head.id &&
          node.kind !== "affiliated" &&
          graph.childrenOf(node.id).length > 0,
      )
      .map(({ node }) => node);
    const headBranches = graph
      .childrenOf(head.id)
      .filter(
        ({ node }) =>
          node.id !== deputy?.id &&
          node.kind !== "affiliated" &&
          graph.childrenOf(node.id).length > 0,
      )
      .map(({ node }) => node);
    const branchMap = new Map([...branchCandidates, ...headBranches].map((node) => [node.id, node]));
    for (const branch of branchMap.values()) {
      mainDetails.push(...splitBranchPages(graph, branch, maxNodes, [graph.meta.institution]));
    }
    pages.push(...packDetailPages(mainDetails, maxNodes, "본부 하부조직"));
  }

  for (const affiliate of affiliates) {
    const descendants = graph.descendantsOf(affiliate.id);
    if (!descendants.length) {
      affiliateDetails.push({
        kind: "affiliates",
        title: graph.meta.title,
        subtitle: affiliate.name,
        rootIds: [affiliate.id],
        nodeIds: [affiliate.id],
        breadcrumb: ["소속기관", affiliate.name],
      });
    } else {
      affiliateDetails.push(...splitBranchPages(graph, affiliate, maxNodes, ["소속기관"]));
    }
  }

  pages.push(...packDetailPages(affiliateDetails, maxNodes, "소속기관"));

  return pages.map((page, index) => ({ ...page, pageNumber: index + 1, pageCount: pages.length }));
}

function packDetailPages(specs, maxNodes, label) {
  const packed = [];
  let current = null;
  for (const spec of specs) {
    const ids = new Set(spec.nodeIds);
    if (!current) {
      current = {
        ...spec,
        rootIds: [...spec.rootIds],
        nodeIds: [...ids],
        subtitle: label,
      };
      continue;
    }
    const mergedIds = new Set([...current.nodeIds, ...ids]);
    const intersects = [...ids].some((id) => current.nodeIds.includes(id));
    const rootConflict =
      spec.rootIds.some((id) => current.nodeIds.includes(id)) ||
      current.rootIds.some((id) => ids.has(id));
    if (mergedIds.size <= maxNodes && !intersects && !rootConflict) {
      current.rootIds = [...new Set([...current.rootIds, ...spec.rootIds])];
      current.nodeIds = [...mergedIds];
      continue;
    }
    packed.push(current);
    current = {
      ...spec,
      rootIds: [...spec.rootIds],
      nodeIds: [...ids],
      subtitle: label,
    };
  }
  if (current) packed.push(current);
  return packed.map((page, index) => ({
    ...page,
    subtitle: packed.length > 1 ? `${label} (${index + 1})` : label,
  }));
}

function splitBranchPages(graph, branch, maxNodes, breadcrumb) {
  const all = [branch, ...graph.descendantsOf(branch.id)];
  if (all.length <= maxNodes) {
    return [
      {
        kind: branch.kind === "affiliated" ? "affiliate-detail" : "branch",
        title: graph.meta.title,
        subtitle: branch.name,
        rootIds: [branch.id],
        nodeIds: all.map((node) => node.id),
        breadcrumb: [...breadcrumb, branch.name],
      },
    ];
  }

  const children = graph.childrenOf(branch.id).map(({ node }) => node);
  if (!children.length) {
    return [
      {
        kind: "branch",
        title: graph.meta.title,
        subtitle: branch.name,
        rootIds: [branch.id],
        nodeIds: [branch.id],
        breadcrumb: [...breadcrumb, branch.name],
      },
    ];
  }

  const pages = [];
  const smallGroups = [];
  let smallCount = 1;
  for (const child of children) {
    const subtree = [child, ...graph.descendantsOf(child.id)];
    if (subtree.length >= maxNodes - 2) {
      pages.push(...splitBranchPages(graph, child, maxNodes, [...breadcrumb, branch.name]));
      continue;
    }
    if (smallCount + subtree.length > maxNodes && smallGroups.length) {
      pages.push(branchChunkPage(graph, branch, smallGroups.splice(0), breadcrumb, pages.length));
      smallCount = 1;
    }
    smallGroups.push(...subtree);
    smallCount += subtree.length;
  }
  if (smallGroups.length) {
    pages.push(branchChunkPage(graph, branch, smallGroups, breadcrumb, pages.length));
  }
  return pages;
}

function branchChunkPage(graph, branch, nodes, breadcrumb, chunkIndex) {
  return {
    kind: branch.kind === "affiliated" ? "affiliate-detail" : "branch",
    title: graph.meta.title,
    subtitle: `${branch.name}${chunkIndex ? ` (${chunkIndex + 1})` : ""}`,
    rootIds: [branch.id],
    nodeIds: [branch.id, ...nodes.map((node) => node.id)],
    breadcrumb: [...breadcrumb, branch.name],
  };
}

export function layoutPage(graph, page, options = {}) {
  const frame = {
    left: options.left ?? 38,
    top: options.top ?? 118,
    width: options.width ?? SLIDE_SIZE.width - 76,
    height: options.height ?? SLIDE_SIZE.height - 150,
  };
  const selected = new Set(page.nodeIds);
  const parentEdge = new Map();
  for (const edge of graph.edges.values()) {
    if (!selected.has(edge.parent) || !selected.has(edge.child)) continue;
    if (!parentEdge.has(edge.child)) parentEdge.set(edge.child, edge);
  }
  const children = new Map();
  for (const edge of parentEdge.values()) {
    if (!children.has(edge.parent)) children.set(edge.parent, []);
    children.get(edge.parent).push(edge.child);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => {
      const left = graph.nodes.get(a);
      const right = graph.nodes.get(b);
      return (left?.rank ?? 9) - (right?.rank ?? 9) || left?.name.localeCompare(right?.name, "ko");
    });
  }
  const roots = page.rootIds
    .filter((id) => selected.has(id))
    .concat([...selected].filter((id) => !parentEdge.has(id) && !page.rootIds.includes(id)));
  const depth = new Map();
  const queue = roots.map((id) => ({ id, level: 0 }));
  while (queue.length) {
    const current = queue.shift();
    if (depth.has(current.id) && depth.get(current.id) <= current.level) continue;
    depth.set(current.id, current.level);
    for (const childId of children.get(current.id) || []) {
      queue.push({ id: childId, level: current.level + 1 });
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const leafWeightMemo = new Map();
  const leafWeight = (id) => {
    if (leafWeightMemo.has(id)) return leafWeightMemo.get(id);
    const childIds = children.get(id) || [];
    const value = childIds.length
      ? Math.max(2, childIds.reduce((sum, childId) => sum + leafWeight(childId), 0))
      : 1;
    leafWeightMemo.set(id, Math.max(1, value));
    return Math.max(1, value);
  };
  const totalWeight = Math.max(1, roots.reduce((sum, id) => sum + leafWeight(id), 0));
  const verticalLeaves = totalWeight > 11 || selected.size > 18;
  const leafHeight = verticalLeaves ? 132 : 34;
  const usableHeight = Math.max(220, frame.height - leafHeight - 20);
  const levelGap = maxDepth ? Math.min(209, usableHeight / maxDepth) : 0;
  const positions = new Map();

  let cursor = frame.left;
  for (const rootId of roots) {
    const width = (frame.width * leafWeight(rootId)) / totalWeight;
    assignPositions(rootId, cursor, width);
    cursor += width;
  }

  function assignPositions(id, spanLeft, spanWidth) {
    const node = graph.nodes.get(id);
    if (!node) return;
    const childIds = children.get(id) || [];
    const level = depth.get(id) || 0;
    const isLeaf = childIds.length === 0;
    let width;
    let height;
    let vertical = false;
    if (isLeaf && verticalLeaves && level > 0) {
      width = Math.min(32, Math.max(24, spanWidth * 0.7));
      height = leafHeight;
      vertical = true;
    } else {
      width = Math.min(168, Math.max(28, Math.min(spanWidth * 0.78, 88 + node.name.length * 4.6)));
      height = 32;
    }
    const centerX = spanLeft + spanWidth / 2;
    const top = frame.top + level * levelGap;
    positions.set(id, {
      left: centerX - width / 2,
      top,
      width,
      height,
      centerX,
      bottom: top + height,
      vertical,
      depth: level,
      spanLeft,
      spanWidth,
    });
    let childCursor = spanLeft;
    const parentWeight = leafWeight(id);
    for (const childId of childIds) {
      const childWidth = (spanWidth * leafWeight(childId)) / parentWeight;
      assignPositions(childId, childCursor, childWidth);
      childCursor += childWidth;
    }
  }

  const edges = [...parentEdge.values()]
    .map((edge) => ({
      ...edge,
      from: positions.get(edge.parent),
      to: positions.get(edge.child),
    }))
    .filter((edge) => edge.from && edge.to);
  const nodes = [...positions.entries()].map(([id, position]) => ({
    node: graph.nodes.get(id),
    position,
  }));
  return { frame, nodes, edges, roots, maxDepth, verticalLeaves };
}

export function nodeStyle(node) {
  const metadata = node.metadata || {};
  if (node.kind === "head" || node.kind === "deputy") {
    return { fill: "#AEC6F0", line: "#00004E", text: "#111827", lineStyle: "solid", bold: true };
  }
  if (node.kind === "affiliated") {
    return { fill: "#55B947", line: "#2D7D2D", text: "#FFFFFF", lineStyle: "solid", bold: true };
  }
  if (node.kind === "temporary" || metadata.temporary || metadata.autonomous) {
    return { fill: "#DDF4D7", line: "#2F8F2F", text: "#154D15", lineStyle: "dashed", bold: false };
  }
  if (node.kind === "advisor") {
    return { fill: "#F5F5F5", line: "#8B8B8B", text: "#1F2937", lineStyle: "dashed", bold: false };
  }
  const rank = node.rank ?? inferRank(node.name, node.kind);
  return {
    fill: rank <= 3 ? "#FFFFFF" : "#FAFAFA",
    line: "#7A7A7A",
    text: "#111827",
    lineStyle: "solid",
    bold: rank <= 3,
  };
}

export function displayNodeName(node, vertical = false, { showLawCounts = false } = {}) {
  const markers = [];
  if (node.metadata?.grade) markers.push(node.metadata.grade);
  if (node.metadata?.employmentType === "임기제") markers.push("임");
  if (node.metadata?.employmentType === "별정직") markers.push("별");
  const staffMarkers = {
    연구직: "연",
    지도직: "지",
    전문직: "전",
    전문경력관: "전",
    특정직: "특",
  };
  for (const category of node.metadata?.staffCategories || []) {
    if (staffMarkers[category] && !markers.includes(staffMarkers[category])) markers.push(staffMarkers[category]);
  }
  if (node.metadata?.responsible) markers.push("책");
  if (node.metadata?.payroll) markers.push("총");
  if (node.metadata?.autonomous) markers.push("자");
  if (node.metadata?.evaluation) markers.push("평");
  if (node.metadata?.temporary) markers.push("한");
  const marker = markers.length ? ` ${markers.map((value) => `(${value})`).join("")}` : "";
  const count = node.metadata?.count > 1 ? ` ${node.metadata.count}명` : "";
  const expiry =
    !vertical && node.metadata?.temporary && node.metadata?.expires
      ? ` ~${node.metadata.expires.replaceAll("-", ".")}`
      : "";
  const concurrent =
    !vertical && node.metadata?.concurrentWith ? ` [${node.metadata.concurrentWith} 겸직]` : "";
  const specificRank =
    !vertical && node.metadata?.specificRank ? ` [${node.metadata.specificRank}]` : "";
  const lawCount =
    showLawCounts && !vertical && node.metadata?.lawResponsibility?.lawCount
      ? ` (법 ${node.metadata.lawResponsibility.lawCount})`
      : "";
  const label = `${node.name}${count}${marker}${lawCount}${expiry}${concurrent}${specificRank}`;
  return vertical ? [...label].join("\n") : label;
}
