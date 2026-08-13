import { parseOrganizationTexts } from "./parser.mjs";
import { normalizeWhitespace, stableId, uniq } from "./utils-core.mjs";

export const NATIVE_LAW_SCHEMA = "kr.go.mois.orgchart.hwp-native/v1";

const PAGE = Object.freeze({
  paper: "A4",
  orientation: "portrait",
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ left: 10, right: 10, top: 10, bottom: 10 }),
});

const DEFAULT_MAX_ROWS = 38;
const EDGE_PRIORITY = Object.freeze({
  structural: 60,
  assistant: 50,
  temporary: 45,
  advisor: 40,
  affiliated: 30,
  jurisdiction: 20,
});

const COLORS = Object.freeze({
  ink: "#17263A",
  muted: "#64748B",
  quiet: "#7B8794",
  edge: "#64748B",
  headFill: "#DCE7F4",
  headLine: "#244C7A",
  headText: "#102A43",
  officeFill: "#FFF4A3",
  officeLine: "#9A7B13",
  bureauFill: "#DFF2E3",
  bureauLine: "#4B7A4E",
  leafFill: "#FFFFFF",
  leafLine: "#7B8794",
  advisorFill: "#F4F6F8",
  advisorLine: "#7C8797",
  affiliateFill: "#E1EFDF",
  affiliateLine: "#4B7A4E",
  temporaryFill: "#EEE9FA",
  temporaryLine: "#6D5BB3",
});

export function buildNativeLawWorkflow(options = {}) {
  const decreeText = normalizeWhitespace(options.decreeText);
  const ruleText = normalizeWhitespace(options.ruleText);
  const documents = [];
  const sources = [];
  if (decreeText) {
    documents.push(decreeText);
    sources.push("직제 입력문");
  }
  if (ruleText) {
    documents.push(ruleText);
    sources.push("직제 시행규칙 입력문");
  }
  if (!documents.length) throw new Error("직제 또는 직제 시행규칙 문언을 하나 이상 입력하세요.");
  if (documents.join("\n").length < 30) throw new Error("입력 문언이 너무 짧습니다. 조직 설치 조문을 함께 붙여넣으세요.");

  const graph = parseOrganizationTexts(documents, {
    sources,
    institution: cleanOptional(options.institution),
    asOf: normalizeDate(options.asOf),
  });
  const visualNodes = [...graph.nodes.values()].filter((node) => node.id !== graph.rootId);
  if (!visualNodes.length) {
    throw new Error("문언에서 조직을 찾지 못했습니다. ‘○○에 △△실·국·과를 둔다’ 문장이 포함됐는지 확인하세요.");
  }

  const tree = buildPrimaryTree(graph);
  const focusNames = parseFocusNames(options.focus);
  const focusResult = resolveFocusNodes(graph, focusNames);
  if (focusNames.length && !focusResult.nodes.length) {
    throw new Error(`작도 범위를 찾지 못했습니다: ${focusNames.join(", ")}`);
  }

  const maxRows = clampInteger(options.maxRows, 20, 48, DEFAULT_MAX_ROWS);
  const plans = buildPagePlans(graph, tree, focusResult.nodes, maxRows);
  const warnings = uniq([
    ...(!decreeText ? ["직제 본문이 없어 실·국·소속기관이 누락될 수 있습니다."] : []),
    ...(!ruleText ? ["직제 시행규칙이 없어 과·담당관·팀이 누락될 수 있습니다."] : []),
    ...focusResult.missing.map((name) => `작도 범위를 찾지 못해 제외했습니다: ${name}`),
    ...(graph.meta.warnings || []),
    ...(plans.length > 1 ? [`가독성을 지키기 위해 A4 ${plans.length}쪽으로 자동 분할했습니다.`] : []),
  ]);
  const lawNames = uniq([
    decreeText ? inferLawName(decreeText, `${graph.meta.institution} 직제`) : "",
    ruleText ? inferLawName(ruleText, `${graph.meta.institution} 직제 시행규칙`) : "",
  ]);
  const fingerprints = {
    ...(decreeText ? { decree: stableId(decreeText) } : {}),
    ...(ruleText ? { rule: stableId(ruleText) } : {}),
  };

  const manifests = plans.map((plan, index) => buildOutlineManifest(graph, tree, plan, {
    index,
    pageCount: plans.length,
    asOf: graph.meta.asOf || normalizeDate(options.asOf),
    lawNames,
    fingerprints,
    warnings,
  }));
  const focusOptions = [...graph.nodes.values()]
    .filter((node) => node.id !== graph.rootId && (tree.children.get(node.id)?.length || 0) > 0)
    .sort(compareNodes)
    .map((node) => ({
      name: node.name,
      kind: node.kind,
      rank: node.rank,
      descendantCount: subtreeIds(node.id, tree.children).length - 1,
    }));

  return {
    manifests,
    pages: manifests.map((manifest, index) => ({
      index,
      label: plans[index].subtitle,
      nodeCount: plans[index].nodeIds.length,
      objectCount: manifest.objects.length,
      fileName: manifest.fileName,
    })),
    summary: {
      institution: graph.meta.institution,
      asOf: graph.meta.asOf || null,
      nodeCount: visualNodes.length,
      relationCount: graph.edges.size,
      pageCount: manifests.length,
      decreePresent: Boolean(decreeText),
      rulePresent: Boolean(ruleText),
      focusOptions,
      warnings,
    },
  };
}

