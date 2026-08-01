import { inferRank } from "./model.mjs";

/**
 * Page formats used by the renderers.  The old 16:10 canvas remains the
 * default for backwards compatibility; the A4 sizes use CSS points so that
 * the SVG and editable PPTX have the same proportions when printed.
 */
export const SLIDE_SIZE = { width: 1122.67, height: 720, name: "slide" };
export const A4_PORTRAIT = { width: 595.28, height: 841.89, name: "a4-portrait" };
export const A4_LANDSCAPE = { width: 841.89, height: 595.28, name: "a4-landscape" };
// One independently printable half of a portrait A4 sheet.  This is the
// format used by the two-column review sheets in the corpus: callers can
// generate one side and impose two outputs on a sheet later.
export const A4_HALF = { width: 297.64, height: 841.89, name: "a4-half" };

export const PAGE_FORMATS = {
  slide: SLIDE_SIZE,
  "a4-portrait": A4_PORTRAIT,
  "a4-landscape": A4_LANDSCAPE,
  "a4-half": A4_HALF,
};

const VISUAL_LAYOUTS = new Set([
  "vertical",
  "vertical-stack",
  "horizontal",
  "horizontal-bus",
  "two-column",
  "matrix",
]);

export function resolvePageSize(value = "slide") {
  if (value && typeof value === "object" && Number.isFinite(value.width) && Number.isFinite(value.height)) {
    return value;
  }
  return PAGE_FORMATS[normalizePaper(value)] || SLIDE_SIZE;
}

export function normalizePaper(value) {
  const normalized = String(value || "slide").toLowerCase();
  if (normalized === "a4" || normalized === "portrait" || normalized === "a4p") return "a4-portrait";
  if (normalized === "landscape" || normalized === "a4l") return "a4-landscape";
  if (normalized === "half" || normalized === "a4-half" || normalized === "a4-half-portrait") return "a4-half";
  return PAGE_FORMATS[normalized] ? normalized : "slide";
}

export function inferLayoutStyle(graph, { paper = "slide", mode } = {}) {
  if (VISUAL_LAYOUTS.has(mode)) return normalizeLayoutStyle(mode);
  const format = normalizePaper(paper);
  if (format === "a4-portrait" || format === "a4-half") return "vertical-stack";
  if (format === "a4-landscape") return "horizontal-bus";

  const ordinary = [...graph.nodes.values()].filter(
    (node) => node.kind !== "institution" && node.kind !== "affiliated",
  );
  const affiliated = graph.childrenOf(graph.rootId).filter(
    ({ edge, node }) => edge.type === "affiliated" || node.kind === "affiliated",
  );
  if (affiliated.length && ordinary.length > 24) return "two-column";
  return ordinary.length > 18 ? "matrix" : "horizontal-bus";
}

function normalizeLayoutStyle(value) {
  if (value === "vertical" || value === "vertical-stack") return "vertical-stack";
  if (value === "horizontal" || value === "horizontal-bus") return "horizontal-bus";
  return value;
}

