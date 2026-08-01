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

export const LAYOUT_PRESETS = Object.freeze({
  "horizontal-bus": {
    label: "가로 버스형",
    description: "기관장 척추에서 실·국을 가로 버스로 펼치는 개요형",
  },
  "vertical-stack": {
    label: "세로 척추형",
    description: "실·국 아래 관·과·팀을 세로로 쌓는 좁은 면형",
  },
  "two-column": {
    label: "좌우 2열형",
    description: "상위 계선을 두 개의 세로 레인으로 나누는 비교형",
  },
  matrix: {
    label: "관·국–과 매트릭스형",
    description: "상위 단위를 열로 고정하고 하위 과·팀을 행으로 배열하는 형식",
  },
  flow: {
    label: "업무 흐름형",
    description: "조직 관계를 왼쪽에서 오른쪽으로 읽는 기능·이관 검토형",
  },
  "change-lanes": {
    label: "변경 전후 레인형",
    description: "기존 조직과 신설·폐지·이체 조직을 좌우 레인으로 분리하는 형식",
  },
  "affiliate-strip": {
    label: "본부·소속기관 띠형",
    description: "본부 계층 아래 부속기관·책임운영기관을 별도 띠로 두는 형식",
  },
  catalog: {
    label: "부서 카드 목록형",
    description: "관·국별 하위 과·팀을 카드 묶음으로 나열하는 인쇄용 목록형",
  },
});

const VISUAL_LAYOUTS = new Set(Object.keys(LAYOUT_PRESETS));
const VISUAL_LAYOUT_ORDER = Object.freeze(Object.keys(LAYOUT_PRESETS));

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

export function normalizeLayoutStyle(value) {
  if (value === "vertical" || value === "vertical-stack") return "vertical-stack";
  if (value === "horizontal" || value === "horizontal-bus") return "horizontal-bus";
  if (value === "columns" || value === "2-column" || value === "2col") return "two-column";
  if (value === "grid" || value === "department-matrix") return "matrix";
  if (value === "workflow" || value === "left-right" || value === "흐름") return "flow";
  if (value === "change" || value === "comparison" || value === "compare" || value === "변경") return "change-lanes";
  if (value === "affiliates" || value === "institution-strip" || value === "소속기관") return "affiliate-strip";
  if (value === "cards" || value === "list" || value === "부서목록") return "catalog";
  return String(value || "").trim().toLowerCase();
}

/**
 * Normalize a comma-separated list of visual presets.  `all` is intentionally
 * deterministic so that SVG/PPTX page order is stable in CI and in review
 * documents.
 */
export function parseLayoutStyles(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const styles = [];
  for (const raw of values) {
    const token = String(raw || "").trim().toLowerCase();
    if (!token) continue;
    if (token === "all" || token === "*" || token === "모음") {
      for (const preset of VISUAL_LAYOUT_ORDER) if (!styles.includes(preset)) styles.push(preset);
      continue;
    }
    const style = normalizeLayoutStyle(token);
    if (VISUAL_LAYOUTS.has(style) && !styles.includes(style)) styles.push(style);
  }
  return styles;
}

/**
 * Plan the same graph repeatedly with different visual grammars.  The graph
 * and legal page planning are shared; only the page layout style and the
 * explanatory subtitle vary.  This keeps a multi-style deck comparable and
 * avoids requiring the caller to parse the law text more than once.
 */