function buildPrimaryTree(graph) {
  const parentEdge = new Map();
  for (const edge of graph.edges.values()) {
    const existing = parentEdge.get(edge.child);
    const score = EDGE_PRIORITY[edge.type] || 0;
    const existingScore = EDGE_PRIORITY[existing?.type] || -1;
    if (!existing || score > existingScore) parentEdge.set(edge.child, edge);
  }
  const children = new Map();
  for (const edge of parentEdge.values()) {
    if (!children.has(edge.parent)) children.set(edge.parent, []);
    children.get(edge.parent).push(edge.child);
  }
  for (const ids of children.values()) {
    ids.sort((left, right) => compareNodes(graph.nodes.get(left), graph.nodes.get(right)));
  }
  return { parentEdge, children };
}

function buildPagePlans(graph, tree, focusNodes, maxRows) {
  if (focusNodes.length) {
    const roots = removeNestedRoots(focusNodes.map((node) => node.id), tree.parentEdge);
    const combined = uniq(roots.flatMap((id) => subtreeIds(id, tree.children)));
    if (combined.length <= maxRows) {
      return [{
        subtitle: roots.map((id) => graph.nodes.get(id)?.name).filter(Boolean).join(" · "),
        rootIds: roots,
        nodeIds: combined,
        kind: "focus",
      }];
    }
    return roots.flatMap((id) => splitSubtreePlan(graph, tree, id, maxRows));
  }

  const head = graph.findHead();
  const rootChildren = tree.children.get(graph.rootId) || [];
  const ordinaryRoots = rootChildren.filter((id) => graph.nodes.get(id)?.kind !== "affiliated");
  const affiliateRoots = rootChildren.filter((id) => graph.nodes.get(id)?.kind === "affiliated");
  const mainRoots = head ? [head.id] : ordinaryRoots;
  const disconnected = [...graph.nodes.values()]
    .filter((node) => node.id !== graph.rootId && !tree.parentEdge.has(node.id) && !mainRoots.includes(node.id))
    .map((node) => node.id);
  const allRoots = uniq([...mainRoots, ...affiliateRoots, ...disconnected]);
  const allIds = uniq(allRoots.flatMap((id) => subtreeIds(id, tree.children)));
  if (allIds.length <= maxRows) {
    return [{ subtitle: "직제 문언 기반 조직도", rootIds: allRoots, nodeIds: allIds, kind: "complete" }];
  }

  if (!head) return allRoots.flatMap((id) => splitSubtreePlan(graph, tree, id, maxRows));

  const deputy = graph.findDeputy();
  const overviewIds = breadthFirstIds([head.id], tree.children, Math.min(maxRows, 24), 2);
  const plans = [{
    subtitle: "본부 기구 개요",
    rootIds: [head.id],
    nodeIds: overviewIds,
    kind: "overview",
  }];
  const branchParents = uniq([deputy?.id, head.id].filter(Boolean));
  const branchRoots = uniq(branchParents.flatMap((id) => tree.children.get(id) || []))
    .filter((id) => id !== deputy?.id && (tree.children.get(id)?.length || 0) > 0);
  const detailPlans = branchRoots.flatMap((id) => splitSubtreePlan(graph, tree, id, maxRows));
  const affiliatePlans = affiliateRoots.flatMap((id) => splitSubtreePlan(graph, tree, id, maxRows, "소속기관"));
  plans.push(...packSmallPlans(detailPlans, maxRows, "본부 하부조직"));
  plans.push(...packSmallPlans(affiliatePlans, maxRows, "소속기관"));

  if (plans.length === 1) {
    return splitSubtreePlan(graph, tree, head.id, maxRows);
  }
  return plans;
}