export function planPages(
  graph,
  { mode = "auto", maxNodes = 38, paper = "slide", layoutStyle, focus } = {},
) {
  const format = normalizePaper(paper);
  const requestedVisual = layoutStyle || (VISUAL_LAYOUTS.has(mode) ? mode : undefined);
  const visual = inferLayoutStyle(graph, { paper: format, mode: requestedVisual });
  // A portrait A4 page has less horizontal room.  Splitting earlier avoids
  // unreadable one-character-wide leaf boxes while still allowing callers to
  // override the limit explicitly through --max-nodes.
  const effectiveMaxNodes =
    maxNodes === 38 && format === "a4-half"
      ? 20
      : maxNodes === 38 && format === "a4-portrait"
        ? 28
        : maxNodes;
  const planningMode = requestedVisual ? "auto" : mode;
  const head = graph.findHead() || graph.nodes.get(graph.rootId);
  const deputy = graph.findDeputy();
  const affiliates = graph
    .childrenOf(graph.rootId)
    .filter(({ edge, node }) => edge.type === "affiliated" || node.kind === "affiliated")
    .map(({ node }) => node);
  const ordinaryCount = [...graph.nodes.values()].filter(
    (node) => node.kind !== "institution" && node.kind !== "affiliated",
  ).length;
  const compactLimit = Math.min(effectiveMaxNodes, 32);
  const selectedMode =
    planningMode === "auto"
      ? ordinaryCount <= compactLimit
        ? "compact"
        : "split"
      : planningMode;
  const pages = [];
  const mainDetails = [];
  const affiliateDetails = [];

  if (focus) {
    const focused = graph.nodeByName(focus);
    if (focused) {
      const nodeIds = [focused.id, ...graph.descendantsOf(focused.id).map((node) => node.id)];
      const focusedPage = {
        kind: focused.kind === "affiliated" ? "affiliate-detail" : "compact",
        title: graph.meta.title,
        subtitle: focused.name,
        rootIds: [focused.id],
        nodeIds: [...new Set(nodeIds)],
        breadcrumb: [focused.name],
        paper: format,
        layoutStyle: visual,
      };
      return [{ ...focusedPage, pageNumber: 1, pageCount: 1 }];
    }
    graph.addWarning(`--focus 대상 조직을 찾지 못했습니다: ${focus}`);
  }

  if (selectedMode === "compact") {
    const nodeIds = new Set([head.id, ...graph.descendantsOf(head.id).map((node) => node.id)]);
    pages.push({
      kind: "compact",
      title: graph.meta.title,
      subtitle: "직제 문언 기반 조직도",
      rootIds: [head.id],
      nodeIds: [...nodeIds],
      breadcrumb: [],
      paper: format,
      layoutStyle: visual,
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
      paper: format,
      layoutStyle: visual,
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
      mainDetails.push(...splitBranchPages(graph, branch, effectiveMaxNodes, [graph.meta.institution], format, visual));
    }
    pages.push(...packDetailPages(mainDetails, effectiveMaxNodes, "본부 하부조직", format, visual));
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
        paper: format,
        layoutStyle: visual,
      });
    } else {
      affiliateDetails.push(...splitBranchPages(graph, affiliate, effectiveMaxNodes, ["소속기관"], format, visual));
    }
  }

  pages.push(...packDetailPages(affiliateDetails, effectiveMaxNodes, "소속기관", format, visual));

  return pages.map((page, index) => ({ ...page, pageNumber: index + 1, pageCount: pages.length }));
}

function packDetailPages(specs, maxNodes, label, paper, layoutStyle) {
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
        paper: spec.paper || paper,
        layoutStyle: spec.layoutStyle || layoutStyle,
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
      paper: spec.paper || paper,
      layoutStyle: spec.layoutStyle || layoutStyle,
    };
  }
  if (current) packed.push(current);
  return packed.map((page, index) => ({
    ...page,
    subtitle: packed.length > 1 ? `${label} (${index + 1})` : label,
  })).map((page) => ({
    ...page,
    paper: page.paper || paper,
    layoutStyle: page.layoutStyle || layoutStyle,
  }));
}

function splitBranchPages(graph, branch, maxNodes, breadcrumb, paper = "slide", layoutStyle) {
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
        paper,
        layoutStyle,
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
        paper,
        layoutStyle,
      },
    ];
  }

  const pages = [];
  const smallGroups = [];
  let smallCount = 1;
  for (const child of children) {
    const subtree = [child, ...graph.descendantsOf(child.id)];
    if (subtree.length >= maxNodes - 2) {
      pages.push(...splitBranchPages(graph, child, maxNodes, [...breadcrumb, branch.name], paper, layoutStyle));
      continue;
    }
    if (smallCount + subtree.length > maxNodes && smallGroups.length) {
      pages.push(
        branchChunkPage(
          graph,
          branch,
          smallGroups.splice(0),
          breadcrumb,
          pages.length,
          paper,
          layoutStyle,
        ),
      );
      smallCount = 1;
    }
    smallGroups.push(...subtree);
    smallCount += subtree.length;
  }
  if (smallGroups.length) {
    pages.push(branchChunkPage(graph, branch, smallGroups, breadcrumb, pages.length, paper, layoutStyle));
  }
  return pages;
}

