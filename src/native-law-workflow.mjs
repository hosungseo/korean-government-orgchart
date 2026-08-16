import { parseOrganizationTexts } from "./parser.mjs";
import { OrgGraph, projectOperationalView } from "./model.mjs";
import {
  compareDutyAllocations,
  formatAllocationLine,
  formatCompactShares,
  notableAllocations,
} from "./duty-allocation.mjs";
import { normalizeWhitespace, stableId, uniq } from "./utils-core.mjs";

export const NATIVE_LAW_SCHEMA = "kr.go.mois.orgchart.hwp-native/v1";

export const NATIVE_LAW_LAYOUTS = Object.freeze({
  OUTLINE: "outline",
  COMPARISON_TWO_COLUMN: "comparison-two-column",
});

const PAGE = Object.freeze({
  paper: "A4",
  orientation: "portrait",
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ left: 10, right: 10, top: 10, bottom: 10 }),
});

// A4 세로에서 24개 이상을 한 줄 목록으로 누르면 조직 상자와 계선은
// 들어가더라도 검토·편집성이 급격히 떨어진다. 23개를 넘는 전체 조직은
// 개요와 하부조직으로 나누고, 사용자가 지정한 focus 출력은 기존처럼
// 해당 하위 트리만 독립적으로 분할한다.
const DEFAULT_MAX_ROWS = 23;
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
  jurisdictionFill: "#E3F1EF",
  jurisdictionLine: "#477D78",
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
  const layout = normalizeLayout(options.layout);
  const side = compileLawSide(options, { focusStrict: true });
  const manifests = side.plans.map((plan, index) => buildOutlineManifest(side.graph, side.tree, plan, {
    index,
    pageCount: side.plans.length,
    asOf: side.asOf,
    lawNames: side.lawNames,
    fingerprints: side.fingerprints,
    warnings: side.warnings,
    layout,
  }));
  return assembleWorkflow(side, manifests, {
    layout,
    legalGraph: side.legalGraph,
    decreeText: side.decreeText,
    ruleText: side.ruleText,
    lawSources: options.lawSources,
  });
}

export function buildNativeComparisonWorkflow(options = {}) {
  const before = compileLawSide(options.beforeSnapshot || options.before || {}, {
    focus: options.focus,
    maxRows: options.maxRows,
    focusStrict: false,
    label: "현행",
  });
  const after = compileLawSide(options.afterSnapshot || options.after || {}, {
    focus: options.focus,
    maxRows: options.maxRows,
    focusStrict: false,
    label: "개정",
  });
  if (before.institution && after.institution && before.institution !== after.institution) {
    throw new Error("서로 다른 기관의 조직도는 나란히 그릴 수 없습니다.");
  }

  const dutyAllocation = compareDutyAllocations(before.graph, after.graph);
  const pageCount = Math.max(before.plans.length, after.plans.length, 1);
  const institution = after.institution || before.institution;
  const warnings = uniq([
    ...before.warnings.map((warning) => `현행: ${warning}`),
    ...after.warnings.map((warning) => `개정: ${warning}`),
    ...(pageCount > 1 ? [`가독성을 지키기 위해 A4 ${pageCount}쪽으로 자동 분할했습니다.`] : []),
  ]);
  const manifests = Array.from({ length: pageCount }, (_, index) => buildComparisonManifest({
    before,
    after,
    beforePlan: before.plans[index] || null,
    afterPlan: after.plans[index] || null,
    index,
    pageCount,
    institution,
    warnings,
    dutyAllocation,
  }));

  return {
    manifests,
    pages: manifests.map((manifest, index) => ({
      index,
      label: manifest.source.pageLabel,
      nodeCount: (before.plans[index]?.nodeIds.length || 0) + (after.plans[index]?.nodeIds.length || 0),
      objectCount: manifest.objects.length,
      fileName: manifest.fileName,
    })),
    summary: {
      institution,
      asOf: after.asOf || before.asOf || null,
      beforeAsOf: before.asOf || null,
      afterAsOf: after.asOf || null,
      nodeCount: before.visualNodes.length + after.visualNodes.length,
      relationCount: before.graph.edges.size + after.graph.edges.size,
      pageCount,
      decreePresent: before.decreePresent || after.decreePresent,
      rulePresent: before.rulePresent || after.rulePresent,
      focusOptions: mergeFocusOptions(before.focusOptions, after.focusOptions),
      layout: NATIVE_LAW_LAYOUTS.COMPARISON_TWO_COLUMN,
      comparison: "dual-outline",
      dutyAllocation,
      warnings,
    },
    snapshot: after.snapshotBase,
    beforeSnapshot: before.snapshotBase,
    afterSnapshot: after.snapshotBase,
  };
}