function packSmallPlans(plans, maxRows, label) {
  if (!plans.length) return [];
  const packed = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    packed.push(current);
    current = null;
  };
  for (const plan of plans) {
    const candidateIds = current ? uniq([...current.nodeIds, ...plan.nodeIds]) : plan.nodeIds;
    const repeatedSplitRoot = current && current.rootIds.some((id) => plan.rootIds.includes(id));
    if (current && (candidateIds.length > maxRows || repeatedSplitRoot)) flush();
    if (!current) {
      current = { ...plan, rootIds: [...plan.rootIds], nodeIds: [...plan.nodeIds] };
    } else {
      current.rootIds = uniq([...current.rootIds, ...plan.rootIds]);
      current.nodeIds = uniq([...current.nodeIds, ...plan.nodeIds]);
    }
  }
  flush();
  if (packed.length === 1) return packed.map((plan) => ({ ...plan, subtitle: label }));
  return packed.map((plan, index) => ({ ...plan, subtitle: `${label} (${index + 1}/${packed.length})` }));
}

function splitSubtreePlan(graph, tree, rootId, maxRows, prefix = "") {
  const all = subtreeIds(rootId, tree.children);
  const rootName = graph.nodes.get(rootId)?.name || "조직";
  if (all.length <= maxRows) {
    return [{
      subtitle: [prefix, rootName].filter(Boolean).join(" · "),
      rootIds: [rootId],
      nodeIds: all,
      kind: prefix ? "affiliate" : "detail",
    }];
  }

  const capacity = Math.max(6, maxRows - 1);
  const directChildren = tree.children.get(rootId) || [];
  if (!directChildren.length) {
    return [{ subtitle: rootName, rootIds: [rootId], nodeIds: all.slice(0, maxRows), kind: "detail" }];
  }

  const pages = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    pages.push({ rootIds: [rootId], nodeIds: [rootId, ...current], kind: prefix ? "affiliate" : "detail" });
    current = [];
  };
  for (const childId of directChildren) {
    const childIds = subtreeIds(childId, tree.children);
    if (childIds.length > capacity) {
      flush();
      const childPlans = splitSubtreePlan(graph, tree, childId, capacity);
      for (const childPlan of childPlans) {
        pages.push({
          rootIds: [rootId],
          nodeIds: uniq([rootId, ...childPlan.nodeIds]),
          kind: prefix ? "affiliate" : "detail",
        });
      }
      continue;
    }
    if (current.length + childIds.length > capacity) flush();
    current.push(...childIds);
  }
  flush();
  return pages.map((page, index) => ({
    ...page,
    subtitle: `${[prefix, rootName].filter(Boolean).join(" · ")} (${index + 1}/${pages.length})`,
  }));
}