export function planLayoutVariants(
  graph,
  { layouts, ...options } = {},
) {
  const requested = parseLayoutStyles(layouts);
  if (!requested.length) return planPages(graph, options);
  const pages = [];
  for (const style of requested) {
    const variantPages = planPages(graph, { ...options, layoutStyle: style });
    const preset = LAYOUT_PRESETS[style];
    for (const page of variantPages) {
      pages.push({
        ...page,
        variant: style,
        variantLabel: preset.label,
        variantDescription: preset.description,
        subtitle: `${preset.label} · ${page.subtitle}`,
      });
    }
  }
  return pages.map((page, index) => ({
    ...page,
    pageNumber: index + 1,
    pageCount: pages.length,
  }));
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
      const focusedLayoutStyle =
        focused.kind === "affiliated"
          ? affiliateDetailLayoutStyle({
              visual,
              requestedVisual,
              descendantCount: nodeIds.length - 1,
              paper: format,
            })
          : visual;
      const focusedPage = {
        kind: focused.kind === "affiliated" ? "affiliate-detail" : "compact",
        title: graph.meta.title,
        subtitle: focused.name,
        rootIds: [focused.id],
        nodeIds: [...new Set(nodeIds)],
        breadcrumb: [focused.name],
        paper: format,
        layoutStyle: focusedLayoutStyle,
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

  if (visual === "affiliate-strip") {
    // The strip preset keeps the main tree and puts first-level affiliated
    // institutions into a single bottom band.  Their detailed subtrees stay
    // available through --focus, so the overview does not become a second
    // full institution tree.
    if (pages[0] && affiliates.length) {
      pages[0] = {
        ...pages[0],
        kind: "overview-affiliate-strip",
        affiliateStrip: true,
        nodeIds: [...new Set([...pages[0].nodeIds, ...affiliates.map((node) => node.id)])],
      };
    }
  } else {
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
        const layoutStyleForAffiliate = affiliateDetailLayoutStyle({
          visual,
          requestedVisual,
          descendantCount: descendants.length,
          paper: format,
        });
        affiliateDetails.push(
          ...splitBranchPages(graph, affiliate, effectiveMaxNodes, ["소속기관"], format, layoutStyleForAffiliate),
        );
      }
    }
    pages.push(...packDetailPages(affiliateDetails, effectiveMaxNodes, "소속기관", format, visual));
  }

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
    const layoutConflict = (spec.layoutStyle || layoutStyle) !== (current.layoutStyle || layoutStyle);
    if (mergedIds.size <= maxNodes && !intersects && !rootConflict && !layoutConflict) {
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

function affiliateDetailLayoutStyle({ visual, requestedVisual, descendantCount, paper }) {
  if (requestedVisual) return visual;
  const denseThreshold = paper === "a4-half" ? 6 : 8;
  return descendantCount >= denseThreshold ? "catalog" : visual;
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
  if (layoutStyle === "affiliate-strip") {
    return decorateLayout(layoutAffiliateStripPage({ graph, page, pageSize, frame, parentEdge, children, roots, selected, depth }));
  }
  if (layoutStyle === "flow") {
    return decorateLayout(layoutFlowPage({ graph, frame, parentEdge, roots, selected, depth }));
  }
  if (layoutStyle === "change-lanes") {
    return decorateLayout(layoutChangeLanesPage({ graph, frame, parentEdge, roots, selected, depth }));
  }
  if (layoutStyle === "catalog") {
    return decorateLayout(layoutCatalogPage({ graph, frame, parentEdge, roots, selected, depth, portrait }));
  }
  if (layoutStyle === "matrix") {
    return decorateLayout(layoutMatrixPage({
      graph,
      pageSize,
      frame,
      parentEdge,
      children,
      roots,
      selected,
      depth,
    }));
  }
  if (layoutStyle === "two-column") {
    return decorateLayout(layoutTwoColumnPage({
      graph,
      pageSize,
      frame,
      parentEdge,
      children,
      roots,
      selected,
      depth,
      leafWeight,
    }));
  }
  const verticalLeaves =
    layoutStyle === "vertical-stack" ||
    (layoutStyle !== "horizontal-bus" && (totalWeight > 11 || selected.size > 18));
  const leafHeight = verticalLeaves
    ? layoutStyle === "vertical-stack" && portrait
      ? 112
      : 132
    : 34;
  // The old layout expanded a shallow tree until it filled the entire page.
  // That left a visually awkward amount of white space between a minister
  // and the first row of bureaux (and made the connectors look fragmented).
  // Treat the hierarchy as a compact diagram instead: keep a predictable
  // reading rhythm and use the remaining lower space as breathing room.
  const usableHeight = Math.max(220, frame.height - leafHeight - 20);
  const narrowHalf = portrait && pageSize.width < 400;
  const preferredLevelGap = verticalLeaves
    ? (narrowHalf ? 96 : portrait ? 96 : 104)
    : (narrowHalf ? 86 : 92);
  const levelGap = maxDepth ? Math.min(preferredLevelGap, usableHeight / maxDepth) : 0;
  const contentHeight = maxDepth * levelGap + leafHeight;
  const topInset = Math.min(narrowHalf ? 28 : 24, Math.max(0, (frame.height - contentHeight) * 0.18));
  const siblingGutter = verticalLeaves ? (narrowHalf ? 6 : 12) : 18;
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
    const availableWidth = Math.max(18, spanWidth - siblingGutter);
    if (isLeaf && verticalLeaves && level > 0) {
      width = Math.min(
        portrait ? 34 : 32,
        Math.max(Math.min(24, availableWidth), availableWidth * 0.7),
      );
      height = leafHeight;
      vertical = true;
    } else {
      width = Math.min(
        168,
        Math.max(
          Math.min(28, availableWidth),
          Math.min(availableWidth, 88 + node.name.length * 4.6),
        ),
      );
      height = 32;
    }
    const centerX = spanLeft + spanWidth / 2;
    const top = frame.top + topInset + level * levelGap;
    positions.set(id, boxPosition(centerX, top, width, height, {
      vertical,
      depth: level,
      spanLeft,
      spanWidth,
    }));
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
  return decorateLayout({ frame, nodes, edges, roots, maxDepth, verticalLeaves });
}

function boxPosition(centerX, top, width, height, { vertical = false, depth = 0, spanLeft, spanWidth } = {}) {
  return {
    left: centerX - width / 2,
    top,
    width,
    height,
    centerX,
    centerY: top + height / 2,
    right: centerX + width / 2,
    bottom: top + height,
    vertical,
    depth,
    spanLeft: spanLeft ?? centerX - width / 2,
    spanWidth: spanWidth ?? width,
  };
}

function normalizePosition(position) {
  if (!position) return null;
  const width = position.width ?? 0;
  const height = position.height ?? 0;
  const left = position.left ?? (position.centerX ?? 0) - width / 2;
  const top = position.top ?? (position.centerY ?? 0) - height / 2;
  const right = position.right ?? left + width;
  const bottom = position.bottom ?? top + height;
  const centerX = position.centerX ?? left + width / 2;
  const centerY = position.centerY ?? top + height / 2;
  return {
    ...position,
    left,
    top,
    width,
    height,
    centerX,
    centerY,
    right,
    bottom,
  };
}

function normalizeLayoutGeometry(layout) {
  const positionByNode = new Map();
  const nodes = (layout.nodes || []).map((entry) => {
    const position = normalizePosition(entry.position);
    if (entry.node?.id && position) positionByNode.set(entry.node.id, position);
    return { ...entry, position };
  });
  const edges = (layout.edges || []).map((edge) => ({
    ...edge,
    from: normalizePosition(edge.from) || positionByNode.get(edge.parent) || null,
    to: normalizePosition(edge.to) || positionByNode.get(edge.child) || null,
  }));
  return { ...layout, nodes, edges };
}

function positionedEdges(parentEdge, positions, orientation) {
  return [...parentEdge.values()]
    .map((edge) => ({
      ...edge,
      ...(orientation ? { orientation } : {}),
      from: positions.get(edge.parent),
      to: positions.get(edge.child),
    }))
    .filter((edge) => edge.from && edge.to);
}

/**
 * Keep geometry checks next to the layout model.  A chart can be legally
 * parsed and still be unusable on paper when a dense branch runs outside the
 * printable frame.  Renderers may choose how prominently to surface these
 * diagnostics; callers can always inspect them programmatically.
 */
export function diagnoseLayout(layout, { tolerance = 0.5, minimumConnectorLength = 6 } = {}) {
  const frame = layout?.frame;
  if (!frame) return { ok: true, overflow: [], overlaps: [], edgeIssues: [] };
  const overflow = [];
  for (const entry of layout.nodes || []) {
    const p = normalizePosition(entry.position);
    if (!p) continue;
    if (
      p.left < frame.left - tolerance ||
      p.top < frame.top - tolerance ||
      p.right > frame.left + frame.width + tolerance ||
      p.bottom > frame.top + frame.height + tolerance
    ) {
      overflow.push(entry.node?.name || entry.node?.id || "(이름 없음)");
    }
  }
  const overlaps = [];
  const entries = layout.nodes || [];
  for (let i = 0; i < entries.length; i += 1) {
    const a = normalizePosition(entries[i]?.position);
    if (!a) continue;
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = normalizePosition(entries[j]?.position);
      if (!b) continue;
      const separated =
        a.right <= b.left + tolerance ||
        b.right <= a.left + tolerance ||
        a.bottom <= b.top + tolerance ||
        b.bottom <= a.top + tolerance;
      if (!separated) {
        overlaps.push({
          a: entries[i].node?.name || entries[i].node?.id || "(이름 없음)",
          b: entries[j].node?.name || entries[j].node?.id || "(이름 없음)",
        });
      }
    }
  }
  const nodeNames = new Map(
    (layout.nodes || []).map((entry) => [entry.node?.id, entry.node?.name || entry.node?.id || "(이름 없음)"]),
  );
  const edgeIssues = [];
  for (const edge of layout.edges || []) {
    const issue = diagnoseEdge(edge, { tolerance, minimumConnectorLength });
    if (!issue) continue;
    edgeIssues.push({
      parent: nodeNames.get(edge.parent) || edge.parent || "(부모 없음)",
      child: nodeNames.get(edge.child) || edge.child || "(자식 없음)",
      ...issue,
    });
  }
  return {
    ok: overflow.length === 0 && overlaps.length === 0 && edgeIssues.length === 0,
    overflow,
    overlaps,
    edgeIssues,
  };
}