function compileLawSide(input = {}, options = {}) {
  if (input.graph || input.schema === "kr.go.mois.orgchart.history/v1") {
    return compileGraphSide(input.snapshot || input, options);
  }

  const decreeText = normalizeWhitespace(input.decreeText);
  const ruleText = normalizeWhitespace(input.ruleText);
  const documents = [];
  const sources = [];
  if (decreeText) {
    documents.push(decreeText);
    sources.push(options.label ? `${options.label} 직제 입력문` : "직제 입력문");
  }
  if (ruleText) {
    documents.push(ruleText);
    sources.push(options.label ? `${options.label} 직제 시행규칙 입력문` : "직제 시행규칙 입력문");
  }
  if (!documents.length) throw new Error("직제 또는 직제 시행규칙 문언을 하나 이상 입력하세요.");
  if (documents.join("\n").length < 30) throw new Error("입력 문언이 너무 짧습니다. 조직 설치 조문을 함께 붙여넣으세요.");

  const legalGraph = parseOrganizationTexts(documents, {
    sources,
    institution: cleanOptional(input.institution || options.institution),
    asOf: normalizeDate(input.asOf || options.asOf),
  });
  const graph = projectOperationalView(legalGraph);
  return finishLawSide(graph, {
    ...options,
    focus: input.focus ?? options.focus,
    maxRows: input.maxRows ?? options.maxRows,
    asOf: input.asOf || options.asOf,
    institution: input.institution || options.institution,
    legalGraph,
    decreeText,
    ruleText,
    decreePresent: Boolean(decreeText),
    rulePresent: Boolean(ruleText),
    lawNames: uniq([
      decreeText ? inferLawName(decreeText, `${graph.meta.institution} 직제`) : "",
      ruleText ? inferLawName(ruleText, `${graph.meta.institution} 직제 시행규칙`) : "",
    ]),
    fingerprints: {
      ...(decreeText ? { decree: stableId(decreeText) } : {}),
      ...(ruleText ? { rule: stableId(ruleText) } : {}),
    },
    extraWarnings: [
      ...(!decreeText ? ["직제 본문이 없어 실·국·소속기관이 누락될 수 있습니다."] : []),
      ...(!ruleText ? ["직제 시행규칙이 없어 과·담당관·팀이 누락될 수 있습니다."] : []),
    ],
    lawSources: input.lawSources,
  });
}

function compileGraphSide(snapshot, options = {}) {
  if (!snapshot?.graph) throw new Error("조직 스냅샷에 그래프가 없습니다.");
  const graph = OrgGraph.fromJSON(snapshot.graph);
  const laws = Array.isArray(snapshot.laws) ? snapshot.laws : [];
  return finishLawSide(graph, {
    ...options,
    focus: options.focus,
    maxRows: options.maxRows,
    legalGraph: snapshot.legalGraph ? OrgGraph.fromJSON(snapshot.legalGraph) : null,
    decreeText: laws.find((law) => law.role === "decree")?.text || "",
    ruleText: laws.find((law) => law.role === "rule")?.text || "",
    decreePresent: laws.some((law) => law.role === "decree") || Boolean(snapshot.decreePresent),
    rulePresent: laws.some((law) => law.role === "rule") || Boolean(snapshot.rulePresent),
    lawNames: laws.map((law) => law?.name).filter(Boolean),
    fingerprints: Object.fromEntries(
      laws.filter((law) => law?.role && law?.fingerprint).map((law) => [law.role, law.fingerprint]),
    ),
    extraWarnings: snapshot.summary?.warnings || [],
    asOfOverride: snapshot.asOf || null,
    institutionOverride: snapshot.institution || null,
  });
}