function buildOutlineManifest(graph, tree, plan, context) {
  const selected = new Set(plan.nodeIds);
  const roots = uniq([
    ...plan.rootIds.filter((id) => selected.has(id)),
    ...plan.nodeIds.filter((id) => !selected.has(tree.parentEdge.get(id)?.parent)),
  ]);
  const rows = [];
  const seen = new Set();
  const visit = (id, depth) => {
    if (!selected.has(id) || seen.has(id)) return;
    seen.add(id);
    rows.push({ id, depth });
    for (const childId of tree.children.get(id) || []) visit(childId, depth + 1);
  };
  for (const id of roots) visit(id, 0);
  for (const id of plan.nodeIds) visit(id, 0);

  const contentTop = 31;
  const contentBottom = 279.5;
  const pitch = Math.min(8.35, Math.max(5.35, (contentBottom - contentTop) / Math.max(rows.length, 1)));
  const boxHeight = Math.min(7.2, Math.max(4.35, pitch - 1.05));
  const maxDepth = Math.max(0, ...rows.map((row) => row.depth));
  const indent = Math.min(11.5, Math.max(7.2, 34 / Math.max(1, maxDepth)));
  const positions = new Map();
  const boxes = [];
  rows.forEach((row, index) => {
    const node = graph.nodes.get(row.id);
    const x = round(14 + row.depth * indent);
    const y = round(contentTop + index * pitch);
    const width = round(Math.max(42, 196 - x));
    const style = styleForNode(node, row.depth, roots.includes(row.id));
    const fontSizePt = round(Math.min(style.root ? 8.4 : 7.2, Math.max(5.25, boxHeight * 1.28)));
    const objectId = `node-${node.id}`;
    const geometry = { x, y, width, height: round(boxHeight) };
    positions.set(row.id, { ...geometry, objectId, centerY: round(y + boxHeight / 2), bottom: round(y + boxHeight) });
    boxes.push({
      id: objectId,
      type: "textbox",
      text: nodeLabel(node),
      geometry,
      style: {
        fill: style.fill,
        stroke: style.stroke,
        strokeWidthMm: style.root ? 0.42 : 0.3,
        dash: style.dash,
        textColor: style.text,
        fontFamily: "맑은 고딕",
        fontSizePt,
        bold: style.bold,
        align: "left",
        verticalAlign: "center",
        paddingMm: 1.2,
      },
      metadata: {
        role: "organization-node",
        nodeId: node.id,
        kind: node.kind,
        rank: node.rank,
      },
    });
  });

  const lines = [];
  for (const parentId of plan.nodeIds) {
    const parent = positions.get(parentId);
    if (!parent) continue;
    const childIds = (tree.children.get(parentId) || []).filter((id) => positions.has(id));
    if (!childIds.length) continue;
    const childPositions = childIds.map((id) => positions.get(id));
    const trunkX = round(Math.min(...childPositions.map((position) => position.x)) - 2.8);
    const lastChild = childPositions.at(-1);
    if (lastChild.centerY > parent.bottom + 0.05) {
      lines.push(lineObject(
        `trunk-${parentId}-${context.index + 1}`,
        trunkX,
        parent.bottom,
        trunkX,
        lastChild.centerY,
        { role: "child-trunk", parentId: parent.objectId },
      ));
    }
    childIds.forEach((childId) => {
      const child = positions.get(childId);
      const edge = tree.parentEdge.get(childId);
      lines.push(lineObject(
        `link-${parentId}-${childId}-${context.index + 1}`,
        trunkX,
        child.centerY,
        round(child.x + 0.35),
        child.centerY,
        {
          role: "child-link",
          parentId: parent.objectId,
          childId: child.objectId,
          dash: edge?.type === "advisor" || edge?.type === "jurisdiction" ? "dash" : "solid",
        },
      ));
    });
  }

  const title = `${graph.meta.institution} 조직도`;
  const asOf = context.asOf ? `직제 기준 ${displayDateLoose(context.asOf)}` : "직제·시행규칙 문언 기준";
  const labels = [
    textObject("document-title", 12, 7, 128, 7.6, title, { fontSizePt: 12.2, bold: true }),
    textObject("document-asof", 142, 7, 56, 7.6, asOf, { fontSizePt: 6.7, bold: true, align: "right", color: COLORS.muted }),
    textObject("document-subtitle", 12, 16.4, 146, 6.2, plan.subtitle, { fontSizePt: 7.2, bold: true, color: COLORS.muted }),
    textObject("document-page", 160, 16.4, 38, 6.2, `${context.index + 1} / ${context.pageCount}`, { fontSizePt: 6.4, bold: true, align: "right", color: COLORS.quiet }),
    textObject("footer-source", 12, 286.1, 150, 5.8, `${context.lawNames.join(" · ")} · 자동 파싱 후 네이티브 객체 작도`, { fontSizePt: 5.3, color: COLORS.quiet }),
    textObject("footer-format", 164, 286.1, 34, 5.8, "A4 세로 · 편집형", { fontSizePt: 5.3, bold: true, align: "right", color: COLORS.muted }),
  ];
  const rules = [
    lineObject("header-rule", 12, 25.7, 198, 25.7, { role: "header-rule", color: "#AAB3BC", widthMm: 0.3 }),
    lineObject("footer-rule", 12, 283.5, 198, 283.5, { role: "footer-rule", color: "#D4DAE0", widthMm: 0.24 }),
  ];
  const objects = [...rules, ...lines, ...boxes, ...labels];
  const suffix = context.pageCount > 1 ? `-${context.index + 1}` : "";
  return {
    schema: NATIVE_LAW_SCHEMA,
    version: 1,
    title: `${title} · ${plan.subtitle}`,
    fileName: `${safeFilePart(graph.meta.institution)}-${safeFilePart(plan.subtitle)}${suffix}-편집형.hwpx`,
    source: {
      institution: graph.meta.institution,
      asOf: context.asOf || "",
      laws: context.lawNames,
      fingerprints: context.fingerprints,
      inputRoles: ["decree", "rule"].filter((role) => context.fingerprints[role]),
      parserWarnings: context.warnings,
      note: "직제·시행규칙 문언을 로컬 파싱하여 생성한 한글 네이티브 객체 명세",
    },
    page: PAGE,
    objects,
    verification: countObjects(objects),
  };
}