function decorateLayout(layout) {
  const normalized = normalizeLayoutGeometry(layout);
  return { ...normalized, diagnostics: diagnoseLayout(normalized) };
}

function diagnoseEdge(edge, { tolerance, minimumConnectorLength }) {
  const from = normalizePosition(edge.from);
  const to = normalizePosition(edge.to);
  if (!from || !to) return { reason: "missing-endpoint" };
  if (edge.orientation === "horizontal") {
    const gap = to.left - from.right;
    if (gap < -tolerance) return { reason: "reversed-horizontal", gap: Number(gap.toFixed(2)) };
    if (gap < minimumConnectorLength) return { reason: "too-short-horizontal", gap: Number(gap.toFixed(2)) };
    return null;
  }
  const gap = to.top - from.bottom;
  if (gap < -tolerance) return { reason: "reversed-vertical", gap: Number(gap.toFixed(2)) };
  if (gap < minimumConnectorLength) return { reason: "too-short-vertical", gap: Number(gap.toFixed(2)) };
  return null;
}

/** Left-to-right levels used for function-transfer and 업무흐름형 pages. */
function layoutFlowPage({ graph, frame, parentEdge, roots, selected, depth }) {
  const positions = new Map();
  const levels = new Map();
  for (const id of selected) {
    const level = depth.get(id) ?? 0;
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(id);
  }
  const maxLevel = Math.max(0, ...levels.keys());
  const maxRows = Math.max(1, ...levels.values().map((ids) => ids.length));
  for (const ids of levels.values()) {
    ids.sort((a, b) => {
      const left = graph.nodes.get(a);
      const right = graph.nodes.get(b);
      return (left?.rank ?? 9) - (right?.rank ?? 9) || left?.name.localeCompare(right?.name, "ko");
    });
  }
  const columnGap = frame.width / Math.max(1, maxLevel + 1);
  const rowGap = Math.min(64, Math.max(30, (frame.height - 12) / maxRows));
  for (const [level, ids] of levels.entries()) {
    ids.forEach((id, row) => {
      const node = graph.nodes.get(id);
      if (!node) return;
      const width = Math.min(154, Math.max(58, columnGap * 0.72));
      const vertical = width < 86 && node.name.length > 7;
      const height = vertical ? Math.min(76, Math.max(52, rowGap * 1.7)) : 31;
      const centerX = frame.left + columnGap * (level + 0.5);
      const top = frame.top + rowGap * row + Math.max(0, (rowGap - height) / 2);
      positions.set(id, boxPosition(centerX, top, vertical ? 34 : width, height, {
        vertical,
        depth: level,
        spanLeft: centerX - columnGap / 2,
        spanWidth: columnGap,
      }));
    });
  }
  const nodes = [...positions.entries()].map(([id, position]) => ({ node: graph.nodes.get(id), position }));
  return {
    frame,
    nodes,
    edges: positionedEdges(parentEdge, positions, "horizontal"),
    roots,
    maxDepth: maxLevel,
    verticalLeaves: false,
    labels: [{ text: "기능·이관 흐름", x: frame.left, y: frame.top - 10, align: "start" }],
  };
}