function finishLawSide(graph, options = {}) {
  const visualNodes = [...graph.nodes.values()].filter((node) => node.id !== graph.rootId);
  if (!visualNodes.length) {
    throw new Error("문언에서 조직을 찾지 못했습니다. ‘○○에 △△실·국·과를 둔다’ 문장이 포함됐는지 확인하세요.");
  }

  const tree = buildPrimaryTree(graph);
  const focusNames = parseFocusNames(options.focus);
  const focusResult = resolveFocusNodes(graph, focusNames);
  if (focusNames.length && !focusResult.nodes.length) {
    if (options.focusStrict) throw new Error(`작도 범위를 찾지 못했습니다: ${focusNames.join(", ")}`);
  }

  const maxRows = clampInteger(options.maxRows, 20, 48, DEFAULT_MAX_ROWS);
  const focused = focusResult.nodes;
  const plans = buildPagePlans(graph, tree, focused, maxRows);
  const asOf = options.asOfOverride || graph.meta.asOf || (options.asOf ? normalizeDate(options.asOf) : null);
  const institution = options.institutionOverride || graph.meta.institution;
  const warnings = uniq([
    ...(options.extraWarnings || []),
    ...focusResult.missing.map((name) => `작도 범위를 찾지 못해 제외했습니다: ${name}`),
    ...(focusNames.length && !focused.length ? [`작도 범위(${focusNames.join(", ")})를 이 시점에서 찾지 못해 전체 조직도를 그립니다.`] : []),
    ...(graph.meta.warnings || []),
    ...(plans.length > 1 ? [`가독성을 지키기 위해 A4 ${plans.length}쪽으로 자동 분할했습니다.`] : []),
  ]);
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
    graph,
    tree,
    plans,
    visualNodes,
    warnings,
    lawNames: uniq(options.lawNames || []),
    fingerprints: options.fingerprints || {},
    asOf,
    institution,
    decreePresent: Boolean(options.decreePresent),
    rulePresent: Boolean(options.rulePresent),
    decreeText: options.decreeText || "",
    ruleText: options.ruleText || "",
    legalGraph: options.legalGraph || null,
    focusOptions,
    snapshotBase: {
      schema: "kr.go.mois.orgchart.history/v1",
      institution,
      asOf,
      laws: [
        ...(options.decreeText ? [{
          role: "decree",
          name: (options.lawNames || []).find((name) => /시행규칙/.test(name) === false) || `${institution} 직제`,
          effectiveDate: options.lawSources?.decree?.effectiveDate || asOf,
          promulgatedDate: options.lawSources?.decree?.promulgatedDate || null,
          fingerprint: options.fingerprints?.decree || null,
          text: options.decreeText,
        }] : []),
        ...(options.ruleText ? [{
          role: "rule",
          name: (options.lawNames || []).find((name) => /시행규칙/.test(name)) || `${institution} 직제 시행규칙`,
          effectiveDate: options.lawSources?.rule?.effectiveDate || asOf,
          promulgatedDate: options.lawSources?.rule?.promulgatedDate || null,
          fingerprint: options.fingerprints?.rule || null,
          text: options.ruleText,
        }] : []),
      ],
      graph: graph.toJSON(),
      legalGraph: options.legalGraph?.toJSON?.() || options.legalGraph || null,
      summary: {
        nodeCount: visualNodes.length,
        relationCount: graph.edges.size,
        pageCount: plans.length,
        warnings,
      },
    },
  };
}