function branchChunkPage(graph, branch, nodes, breadcrumb, chunkIndex, paper = "slide", layoutStyle) {
  return {
    kind: branch.kind === "affiliated" ? "affiliate-detail" : "branch",
    title: graph.meta.title,
    subtitle: `${branch.name}${chunkIndex ? ` (${chunkIndex + 1})` : ""}`,
    rootIds: [branch.id],
    nodeIds: [branch.id, ...nodes.map((node) => node.id)],
    breadcrumb: [...breadcrumb, branch.name],
    paper,
    layoutStyle,
  };
}

export function layoutPage(graph, page, options = {}) {
  const pageSize = resolvePageSize(options.pageSize || page.paper || "slide");
  const layoutStyle = normalizeLayoutStyle(page.layoutStyle || options.layoutStyle || "horizontal-bus");
  const portrait = pageSize.height > pageSize.width;
  const pageMargin = options.margin ?? (portrait ? (pageSize.width < 400 ? 17 : 28) : 38);
  const frame = {
    left: options.left ?? pageMargin,
    top: options.top ?? (portrait ? 104 : 118),
    width: options.width ?? pageSize.width - pageMargin * 2,
    height: options.height ?? pageSize.height - (portrait ? 132 : 150),
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
  const verticalLeaves =
    layoutStyle === "vertical-stack" ||
    layoutStyle === "matrix" ||
    totalWeight > 11 ||
    selected.size > 18;
  const leafHeight = verticalLeaves
    ? layoutStyle === "vertical-stack" && portrait
      ? 112
      : 132
    : 34;
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
      width = Math.min(portrait ? 34 : 32, Math.max(24, spanWidth * 0.7));
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
  const changeStyles = {
    신설: { fill: "#FFF4A3", line: "#B8860B", text: "#5B4600", lineStyle: "solid", bold: true },
    폐지: { fill: "#FDE2E2", line: "#B4362A", text: "#7F1D1D", lineStyle: "dashed", bold: false },
    명칭변경: { fill: "#E8E3FF", line: "#6D5BB3", text: "#3E3470", lineStyle: "solid", bold: false },
    이체: { fill: "#E0F2FE", line: "#2878A8", text: "#174B6B", lineStyle: "dashed", bold: false },
    상계신설: { fill: "#DCFCE7", line: "#398041", text: "#14532D", lineStyle: "dashed", bold: false },
  };
  if (metadata.change && changeStyles[metadata.change]) return changeStyles[metadata.change];
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
    일반직: "일",
    연구직: "연",
    지도직: "지",
    전문직: "전",
    전문경력관: "전",
    임기제: "임",
    별정직: "별",
    특정직: "특",
  };
  const categories = node.metadata?.staffCategories || [];
  for (const category of categories) {
    if (category === "일반직" && categories.length === 1) continue;
    if (staffMarkers[category] && !markers.includes(staffMarkers[category])) markers.push(staffMarkers[category]);
  }
  if (node.metadata?.responsible) markers.push("책");
  if (node.metadata?.payroll) markers.push("총");
  if (node.metadata?.autonomous) markers.push("자");
  if (node.metadata?.evaluation) markers.push("평");
  if (node.metadata?.temporary) markers.push("한");
  if (node.metadata?.change) {
    const changeMarker = {
      신설: "신설",
      폐지: "폐지",
      명칭변경: "명칭변경",
      이체: "이체",
      상계신설: "상계신설",
    }[node.metadata.change];
    if (changeMarker) markers.push(changeMarker);
  }
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