/** Existing/change lane layout used by 검토서의 변경 전·후 도표. */
function layoutChangeLanesPage({ graph, frame, parentEdge, roots, selected, depth }) {
  const positions = new Map();
  const rootIds = roots.filter((id) => selected.has(id));
  const headerWidth = Math.min(180, Math.max(94, frame.width / Math.max(1, rootIds.length) * 0.56));
  rootIds.forEach((id, index) => {
    const centerX = rootIds.length === 1
      ? frame.left + frame.width / 2
      : frame.left + frame.width * ((index + 0.5) / rootIds.length);
    const node = graph.nodes.get(id);
    if (node) positions.set(id, boxPosition(centerX, frame.top, headerWidth, 34, { depth: 0, spanLeft: centerX - headerWidth / 2, spanWidth: headerWidth }));
  });
  const body = [...selected]
    .filter((id) => !rootIds.includes(id))
    .sort((a, b) => {
      const left = graph.nodes.get(a);
      const right = graph.nodes.get(b);
      return (depth.get(a) ?? 9) - (depth.get(b) ?? 9) || (left?.rank ?? 9) - (right?.rank ?? 9) || left?.name.localeCompare(right?.name, "ko");
    });
  const lanes = [
    body.filter((id) => !graph.nodes.get(id)?.metadata?.change),
    body.filter((id) => Boolean(graph.nodes.get(id)?.metadata?.change)),
  ];
  const laneGap = 20;
  const laneWidth = (frame.width - laneGap) / 2;
  const bodyTop = frame.top + 62;
  const bodyHeight = Math.max(108, frame.height - 72);
  const labels = [];

  // A comparison page with no @변경 marks is still useful as a baseline, but
  // it must not leave a large empty lane or run a single column off the A4
  // page.  Reflow the baseline into a compact card grid and say explicitly
  // that the right lane is empty.
  if (!lanes[1].length) {
    const columns = Math.max(1, Math.min(frame.width < 420 ? 2 : 3, lanes[0].length || 1));
    const columnWidth = frame.width / columns;
    const rows = Math.max(1, Math.ceil(lanes[0].length / columns));
    const rowGap = Math.min(48, Math.max(31, bodyHeight / rows));
    lanes[0].forEach((id, index) => {
      const node = graph.nodes.get(id);
      if (!node) return;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const left = frame.left + column * columnWidth;
      const width = Math.min(174, Math.max(58, columnWidth * 0.78));
      const vertical = width < 96 && node.name.length > 8;
      positions.set(id, boxPosition(left + columnWidth / 2, bodyTop + row * rowGap, vertical ? 34 : width, vertical ? 74 : 31, {
        vertical,
        depth: depth.get(id) ?? 1,
        spanLeft: left,
        spanWidth: columnWidth,
      }));
    });
    labels.push(
      { text: "기준 조직", x: frame.left + frame.width * 0.34, y: frame.top + 51, align: "middle" },
      { text: "변경 표식 없음", x: frame.left + frame.width * 0.78, y: frame.top + 51, align: "middle", muted: true },
    );
  } else {
    const maxRows = Math.max(1, Math.floor(bodyHeight / 37));
    const laneColumns = lanes.map((lane) => Math.max(1, Math.min(3, Math.ceil(lane.length / maxRows))));
    const laneRows = lanes.map((lane, index) => Math.max(1, Math.ceil(lane.length / laneColumns[index])));
    const rowGap = Math.min(48, Math.max(31, bodyHeight / Math.max(...laneRows)));
    lanes.forEach((lane, laneIndex) => {
      const left = laneIndex === 0 ? frame.left : frame.left + laneWidth + laneGap;
      const columns = laneColumns[laneIndex];
      const columnWidth = laneWidth / columns;
      lane.forEach((id, index) => {
        const node = graph.nodes.get(id);
        if (!node) return;
        const column = index % columns;
        const row = Math.floor(index / columns);
        const columnLeft = left + column * columnWidth;
        const width = Math.min(174, Math.max(54, columnWidth * 0.78));
        const vertical = width < 96 && node.name.length > 8;
        const height = vertical ? 74 : 31;
        positions.set(id, boxPosition(columnLeft + columnWidth / 2, bodyTop + row * rowGap, vertical ? 34 : width, height, {
          vertical,
          depth: depth.get(id) ?? 1,
          spanLeft: columnLeft,
          spanWidth: columnWidth,
        }));
      });
    });
    labels.push(
      { text: "기존·유지", x: frame.left + laneWidth / 2, y: frame.top + 51, align: "middle" },
      { text: "신설·폐지·명칭변경·이체", x: frame.left + laneWidth + laneGap + laneWidth / 2, y: frame.top + 51, align: "middle" },
    );
  }
  const nodes = [...positions.entries()].map(([id, position]) => ({ node: graph.nodes.get(id), position }));
  return {
    frame,
    nodes,
    // Change-lane pages are comparison sheets, not strict hierarchy trees.
    // Drawing inherited parent-child edges over a lane grid creates reversed
    // or crossing connectors when a parent and its child are sorted into
    // different card rows.  Keep the legal hierarchy in the data and omit
    // connectors in this visual preset.
    edges: [],
    roots,
    maxDepth: Math.max(0, ...depth.values()),
    verticalLeaves: false,
    edgeMode: "none",
    labels,
  };
}