function styleForNode(node, depth, isRoot) {
  const metadata = node.metadata || {};
  if (node.kind === "head" || node.kind === "deputy") {
    return { fill: COLORS.headFill, stroke: COLORS.headLine, text: COLORS.headText, dash: "solid", bold: true, root: true };
  }
  if (node.kind === "affiliated") {
    return { fill: COLORS.affiliateFill, stroke: COLORS.affiliateLine, text: COLORS.ink, dash: "solid", bold: true, root: isRoot };
  }
  if (node.kind === "temporary" || metadata.temporary) {
    return { fill: COLORS.temporaryFill, stroke: COLORS.temporaryLine, text: COLORS.ink, dash: "dash", bold: true, root: isRoot };
  }
  if (node.kind === "advisor") {
    return { fill: COLORS.advisorFill, stroke: COLORS.advisorLine, text: COLORS.ink, dash: "dash", bold: depth <= 1, root: isRoot };
  }
  const rank = Number.isFinite(node.rank) ? node.rank : depth + 3;
  if (isRoot || rank <= 3 || depth === 0) {
    return { fill: COLORS.officeFill, stroke: COLORS.officeLine, text: COLORS.ink, dash: "solid", bold: true, root: true };
  }
  if (rank === 4 || depth === 1) {
    return { fill: COLORS.bureauFill, stroke: COLORS.bureauLine, text: COLORS.ink, dash: "solid", bold: true, root: false };
  }
  return { fill: COLORS.leafFill, stroke: COLORS.leafLine, text: COLORS.ink, dash: "solid", bold: false, root: false };
}

function lineObject(id, x1, y1, x2, y2, options = {}) {
  return {
    id,
    type: "line",
    geometry: { x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2) },
    style: {
      stroke: options.color || COLORS.edge,
      strokeWidthMm: options.widthMm || 0.3,
      dash: options.dash || "solid",
    },
    metadata: Object.fromEntries(
      ["role", "parentId", "childId"].map((key) => [key, options[key]]).filter(([, value]) => value),
    ),
  };
}