function assembleWorkflow(side, manifests, extras = {}) {
  return {
    manifests,
    pages: manifests.map((manifest, index) => ({
      index,
      label: side.plans[index].subtitle,
      nodeCount: side.plans[index].nodeIds.length,
      objectCount: manifest.objects.length,
      fileName: manifest.fileName,
    })),
    summary: {
      institution: side.institution,
      asOf: side.asOf,
      nodeCount: side.visualNodes.length,
      relationCount: side.graph.edges.size,
      pageCount: manifests.length,
      decreePresent: side.decreePresent,
      rulePresent: side.rulePresent,
      focusOptions: side.focusOptions,
      layout: extras.layout,
      warnings: side.warnings,
    },
    snapshot: {
      ...side.snapshotBase,
      laws: [
        ...(side.decreeText ? [{
          role: "decree",
          name: side.lawNames.find((name) => /시행규칙/.test(name) === false) || `${side.institution} 직제`,
          effectiveDate: extras.lawSources?.decree?.effectiveDate || side.asOf,
          promulgatedDate: extras.lawSources?.decree?.promulgatedDate || null,
          fingerprint: side.fingerprints.decree || null,
          text: side.decreeText,
        }] : []),
        ...(side.ruleText ? [{
          role: "rule",
          name: side.lawNames.find((name) => /시행규칙/.test(name)) || `${side.institution} 직제 시행규칙`,
          effectiveDate: extras.lawSources?.rule?.effectiveDate || side.asOf,
          promulgatedDate: extras.lawSources?.rule?.promulgatedDate || null,
          fingerprint: side.fingerprints.rule || null,
          text: side.ruleText,
        }] : []),
      ],
      legalGraph: extras.legalGraph?.toJSON?.() || extras.legalGraph || side.snapshotBase.legalGraph,
    },
  };
}

function mergeFocusOptions(left = [], right = []) {
  const byName = new Map();
  for (const option of [...left, ...right]) {
    const existing = byName.get(option.name);
    if (!existing || option.descendantCount > existing.descendantCount) byName.set(option.name, option);
  }
  return [...byName.values()].sort((leftOption, rightOption) => leftOption.name.localeCompare(rightOption.name, "ko"));
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

  // 소속기관이 한두 개뿐인 기관은 그것만을 위한 빈약한 셋째 쪽을 만들지
  // 않고 개요 쪽에 함께 표시한다. 원자력안전위원회처럼 본부 상세 한 쪽과
  // 소속기관 1개가 있는 구조는 이 규칙으로 정확히 2쪽이 된다.
  const packedAffiliates = packSmallPlans(affiliatePlans, maxRows, "소속기관");
  if (packedAffiliates.length === 1) {
    const overview = plans[0];
    const affiliate = packedAffiliates[0];
    const combinedIds = uniq([...overview.nodeIds, ...affiliate.nodeIds]);
    if (combinedIds.length <= maxRows) {
      plans[0] = {
        ...overview,
        subtitle: `${overview.subtitle} · 소속기관`,
        rootIds: uniq([...overview.rootIds, ...affiliate.rootIds]),
        nodeIds: combinedIds,
      };
    } else {
      plans.push(affiliate);
    }
  } else {
    plans.push(...packedAffiliates);
  }

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

function layoutTreeInFrame(graph, tree, plan, frame, prefix = "") {
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

  const columnWidth = Math.max(24, frame.right - frame.left);
  const pitch = Math.min(8.35, Math.max(5.35, (frame.bottom - frame.top) / Math.max(rows.length, 1)));
  const boxHeight = Math.min(7.2, Math.max(4.35, pitch - 1.05));
  const maxDepth = Math.max(0, ...rows.map((row) => row.depth));
  const indent = Math.min(columnWidth > 120 ? 11.5 : 7.2, Math.max(5.4, (columnWidth * 0.36) / Math.max(1, maxDepth)));
  const idPrefix = prefix ? `${prefix}-` : "";
  const positions = new Map();
  const boxes = [];
  rows.forEach((row, index) => {
    const node = graph.nodes.get(row.id);
    const jurisdictionContainer = node.kind === "advisor"
      && (tree.children.get(row.id) || []).some((childId) => (
        selected.has(childId) && tree.parentEdge.get(childId)?.type === "jurisdiction"
      ));
    const x = round(frame.left + row.depth * indent);
    const y = round(frame.top + index * pitch);
    const width = round(Math.max(columnWidth > 120 ? 42 : 28, frame.right - x));
    const style = styleForNode(node, row.depth, roots.includes(row.id), { jurisdictionContainer });
    const fontSizePt = round(Math.min(style.root ? 8.4 : 7.2, Math.max(5.25, boxHeight * 1.28)));
    const objectId = `${idPrefix}node-${node.id}`;
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
        side: prefix || "single",
        nodeId: node.id,
        nodeName: node.name,
        kind: node.kind,
        rank: node.rank,
        ...(jurisdictionContainer ? { renderRole: "jurisdiction-container" } : {}),
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
        `${idPrefix}trunk-${parentId}`,
        trunkX,
        parent.bottom,
        trunkX,
        lastChild.centerY,
        { role: "child-trunk", parentId: parent.objectId, side: prefix || "single" },
      ));
    }
    childIds.forEach((childId) => {
      const child = positions.get(childId);
      const edge = tree.parentEdge.get(childId);
      lines.push(lineObject(
        `${idPrefix}link-${parentId}-${childId}`,
        trunkX,
        child.centerY,
        round(child.x + 0.35),
        child.centerY,
        {
          role: "child-link",
          parentId: parent.objectId,
          childId: child.objectId,
          dash: edge?.type === "advisor" ? "dash" : "solid",
          side: prefix || "single",
        },
      ));
    });
  }
  return { boxes, lines };
}