/** Card catalogue for long bureau/department lists where connectors obscure text. */
function layoutCatalogPage({ graph, frame, parentEdge, roots, selected, depth, portrait }) {
  const positions = new Map();
  const groupBoxes = [];
  const rootIds = roots.filter((id) => selected.has(id));
  rootIds.forEach((id, index) => {
    const node = graph.nodes.get(id);
    if (!node) return;
    const centerX = rootIds.length === 1
      ? frame.left + frame.width / 2
      : frame.left + frame.width * ((index + 0.5) / rootIds.length);
    positions.set(id, boxPosition(centerX, frame.top, Math.min(170, Math.max(90, frame.width / Math.max(1, rootIds.length) * 0.6)), 34, { depth: 0 }));
  });

  // Catalogue pages intentionally omit long connector paths, but they do not
  // flatten the law-defined hierarchy.  Each immediate parent becomes a
  // lightly framed card group, with a small "상위" caption and the direct
  // children beneath it.  A child that is itself a group header is rendered
  // in its own group exactly once, avoiding the duplicate-card problem that a
  // naive parent-prefix list creates.
  const directChildren = new Map();
  for (const edge of parentEdge.values()) {
    if (!directChildren.has(edge.parent)) directChildren.set(edge.parent, []);
    directChildren.get(edge.parent).push(edge.child);
  }
  for (const ids of directChildren.values()) {
    ids.sort((a, b) => {
      const left = graph.nodes.get(a);
      const right = graph.nodes.get(b);
      return (left?.rank ?? 9) - (right?.rank ?? 9) || left?.name.localeCompare(right?.name, "ko");
    });
  }
  const bodyIds = [...selected].filter((id) => !rootIds.includes(id));
  const groupParentIds = new Set(bodyIds.filter((id) => (directChildren.get(id) || []).length));
  const groupSpecs = [];
  const represented = new Set(rootIds);
  const addSpec = (id, childrenIds, caption) => {
    const filtered = childrenIds.filter((childId) => selected.has(childId) && !groupParentIds.has(childId));
    groupSpecs.push({ id, children: filtered, caption });
    if (id) represented.add(id);
    filtered.forEach((childId) => represented.add(childId));
  };

  // Root-direct leaf cards (usually 기관장 보좌기관 or 운영지원과).
  for (const rootId of rootIds) {
    addSpec(null, directChildren.get(rootId) || [], "직속 하부조직");
  }
  // Every 관·국·실 with direct children gets its own compact group.
  const orderedGroupParents = [...groupParentIds].sort((a, b) => {
    const left = graph.nodes.get(a);
    const right = graph.nodes.get(b);
    return (depth.get(a) ?? 9) - (depth.get(b) ?? 9) || (left?.rank ?? 9) - (right?.rank ?? 9) || left?.name.localeCompare(right?.name, "ko");
  });
  for (const id of orderedGroupParents) {
    const parentId = parentEdge.get(id)?.parent;
    const parentName = parentId ? graph.nodes.get(parentId)?.name : "관계 미확인";
    addSpec(id, directChildren.get(id) || [], `상위: ${parentName || "관계 미확인"}`);
  }
  // Detail pages can contain a selected orphan when a branch was packed by a
  // caller.  Keep it visible rather than silently losing it from the cards.
  const missing = bodyIds.filter((id) => !represented.has(id));
  if (missing.length) addSpec(null, missing, "관계 미확인");

  const nonEmptySpecs = groupSpecs.filter((spec) => spec.id || spec.children.length);
  const columns = Math.max(1, Math.min(portrait ? 1 : 4, nonEmptySpecs.length || 1));
  const columnWidth = frame.width / columns;
  const startTop = frame.top + 57;
  const columnTops = Array.from({ length: columns }, () => startTop);
  for (const spec of nonEmptySpecs) {
    const column = columnTops.indexOf(Math.min(...columnTops));
    const left = frame.left + column * columnWidth + 6;
    const groupWidth = Math.max(80, columnWidth - 12);
    const captionHeight = 17;
    const headerHeight = spec.id ? 31 : 0;
    const childColumns =
      spec.children.length > 18 && groupWidth >= 520
        ? 4
        : spec.children.length > 10 && groupWidth >= 340
          ? 3
          : spec.children.length > 4 && groupWidth >= 170
            ? 2
            : 1;
    const childColumnWidth = groupWidth / childColumns;
    const childRows = Math.max(1, Math.ceil(spec.children.length / childColumns));
    const rowGap = Math.min(31, Math.max(23, (frame.height - 100) / Math.max(1, childRows)));
    const childHeight = Math.min(27, Math.max(18, rowGap - 5));
    const groupHeight = Math.max(50, captionHeight + headerHeight + childRows * rowGap + 8);
    const top = columnTops[column];
    groupBoxes.push({ left, top, width: groupWidth, height: groupHeight, caption: spec.caption });
    let cursorTop = top + captionHeight;
    if (spec.id) {
      const node = graph.nodes.get(spec.id);
      if (node) {
        const width = Math.min(176, Math.max(72, groupWidth * 0.78));
        positions.set(spec.id, boxPosition(left + groupWidth / 2, cursorTop, width, 28, {
          depth: depth.get(spec.id) ?? 1,
          spanLeft: left,
          spanWidth: groupWidth,
        }));
      }
      cursorTop += headerHeight;
    }
    spec.children.forEach((id, index) => {
      const node = graph.nodes.get(id);
      if (!node) return;
      const childColumn = index % childColumns;
      const row = Math.floor(index / childColumns);
      const childLeft = left + childColumn * childColumnWidth;
      const width = Math.min(176, Math.max(62, childColumnWidth * 0.82));
      const vertical = width < 98 && node.name.length > 8;
      positions.set(id, boxPosition(childLeft + childColumnWidth / 2, cursorTop + row * rowGap, vertical ? 34 : width, vertical ? Math.max(42, childHeight) : childHeight, {
        vertical,
        depth: depth.get(id) ?? 1,
        spanLeft: childLeft,
        spanWidth: childColumnWidth,
      }));
    });
    columnTops[column] = top + groupHeight + 8;
  }
  const nodes = [...positions.entries()].map(([id, position]) => ({ node: graph.nodes.get(id), position }));
  return {
    frame,
    nodes,
    edges: [],
    roots,
    maxDepth: Math.max(0, ...depth.values()),
    verticalLeaves: false,
    edgeMode: "none",
    groupBoxes,
    labels: [{ text: "상위 조직별 카드 묶음 · 연결선 생략", x: frame.left, y: frame.top - 10, align: "start" }],
  };
}