function textObject(id, x, y, width, height, text, options = {}) {
  return {
    id,
    type: "textbox",
    text: String(text || ""),
    geometry: { x: round(x), y: round(y), width: round(width), height: round(height) },
    style: {
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      dash: "solid",
      textColor: options.color || COLORS.ink,
      fontFamily: "맑은 고딕",
      fontSizePt: options.fontSizePt || 6,
      bold: Boolean(options.bold),
      align: options.align || "left",
      verticalAlign: "center",
      paddingMm: 0,
    },
    metadata: { role: options.role || "document-label" },
  };
}

function countObjects(objects) {
  const lineCount = objects.filter((object) => object.type === "line").length;
  const rectangleCount = objects.filter((object) => object.type === "rectangle").length;
  const textBoxCount = objects.filter((object) => object.type === "textbox").length;
  return {
    expectedPageCount: 1,
    expectedNativeObjectCount: objects.length,
    expectedLineObjectCount: lineCount,
    expectedRectangleObjectCount: rectangleCount,
    expectedTextBoxObjectCount: textBoxCount,
    expectedEditableTextObjectCount: textBoxCount,
  };
}

function resolveFocusNodes(graph, names) {
  const nodes = [];
  const missing = [];
  for (const name of names) {
    const exact = graph.nodeByName(name);
    const fuzzy = exact || [...graph.nodes.values()].find((node) => node.name.replace(/\s/g, "") === name.replace(/\s/g, ""));
    if (fuzzy) nodes.push(fuzzy);
    else missing.push(name);
  }
  return { nodes: uniq(nodes.map((node) => node.id)).map((id) => graph.nodes.get(id)), missing };
}

function parseFocusNames(value) {
  return uniq(String(value || "").split(/[\n,;|]+/).map((item) => item.trim()));
}

function removeNestedRoots(ids, parentEdge) {
  const selected = new Set(ids);
  return ids.filter((id) => {
    let cursor = parentEdge.get(id)?.parent;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (selected.has(cursor)) return false;
      seen.add(cursor);
      cursor = parentEdge.get(cursor)?.parent;
    }
    return true;
  });
}

function subtreeIds(rootId, children) {
  const result = [];
  const seen = new Set();
  const visit = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
    for (const childId of children.get(id) || []) visit(childId);
  };
  visit(rootId);
  return result;
}

function breadthFirstIds(roots, children, limit, maxDepth) {
  const result = [];
  const seen = new Set();
  const queue = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length && result.length < limit) {
    const current = queue.shift();
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    result.push(current.id);
    if (current.depth >= maxDepth) continue;
    for (const childId of children.get(current.id) || []) queue.push({ id: childId, depth: current.depth + 1 });
  }
  return result;
}

function compareNodes(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return (left.rank ?? 99) - (right.rank ?? 99) || left.name.localeCompare(right.name, "ko");
}

function nodeLabel(node) {
  const markers = [];
  if (node.metadata?.grade) markers.push(node.metadata.grade);
  if (node.metadata?.temporary || node.kind === "temporary") markers.push("한시");
  const prefix = markers.length ? `(${markers.join("·")})  ` : "";
  return `${prefix}${node.name}`;
}

function inferLawName(text, fallback) {
  const line = String(text).split("\n").map((item) => item.trim()).find((item) => /직제/.test(item) && !/^제\s*\d+조/.test(item));
  return line ? line.replace(/\s*\[.*$/, "").trim().slice(0, 80) : fallback;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const digits = text.replace(/\D/g, "");
  if (digits.length !== 8) throw new Error("기준일은 YYYY-MM-DD 형식으로 입력하세요.");
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function displayDateLoose(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 8) return String(value || "");
  return `${digits.slice(0, 4)}. ${Number(digits.slice(4, 6))}. ${Number(digits.slice(6, 8))}.`;
}

function cleanOptional(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeFilePart(value) {
  return String(value || "조직도")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "조직도";
}

function round(value) {
  return Number(Number(value || 0).toFixed(3));
}