function buildOutlineManifest(graph, tree, plan, context) {
  const comparison = context.layout === NATIVE_LAW_LAYOUTS.COMPARISON_TWO_COLUMN;
  const comparisonDividerX = 104;
  const treeLayout = layoutTreeInFrame(graph, tree, plan, {
    left: 14,
    right: comparison ? comparisonDividerX - 7 : 196,
    top: 31,
    bottom: 279.5,
  });
  const boxes = treeLayout.boxes;
  const lines = treeLayout.lines.map((line) => ({
    ...line,
    id: `${line.id}-${context.index + 1}`,
  }));

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
  const comparisonObjects = comparison
    ? [
      lineObject("comparison-divider", comparisonDividerX, 31, comparisonDividerX, 279.5, {
        role: "comparison-divider",
        color: "#D4DAE0",
        widthMm: 0.35,
      }),
      textObject("comparison-header", 112, 31, 84, 7, "개편 전·후 대비", {
        fontSizePt: 8,
        bold: true,
        color: COLORS.muted,
        role: "comparison-header",
      }),
      textObject("comparison-note", 112, 40, 82, 15, "대응 조직·개편 내역을\n오른쪽 영역에 배치", {
        fontSizePt: 6.4,
        color: COLORS.quiet,
        role: "comparison-note",
      }),
      lineObject("comparison-rule", 112, 58, 196, 58, {
        role: "comparison-rule",
        color: "#D4DAE0",
        widthMm: 0.24,
      }),
    ]
    : [];
  const objects = [...rules, ...comparisonObjects, ...lines, ...boxes, ...labels];
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
      layout: context.layout,
      renderView: graph.meta.renderView || "legal",
      inputRoles: ["decree", "rule"].filter((role) => context.fingerprints[role]),
      parserWarnings: context.warnings,
      note: "직제·시행규칙 문언을 로컬 파싱하여 생성한 한글 네이티브 객체 명세",
    },
    page: PAGE,
    objects,
    verification: countObjects(objects),
  };
}