/** Main tree plus an explicit bottom strip for affiliated institutions. */
function layoutAffiliateStripPage({ graph, page, pageSize, frame, parentEdge, children, roots, selected, depth }) {
  const affiliateIds = [...selected].filter((id) => graph.nodes.get(id)?.kind === "affiliated");
  if (!affiliateIds.length) {
    return layoutPage(graph, { ...page, layoutStyle: "horizontal-bus", nodeIds: [...selected] }, { pageSize });
  }
  const mainIds = [...selected].filter((id) => !affiliateIds.includes(id));
  const stripHeight = 70;
  const main = mainIds.length
    ? layoutPage(
        graph,
        { ...page, nodeIds: mainIds, layoutStyle: "horizontal-bus" },
        { pageSize, left: frame.left, top: frame.top, width: frame.width, height: Math.max(180, frame.height - stripHeight) },
      )
    : { frame: { ...frame, height: 0 }, nodes: [], edges: [], roots: [], maxDepth: 0, verticalLeaves: false };
  const positions = new Map(main.nodes.map(({ node, position }) => [node.id, position]));
  const stripTop = frame.top + frame.height - 35;
  const gap = 10;
  const boxWidth = Math.min(156, Math.max(82, (frame.width - gap * Math.max(0, affiliateIds.length - 1)) / Math.max(1, affiliateIds.length)));
  affiliateIds.forEach((id, index) => {
    const node = graph.nodes.get(id);
    if (!node) return;
    const centerX = frame.left + boxWidth / 2 + index * (boxWidth + gap);
    positions.set(id, boxPosition(centerX, stripTop, boxWidth, 30, { depth: 1 }));
  });
  const edges = [...main.edges];
  for (const edge of parentEdge.values()) {
    if (!affiliateIds.includes(edge.child)) continue;
    const from = positions.get(edge.parent);
    const to = positions.get(edge.child);
    if (from && to) edges.push({ ...edge, from, to });
  }
  const nodes = [...positions.entries()].map(([id, position]) => ({ node: graph.nodes.get(id), position }));
  return {
    frame,
    nodes,
    edges,
    roots,
    maxDepth: main.maxDepth,
    verticalLeaves: main.verticalLeaves,
    labels: [{ text: "소속기관·책임운영기관", x: frame.left, y: stripTop - 9, align: "start" }],
  };
}

/**
 * Matrix layout: each top-level unit receives a stable column and its
 * descendants are listed in rows beneath it.  This mirrors the narrow
 * 관·국–과 tables in government review books and is deliberately different
 * from the weighted tree used by the horizontal bus preset.
 */
function layoutMatrixPage({ graph, pageSize, frame, parentEdge, children, roots, selected, depth }) {
  const rootHeaders = roots.filter((id) => selected.has(id));
  const columns = [];
  const seen = new Set();
  const collect = (id, list) => {
    if (!selected.has(id) || seen.has(id)) return;
    seen.add(id);
    list.push(id);
    for (const childId of children.get(id) || []) collect(childId, list);
  };
  for (const rootId of rootHeaders) {
    const direct = (children.get(rootId) || []).filter((id) => selected.has(id));
    if (!direct.length) {
      if (!seen.has(rootId)) columns.push({ rootId, ids: [rootId] });
      seen.add(rootId);
      continue;
    }
    for (const childId of direct) {
      const ids = [];
      collect(childId, ids);
      if (ids.length) columns.push({ rootId, ids });
    }
  }
  if (!columns.length) {
    for (const rootId of rootHeaders) {
      const ids = [];
      collect(rootId, ids);
      if (ids.length) columns.push({ rootId, ids });
    }
  }
  const columnCount = Math.max(1, columns.length);
  const columnWidth = frame.width / columnCount;
  const maxRows = Math.max(1, ...columns.map(({ ids }) => ids.length));
  const headerHeight = 34;
  const rowGap = Math.min(46, Math.max(28, (frame.height - headerHeight - 22) / Math.max(1, maxRows)));
  const rowHeight = Math.max(20, Math.min(32, rowGap - 8));
  const positions = new Map();

  const put = (id, centerX, top, width, height, vertical = false, depthValue = 0) => {
    positions.set(id, {
      left: centerX - width / 2,
      top,
      width,
      height,
      centerX,
      bottom: top + height,
      vertical,
      depth: depthValue,
      spanLeft: centerX - columnWidth / 2,
      spanWidth: columnWidth,
    });
  };

  if (rootHeaders.length === 1) {
    const root = graph.nodes.get(rootHeaders[0]);
    if (root) put(root.id, frame.left + frame.width / 2, frame.top, Math.min(176, Math.max(96, root.name.length * 5.2 + 50)), headerHeight, false, 0);
  } else {
    const headerWidth = Math.min(150, Math.max(42, columnWidth * 0.82));
    rootHeaders.forEach((rootId, index) => {
      const centerX = frame.left + columnWidth * (index + 0.5);
      const root = graph.nodes.get(rootId);
      if (root) put(rootId, centerX, frame.top, headerWidth, headerHeight, false, 0);
    });
  }

  columns.forEach(({ ids }, columnIndex) => {
    const centerX = frame.left + columnWidth * (columnIndex + 0.5);
    ids.forEach((id, rowIndex) => {
      const node = graph.nodes.get(id);
      if (!node || positions.has(id)) return;
      const narrow = columnWidth < 108;
      const vertical = narrow || rowIndex > 0 && node.name.length > 11;
      const width = vertical
        ? Math.min(34, Math.max(26, columnWidth * 0.48))
        : Math.min(172, Math.max(60, columnWidth * 0.82));
      const height = vertical ? Math.min(82, Math.max(40, rowGap - 5)) : rowHeight;
      put(id, centerX, frame.top + headerHeight + 15 + rowIndex * rowGap, width, height, vertical, depth.get(id) || 1);
    });
  });

  // Selected orphans can occur in a packed detail page.  Place them in a
  // final column instead of silently dropping them from the rendered page.
  for (const id of selected) {
    if (positions.has(id)) continue;
    const node = graph.nodes.get(id);
    if (!node) continue;
    const centerX = frame.left + frame.width / 2;
    put(id, centerX, frame.top + headerHeight + 15 + maxRows * rowGap, Math.min(150, Math.max(64, columnWidth * 0.75)), rowHeight, false, depth.get(id) || 1);
  }
  const edges = [...parentEdge.values()]
    .map((edge) => ({ ...edge, from: positions.get(edge.parent), to: positions.get(edge.child) }))
    .filter((edge) => edge.from && edge.to);
  const nodes = [...positions.entries()].map(([id, position]) => ({ node: graph.nodes.get(id), position }));
  return { frame, nodes, edges, roots, maxDepth: maxRows, verticalLeaves: true };
}

/**
 * Two-column layout: the root remains a shared header, while its first-level
 * branches are balanced into two independent vertical lanes.  Children keep
 * their normal depth, so the result reads as a left/right comparison sheet
 * rather than a single long bus.
 */