function styleForNode(node, depth, isRoot, options = {}) {
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
  if (node.kind === "advisor" && options.jurisdictionContainer) {
    return { fill: COLORS.jurisdictionFill, stroke: COLORS.jurisdictionLine, text: COLORS.ink, dash: "solid", bold: true, root: false };
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

function buildComparisonManifest({
  before,
  after,
  beforePlan,
  afterPlan,
  index,
  pageCount,
  institution,
  warnings,
  dutyAllocation,
}) {
  const dividerX = 104;
  const frameTop = 40;
  const notable = pickDisplayedAllocations(dutyAllocation);
  const frameBottom = notable.length ? 248 : 279.5;
  const beforeTree = beforePlan
    ? layoutTreeInFrame(before.graph, before.tree, beforePlan, {
      left: 14,
      right: notable.length ? 70 : dividerX - 6,
      top: frameTop,
      bottom: frameBottom,
    }, "before")
    : { boxes: [], lines: [] };
  const afterTree = afterPlan
    ? layoutTreeInFrame(after.graph, after.tree, afterPlan, {
      left: dividerX + 6,
      right: 198,
      top: frameTop,
      bottom: frameBottom,
    }, "after")
    : { boxes: [], lines: [] };

  const beforeAsOf = before.asOf ? `현행 ${displayDateLoose(before.asOf)}` : "현행";
  const afterAsOf = after.asOf ? `개정 ${displayDateLoose(after.asOf)}` : "개정";
  const pageLabel = [beforePlan?.subtitle, afterPlan?.subtitle].filter(Boolean).join(" · ") || "좌우 조직도";
  const labels = [
    textObject("document-title", 12, 7, 128, 7.6, `${institution} 조직 대비`, { fontSizePt: 12.2, bold: true }),
    textObject("document-asof", 142, 7, 56, 7.6, `${beforeAsOf} · ${afterAsOf}`, {
      fontSizePt: 6.4,
      bold: true,
      align: "right",
      color: COLORS.muted,
    }),
    textObject("document-subtitle", 12, 16.4, 146, 6.2, pageLabel, { fontSizePt: 7.2, bold: true, color: COLORS.muted }),
    textObject("document-page", 160, 16.4, 38, 6.2, `${index + 1} / ${pageCount}`, {
      fontSizePt: 6.4,
      bold: true,
      align: "right",
      color: COLORS.quiet,
    }),
    textObject("before-header", 12, 31, 86, 7, beforeAsOf, {
      fontSizePt: 7.4,
      bold: true,
      color: COLORS.muted,
      role: "comparison-header",
    }),
    textObject("after-header", 110, 31, 88, 7, afterAsOf, {
      fontSizePt: 7.4,
      bold: true,
      color: COLORS.muted,
      role: "comparison-header",
    }),
    textObject("footer-source", 12, 286.1, 150, 5.8, notable.length
      ? "좌우 조직도 + 재인용된 직제 호가 어느 과로 갈라졌는지 표시 · 다수결로 한 과만 찍지 않음"
      : "두 시점 조직도를 좌우로 나란히 작도 · 재인용된 직제 호가 있으면 분할 비율을 표시", {
      fontSizePt: 5.3,
      color: COLORS.quiet,
    }),
    textObject("footer-format", 164, 286.1, 34, 5.8, "A4 세로 · 편집형", {
      fontSizePt: 5.3,
      bold: true,
      align: "right",
      color: COLORS.muted,
    }),
  ];
  if (!beforePlan) {
    labels.push(textObject("before-empty", 14, 48, 82, 12, "이 쪽에는 더 그릴 조직이 없습니다.", {
      fontSizePt: 6.2,
      color: COLORS.quiet,
      role: "comparison-empty",
    }));
  }
  if (!afterPlan) {
    labels.push(textObject("after-empty", 112, 48, 82, 12, "이 쪽에는 더 그릴 조직이 없습니다.", {
      fontSizePt: 6.2,
      color: COLORS.quiet,
      role: "comparison-empty",
    }));
  }
  labels.push(...allocationBadgeObjects(beforeTree, notable));
  labels.push(...allocationLabelObjects(notable));

  const objects = [
    lineObject("header-rule", 12, 25.7, 198, 25.7, { role: "header-rule", color: "#AAB3BC", widthMm: 0.3 }),
    lineObject("footer-rule", 12, 283.5, 198, 283.5, { role: "footer-rule", color: "#D4DAE0", widthMm: 0.24 }),
    lineObject("comparison-divider", dividerX, 31, dividerX, 279.5, {
      role: "comparison-divider",
      color: "#D4DAE0",
      widthMm: 0.35,
    }),
    ...beforeTree.lines,
    ...afterTree.lines,
    ...beforeTree.boxes,
    ...afterTree.boxes,
    ...labels,
  ];
  const suffix = pageCount > 1 ? `-${index + 1}` : "";
  return {
    schema: NATIVE_LAW_SCHEMA,
    version: 1,
    title: `${institution} 조직 대비 · ${pageLabel}`,
    fileName: `${safeFilePart(institution)}-좌우조직도${suffix}-편집형.hwpx`,
    source: {
      institution,
      asOf: after.asOf || before.asOf || "",
      beforeAsOf: before.asOf || "",
      afterAsOf: after.asOf || "",
      laws: uniq([...before.lawNames, ...after.lawNames]),
      fingerprints: { ...before.fingerprints, ...after.fingerprints },
      layout: NATIVE_LAW_LAYOUTS.COMPARISON_TWO_COLUMN,
      comparison: "dual-outline",
      dutyAllocation,
      pageLabel,
      renderView: "comparison",
      inputRoles: ["decree", "rule"].filter((role) => before.fingerprints[role] || after.fingerprints[role]),
      parserWarnings: warnings,
      note: notable.length
        ? "두 시점 조직도와 재인용 호 분할 비율을 함께 작도한 한글 네이티브 객체 명세"
        : "두 시점의 직제 조직도를 좌우로 나란히 작도한 한글 네이티브 객체 명세",
    },
    page: PAGE,
    objects,
    verification: countObjects(objects),
  };
}

function pickDisplayedAllocations(dutyAllocation) {
  const department = notableAllocations(dutyAllocation?.units || []);
  if (department.length) return department.slice(0, 4);
  return notableAllocations(dutyAllocation?.parentUnits || []).slice(0, 4);
}

function allocationBadgeObjects(tree, units) {
  const byName = new Map(units.map((unit) => [unit.unit, unit]));
  const objects = [];
  for (const box of tree.boxes || []) {
    const unit = byName.get(box.metadata?.nodeName);
    if (!unit) continue;
    const compact = formatCompactShares(unit);
    if (!compact) continue;
    objects.push(textObject(
      `allocation-badge-${box.metadata.nodeId}`,
      71,
      box.geometry.y,
      31,
      Math.max(box.geometry.height, 6.2),
      compact,
      {
        fontSizePt: 5.2,
        color: COLORS.muted,
        role: "allocation-badge",
      },
    ));
  }
  return objects;
}

function allocationLabelObjects(units) {
  if (!units.length) return [];
  const objects = [
    lineObject("allocation-rule", 12, 250.5, 198, 250.5, { role: "allocation-rule", color: "#D4DAE0", widthMm: 0.24 }),
    textObject("allocation-title", 12, 252.2, 186, 6, "호 분할 · 재인용된 직제 호가 어느 과로 갔는지", {
      fontSizePt: 6.6,
      bold: true,
      color: COLORS.muted,
      role: "allocation-title",
    }),
  ];
  units.forEach((unit, index) => {
    objects.push(textObject(
      `allocation-line-${index + 1}`,
      12,
      258.4 + index * 6.2,
      186,
      6,
      formatAllocationLine(unit),
      {
        fontSizePt: 5.8,
        color: COLORS.ink,
        role: "allocation-line",
      },
    ));
  });
  return objects;
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
      ["role", "parentId", "childId", "side"].map((key) => [key, options[key]]).filter(([, value]) => value),
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

function normalizeLayout(value) {
  const layout = String(value || "").trim().toLowerCase();
  return layout === NATIVE_LAW_LAYOUTS.COMPARISON_TWO_COLUMN
    || layout === "comparison"
    || layout === "two-column"
    ? NATIVE_LAW_LAYOUTS.COMPARISON_TWO_COLUMN
    : NATIVE_LAW_LAYOUTS.OUTLINE;
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