function layoutTwoColumnPage({ graph, pageSize, frame, parentEdge, children, roots, selected, depth, leafWeight }) {
  const positions = new Map();
  const topGap = Math.min(92, Math.max(50, frame.height / 4));
  const laneGap = 18;
  const laneWidth = Math.max(80, (frame.width - laneGap) / 2);
  const levelGap = Math.min(112, Math.max(45, (frame.height - 48) / Math.max(2, Math.max(...depth.values(), 1) + 1)));
  const put = (id, centerX, top, width, height, vertical = false, depthValue = 0, spanLeft = centerX - width / 2, spanWidth = width) => {
    positions.set(id, {
      left: centerX - width / 2,
      top,
      width,
      height,
      centerX,
      bottom: top + height,
      vertical,
      depth: depthValue,
      spanLeft,
      spanWidth,
    });
  };

  const headerIds = roots.filter((id) => selected.has(id));
  const primary = headerIds[0];
  if (primary && headerIds.length === 1) {
    const root = graph.nodes.get(primary);
    if (root) put(primary, frame.left + frame.width / 2, frame.top, Math.min(180, Math.max(100, root.name.length * 5.4 + 54)), 34, false, 0, frame.left, frame.width);
  } else {
    const headerWidth = Math.min(170, Math.max(72, frame.width / Math.max(1, headerIds.length) * 0.72));
    headerIds.forEach((id, index) => {
      const root = graph.nodes.get(id);
      if (!root) return;
      const centerX = frame.left + frame.width * ((index + 0.5) / headerIds.length);
      put(id, centerX, frame.top, headerWidth, 34, false, 0, centerX - headerWidth / 2, headerWidth);
    });
  }

  const laneBranches = [[], []];
  const laneWeights = [0, 0];
  const branchRoots = [];
  for (const rootId of headerIds) {
    const direct = (children.get(rootId) || []).filter((id) => selected.has(id));
    if (direct.length) {
      for (const id of direct) branchRoots.push({ id, parent: rootId });
    } else if (!positions.has(rootId)) {
      branchRoots.push({ id: rootId, parent: null });
    }
  }
  for (const branch of branchRoots) {
    const weight = Math.max(1, leafWeight(branch.id));
    const lane = laneWeights[0] <= laneWeights[1] ? 0 : 1;
    laneBranches[lane].push(branch);
    laneWeights[lane] += weight;
  }

  const assign = (id, spanLeft, spanWidth, lane, parentLevel = 1) => {
    if (positions.has(id)) return;
    const node = graph.nodes.get(id);
    if (!node) return;
    const childIds = (children.get(id) || []).filter((childId) => selected.has(childId));
    const level = depth.get(id) || parentLevel;
    const leaf = childIds.length === 0;
    const vertical = leaf && spanWidth < 102;
    const width = vertical
      ? Math.min(34, Math.max(27, spanWidth * 0.46))
      : Math.min(172, Math.max(56, Math.min(spanWidth * 0.82, 96 + node.name.length * 4.2)));
    const height = vertical ? 76 : 31;
    const centerX = spanLeft + spanWidth / 2;
    put(id, centerX, frame.top + level * levelGap, width, height, vertical, level, spanLeft, spanWidth);
    const total = Math.max(1, childIds.reduce((sum, childId) => sum + Math.max(1, leafWeight(childId)), 0));
    let cursor = spanLeft;
    for (const childId of childIds) {
      const childWidth = spanWidth * Math.max(1, leafWeight(childId)) / total;
      assign(childId, cursor, childWidth, lane, level + 1);
      cursor += childWidth;
    }
  };

  for (let lane = 0; lane < 2; lane += 1) {
    const left = lane === 0 ? frame.left : frame.left + laneWidth + laneGap;
    const total = Math.max(1, laneBranches[lane].reduce((sum, branch) => sum + Math.max(1, leafWeight(branch.id)), 0));
    let cursor = left;
    for (const branch of laneBranches[lane]) {
      const width = laneWidth * Math.max(1, leafWeight(branch.id)) / total;
      if (branch.parent && positions.has(branch.parent)) {
        assign(branch.id, cursor, width, lane, 1);
      } else {
        assign(branch.id, cursor, width, lane, 0);
      }
      cursor += width;
    }
  }
  for (const id of selected) {
    if (positions.has(id)) continue;
    const node = graph.nodes.get(id);
    if (!node) continue;
    put(id, frame.left + frame.width / 2, frame.top + topGap, 100, 30, false, depth.get(id) || 1);
  }
  const edges = [...parentEdge.values()]
    .map((edge) => ({ ...edge, from: positions.get(edge.parent), to: positions.get(edge.child) }))
    .filter((edge) => edge.from && edge.to);
  const nodes = [...positions.entries()].map(([id, position]) => ({ node: graph.nodes.get(id), position }));
  return { frame, nodes, edges, roots, maxDepth: Math.max(0, ...depth.values()), verticalLeaves: false };
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
    const affiliationStyles = {
      responsible: { fill: "#55B947", line: "#2D7D2D", text: "#FFFFFF" },
      "special-local": { fill: "#E7F4D7", line: "#4F8A3D", text: "#23451D" },
      subsidiary: { fill: "#ECF8E8", line: "#398041", text: "#1F5A27" },
      affiliated: { fill: "#DFF3D8", line: "#398041", text: "#245C2A" },
    };
    const affiliation = affiliationStyles[metadata.affiliationType] || affiliationStyles.affiliated;
    return { ...affiliation, lineStyle: "solid", bold: true };
  }
  if (metadata.unitRole === "headquarters") {
    return { fill: "#E7F0FF", line: "#315A8A", text: "#17345D", lineStyle: "solid", bold: true };
  }
  if (metadata.unitRole === "affiliated-institution") {
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
  if (node.metadata?.unitRole === "headquarters") markers.push("본부");
  if (node.kind === "affiliated" && !node.metadata?.responsible) {
    const affiliationMarker = {
      "special-local": "특지",
      subsidiary: "부속",
      affiliated: "소속",
    }[node.metadata?.affiliationType];
    if (affiliationMarker) markers.push(affiliationMarker);
  }
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
