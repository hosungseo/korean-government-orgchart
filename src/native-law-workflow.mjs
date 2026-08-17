import { PARSER_VERSION, parseOrganizationTexts } from "./parser.mjs";
import { OrgGraph, projectOperationalView } from "./model.mjs";
import {
  compareDutyAllocations,
  formatAllocationLine,
  notableAllocations,
} from "./duty-allocation.mjs";
import { compareDepartmentDutyFunctions } from "./duty-lineage.mjs";
import { auditLegalDutyFacts, createLegalDutyFact } from "./legal-duty.mjs";
import { normalizeWhitespace, stableId, uniq } from "./utils-core.mjs";

export const NATIVE_LAW_SCHEMA = "kr.go.mois.orgchart.hwp-native/v1";

export const NATIVE_LAW_LAYOUTS = Object.freeze({
  OUTLINE: "outline",
  COMPARISON_TWO_COLUMN: "comparison-two-column",
  COMPARISON_MULTI_COLUMN: "comparison-multi-column",
});

const PAGE = Object.freeze({
  paper: "A4",
  orientation: "portrait",
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ left: 10, right: 10, top: 10, bottom: 10 }),
});

const PAGE_A3_LANDSCAPE = Object.freeze({
  paper: "A3",
  orientation: "landscape",
  widthMm: 420,
  heightMm: 297,
  marginMm: Object.freeze({ left: 12, right: 12, top: 10, bottom: 10 }),
});

// A4 세로에서 24개 이상을 한 줄 목록으로 누르면 조직 상자와 계선은
// 들어가더라도 검토·편집성이 급격히 떨어진다. 23개를 넘는 전체 조직은
// 개요와 하부조직으로 나누고, 사용자가 지정한 focus 출력은 기존처럼
// 해당 하위 트리만 독립적으로 분할한다.
const DEFAULT_MAX_ROWS = 23;
const COMPARISON_GUTTER = 18;
const CHANGE_LINK_COLORS = Object.freeze(["#B45309", "#0F766E", "#5B21B6", "#C2410C", "#155E75"]);
const CHANGE_LINK_DASH = "2.1 1.35";
const CHANGE_WRAP_DASH = "1.8 1.2";
const STATUS_NEW_COLOR = "#9A3412";
const STATUS_GONE_COLOR = "#7B8794";
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
  transfer: "#4A6F8C",
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
    dutyAudit: side.dutyAudit,
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
  const stages = normalizeComparisonStages(options);
  if (stages.length < 2) throw new Error("대비할 시점을 두 개 이상 입력하세요.");
  const onePage = Boolean(options.onePage);
  const sides = stages.map((stage, index) => compileLawSide(stage, {
    focus: options.focus,
    maxRows: options.maxRows,
    focusStrict: false,
    splitFocusRoots: onePage,
    label: stage.label || (index === 0 ? "현행" : index === stages.length - 1 ? "개정" : `시점 ${index + 1}`),
  }));
  const institutions = uniq(sides.map((side) => side.institution).filter(Boolean));
  if (institutions.length > 1) {
    throw new Error("서로 다른 기관의 조직도는 나란히 그릴 수 없습니다.");
  }
  if (sides.length >= 3) {
    return assembleMultiColumnComparison(sides, options);
  }

  const before = sides[0];
  const after = sides[1];
  const dutyAllocation = compareDutyAllocations(before.graph, after.graph);
  const dutyLineage = compactDutyLineage(compareDepartmentDutyFunctions(before.graph, after.graph));
  const institution = after.institution || before.institution;
  const stacked = onePage && Math.max(before.plans.length, after.plans.length) > 1;
  const pageCount = stacked ? 1 : Math.max(before.plans.length, after.plans.length, 1);
  const warnings = uniq([
    ...before.warnings.map((warning) => `현행: ${warning}`),
    ...after.warnings.map((warning) => `개정: ${warning}`),
    ...(!stacked && pageCount > 1 ? [`가독성을 지키기 위해 A4 ${pageCount}쪽으로 자동 분할했습니다.`] : []),
    ...(stacked ? ["두 개편을 한 장의 위·아래 대역으로 합쳤습니다."] : []),
  ]);
  const manifests = stacked
    ? [buildBandedComparisonManifest({ before, after, institution, warnings, dutyAllocation, dutyLineage })]
    : Array.from({ length: pageCount }, (_, index) => buildComparisonManifest({
      before,
      after,
      beforePlan: before.plans[index] || null,
      afterPlan: after.plans[index] || null,
      index,
      pageCount,
      institution,
      warnings,
      dutyAllocation,
      dutyLineage,
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
      comparison: stacked ? "dual-outline-bands" : "dual-outline",
      dutyAllocation,
      dutyLineage,
      dutyFactCount: (before.graph.meta?.dutyFacts?.length || 0) + (after.graph.meta?.dutyFacts?.length || 0),
      legalReadingAudits: [before.dutyAudit, after.dutyAudit],
      warnings,
    },
    snapshot: after.snapshotBase,
    beforeSnapshot: before.snapshotBase,
    afterSnapshot: after.snapshotBase,
  };
}

function normalizeComparisonStages(options = {}) {
  if (Array.isArray(options.stages) && options.stages.length) return options.stages;
  const stages = [];
  if (options.beforeSnapshot || options.before) stages.push(options.beforeSnapshot || options.before);
  if (options.afterSnapshot || options.after) stages.push(options.afterSnapshot || options.after);
  return stages;
}

function assembleMultiColumnComparison(sides, options = {}) {
  const institution = sides.at(-1).institution || sides[0].institution;
  const warnings = uniq([
    ...sides.flatMap((side, index) => side.warnings.map((warning) => `${side.asOf || `${index + 1}열`}: ${warning}`)),
    `${sides.length}개 시점을 A3 가로 ${sides.length}단으로 작도했습니다.`,
  ]);
  const page = PAGE_A3_LANDSCAPE;
  const dutyLineages = sides.slice(0, -1).map((side, index) => (
    compactDutyLineage(compareDepartmentDutyFunctions(side.graph, sides[index + 1].graph))
  ));
  const manifest = buildMultiColumnBandedManifest({
    sides,
    institution,
    warnings,
    page,
    dutyLineages,
  });
  return {
    manifests: [manifest],
    pages: [{
      index: 0,
      label: manifest.source.pageLabel,
      nodeCount: sides.reduce((sum, side) => sum + side.visualNodes.length, 0),
      objectCount: manifest.objects.length,
      fileName: manifest.fileName,
    }],
    summary: {
      institution,
      asOf: sides.at(-1).asOf || null,
      beforeAsOf: sides[0].asOf || null,
      afterAsOf: sides.at(-1).asOf || null,
      stageAsOf: sides.map((side) => side.asOf),
      nodeCount: sides.reduce((sum, side) => sum + side.visualNodes.length, 0),
      relationCount: sides.reduce((sum, side) => sum + side.graph.edges.size, 0),
      pageCount: 1,
      decreePresent: sides.some((side) => side.decreePresent),
      rulePresent: sides.some((side) => side.rulePresent),
      focusOptions: sides.reduce((merged, side) => mergeFocusOptions(merged, side.focusOptions), []),
      layout: NATIVE_LAW_LAYOUTS.COMPARISON_MULTI_COLUMN,
      comparison: `outline-${sides.length}-column`,
      columns: sides.length,
      paper: "A3",
      dutyAllocation: null,
      dutyLineages,
      dutyFactCount: sides.reduce((sum, side) => sum + (side.graph.meta?.dutyFacts?.length || 0), 0),
      legalReadingAudits: sides.map((side) => side.dutyAudit),
      warnings,
    },
    snapshot: sides.at(-1).snapshotBase,
    beforeSnapshot: sides[0].snapshotBase,
    afterSnapshot: sides.at(-1).snapshotBase,
    stageSnapshots: sides.map((side) => side.snapshotBase),
  };
}

function comparisonBandKey(plan, graph) {
  const names = (plan.rootIds || []).map((id) => graph.nodes.get(id)?.name || "").join(" ");
  if (/디지털정부|인공지능정부/.test(names)) return "digital";
  if (/조직|참여혁신/.test(names)) return "organization";
  if (/콘텐츠|미디어|저작권|국제문화|문화산업|해외(?:.*홍보|미디어|뉴스)/.test(names)) return "culture-media";
  if (/관광/.test(names)) return "tourism";
  return "other";
}

function comparisonBandKeys(sides) {
  const present = new Set(sides.flatMap((side) => (
    (side.plans || []).map((plan) => comparisonBandKey(plan, side.graph))
  )));
  return ["digital", "organization", "culture-media", "tourism", "other"]
    .filter((key) => present.has(key));
}

function mergePlans(plans) {
  if (!plans.length) return null;
  if (plans.length === 1) return plans[0];
  return {
    subtitle: plans.map((plan) => plan.subtitle).filter(Boolean).join(" · "),
    rootIds: uniq(plans.flatMap((plan) => plan.rootIds || [])),
    nodeIds: uniq(plans.flatMap((plan) => plan.nodeIds || [])),
    kind: "focus",
  };
}

function sidePlanForBand(side, bandKey) {
  return mergePlans((side.plans || []).filter((plan) => comparisonBandKey(plan, side.graph) === bandKey));
}

function uniqueBandCaption(row, bandKey) {
  const names = uniq(row.flatMap((plan) => String(plan?.subtitle || "").split(/\s*·\s*/)).filter(Boolean));
  if (bandKey === "digital") return "디지털·인공지능정부";
  if (bandKey === "organization") return "참여혁신·조직";
  if (bandKey === "culture-media") return "문화·미디어·저작권·국제홍보";
  if (bandKey === "tourism") return "관광";
  if (names.length) return names.join(" · ");
  return "대역";
}

function buildMultiColumnBandedManifest({ sides, institution, warnings, page, dutyLineages = [] }) {
  const columnCount = sides.length;
  const frameTop = 40;
  const frameBottom = 279.5;
  const bandKeys = comparisonBandKeys(sides);
  const bandPlans = bandKeys.map((key) => sides.map((side) => sidePlanForBand(side, key)));
  const gap = 6.4;
  const caption = 5.4;
  const weights = bandPlans.map((row) => Math.max(1, ...row.map((plan) => plan?.nodeIds.length || 0)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const available = frameBottom - frameTop - gap * Math.max(0, bandPlans.length - 1) - caption * bandPlans.length;
  const frames = multiColumnFrames(page, columnCount);
  const columnTrees = sides.map(() => []);
  const bandMarks = [];
  let cursor = frameTop;
  bandPlans.forEach((row, bandIndex) => {
    const treeHeight = available * (weights[bandIndex] / totalWeight);
    const top = cursor;
    const treeTop = top + caption;
    const treeBottom = treeTop + treeHeight;
    cursor = treeBottom + gap;
    row.forEach((plan, columnIndex) => {
      const frame = frames[columnIndex];
      const side = sides[columnIndex];
      const prefix = `c${columnIndex + 1}`;
      columnTrees[columnIndex].push(plan
        ? layoutTreeInFrame(side.graph, side.tree, plan, {
          left: frame.left,
          right: frame.right,
          top: treeTop,
          bottom: treeBottom,
        }, prefix, {
          idPrefix: `${prefix}-b${bandIndex + 1}`,
          side: prefix,
          compactWidth: columnCount >= 4,
        })
        : { boxes: [], lines: [] });
    });
    const captionText = uniqueBandCaption(row, bandKeys[bandIndex]);
    bandMarks.push(textObject(`band-caption-${bandIndex + 1}`, frames[0].left, top, page.widthMm - 28, 5, captionText, {
      fontSizePt: 6.4,
      bold: true,
      color: COLORS.muted,
      role: "comparison-band",
    }));
    if (bandIndex > 0) {
      bandMarks.push(lineObject(
        `band-rule-${bandIndex + 1}`,
        frames[0].left,
        top - gap / 2,
        frames.at(-1).right,
        top - gap / 2,
        { role: "comparison-band-rule", color: "#D4DAE0", widthMm: 0.24 },
      ));
    }
  });

  const transfers = [];
  for (let index = 0; index < columnCount - 1; index += 1) {
    const left = mergeTrees(columnTrees[index]);
    const right = mergeTrees(columnTrees[index + 1]);
    transfers.push(...correspondenceTransferObjects(
      left,
      right,
      frames[index].nextDividerX,
      {
        idPrefix: `col${index + 1}`,
        gutterMm: frames[index].gutterMm,
        dutyLineage: dutyLineages[index],
      },
    ));
    transfers.push(...lifecycleLabelObjects(left, right, {
      idPrefix: `col${index + 1}`,
      dutyLineage: dutyLineages[index],
    }));
  }
  const transferObjects = coalesceStatusLabels(transfers);

  const dates = sides.map((side) => (side.asOf ? displayDateLoose(side.asOf) : "기준일 없음"));
  const pageLabel = `${columnCount}단 대비`;
  const headerWidth = frames[0].right - frames[0].left;
  const labels = [
    textObject("document-title", 12, 7, 220, 7.6, `${institution} 조직 대비`, { fontSizePt: 12.2, bold: true }),
    textObject("document-asof", page.widthMm - 168, 7, 156, 7.6, dates.join(" · "), {
      fontSizePt: 6.4,
      bold: true,
      align: "right",
      color: COLORS.muted,
    }),
    textObject("document-subtitle", 12, 16.4, 280, 6.2, pageLabel, { fontSizePt: 6.6, bold: true, color: COLORS.muted }),
    textObject("document-page", page.widthMm - 50, 16.4, 38, 6.2, "1 / 1", {
      fontSizePt: 6.4,
      bold: true,
      align: "right",
      color: COLORS.quiet,
    }),
    ...frames.map((frame, index) => textObject(
      `column-header-${index + 1}`,
      frame.left,
      31,
      headerWidth,
      7,
      dates[index],
      { fontSizePt: 7.4, bold: true, color: COLORS.muted, role: "comparison-header" },
    )),
    textObject("footer-source", 12, 286.1, 280, 5.8, `A3 가로 ${columnCount}단 · 바뀐 과만 점선 · 처음 나타난 과 신설 · 사라진 과 폐지`, {
      fontSizePt: 5.3,
      color: COLORS.quiet,
    }),
    textObject("footer-format", page.widthMm - 46, 286.1, 34, 5.8, "A3 가로 · 편집형", {
      fontSizePt: 5.3,
      bold: true,
      align: "right",
      color: COLORS.muted,
    }),
    ...bandMarks,
  ];

  const objects = [
    lineObject("header-rule", 12, 25.7, page.widthMm - 12, 25.7, { role: "header-rule", color: "#AAB3BC", widthMm: 0.3 }),
    lineObject("footer-rule", 12, 283.5, page.widthMm - 12, 283.5, { role: "footer-rule", color: "#D4DAE0", widthMm: 0.24 }),
    ...frames.slice(0, -1).map((frame, index) => lineObject(
      `comparison-divider-${index + 1}`,
      frame.nextDividerX,
      31,
      frame.nextDividerX,
      279.5,
      { role: "comparison-divider", color: "#D4DAE0", widthMm: 0.35 },
    )),
    ...columnTrees.flatMap((trees) => trees.flatMap((tree) => tree.lines)),
    ...columnTrees.flatMap((trees) => trees.flatMap((tree) => tree.boxes)),
    ...transferObjects,
    ...labels,
  ];
  return {
    schema: NATIVE_LAW_SCHEMA,
    version: 1,
    title: `${institution} 조직 대비 · ${pageLabel}`,
    fileName: `${safeFilePart(institution)}-${columnCount}단조직도-편집형.hwpx`,
    source: {
      institution,
      asOf: sides.at(-1).asOf || "",
      beforeAsOf: sides[0].asOf || "",
      afterAsOf: sides.at(-1).asOf || "",
      stageAsOf: sides.map((side) => side.asOf || ""),
      laws: uniq(sides.flatMap((side) => side.lawNames)),
      fingerprints: Object.assign({}, ...sides.map((side) => side.fingerprints)),
      layout: NATIVE_LAW_LAYOUTS.COMPARISON_MULTI_COLUMN,
      comparison: `outline-${columnCount}-column`,
      columns: columnCount,
      dutyLineages,
      dutyFactCount: sides.reduce((sum, side) => sum + (side.graph.meta?.dutyFacts?.length || 0), 0),
      dutyFactStages: sides.map((side) => ({
        asOf: side.asOf,
        count: side.graph.meta?.dutyFacts?.length || 0,
      })),
      legalReadingAudits: sides.map((side) => ({ asOf: side.asOf, audit: side.dutyAudit })),
      pageLabel,
      renderView: "comparison",
      inputRoles: ["decree", "rule"].filter((role) => sides.some((side) => side.fingerprints[role])),
      parserWarnings: warnings,
      note: `${columnCount}개 시점의 직제 조직도를 A3 가로 ${columnCount}단으로 작도한 한글 네이티브 객체 명세`,
    },
    page,
    objects,
    verification: countObjects(objects),
  };
}

function multiColumnFrames(page, columnCount) {
  const inset = 12;
  const left = inset;
  const right = page.widthMm - inset;
  const linkGutter = columnCount >= 4 ? 11 : 13;
  const columnWidth = (right - left - linkGutter * (columnCount - 1)) / columnCount;
  return Array.from({ length: columnCount }, (_, index) => {
    const x = left + index * (columnWidth + linkGutter);
    return {
      left: round(x),
      right: round(x + columnWidth),
      gutterMm: linkGutter,
      nextDividerX: round(x + columnWidth + linkGutter / 2),
    };
  });
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
  const evidenceUpgrade = refreshSnapshotLawEvidence(graph, laws, snapshot);
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
    extraWarnings: [
      ...(snapshot.summary?.warnings || []),
      ...(evidenceUpgrade ? ["저장 이력의 조직 배치는 보존하고 직제·시행규칙의 기능 근거는 최신 파서로 다시 읽었습니다."] : []),
    ],
    asOfOverride: snapshot.asOf || null,
    institutionOverride: snapshot.institution || null,
  });
}

function refreshSnapshotLawEvidence(graph, laws, snapshot) {
  if (graph.meta?.parserVersion === PARSER_VERSION) return false;
  const usable = laws.filter((law) => law?.text && ["decree", "rule"].includes(law.role));
  if (!usable.length) return false;
  const reparsed = parseOrganizationTexts(
    usable.map((law) => law.text),
    {
      sources: usable.map((law) => law.name || (law.role === "rule" ? "직제 시행규칙" : "직제")),
      institution: snapshot.institution || graph.meta.institution,
      asOf: snapshot.asOf || graph.meta.asOf,
    },
  );
  const evidenceKeys = [
    "sourceInventory",
    "departmentDutyCatalog",
    "dutyItemCatalog",
    "dutyItemAssignments",
    "dutyFacts",
    "jurisdictionRelations",
    "jurisdictionRangeHints",
    "jurisdictionRangeCandidates",
    "jurisdictionDutyCrosswalks",
    "jurisdictionRunInferences",
  ];
  for (const key of evidenceKeys) {
    if (reparsed.meta[key] !== undefined) graph.meta[key] = structuredClone(reparsed.meta[key]);
  }
  for (const node of graph.nodes.values()) {
    const refreshed = reparsed.nodeByName(node.name);
    if (!refreshed) continue;
    for (const key of ["dutyItems", "jurisdiction"]) {
      if (refreshed.metadata?.[key] !== undefined) {
        node.metadata[key] = structuredClone(refreshed.metadata[key]);
      }
    }
  }
  graph.meta.parserVersion = PARSER_VERSION;
  graph.meta.evidenceReparsedFromSnapshot = true;
  return true;
}

function finishLawSide(graph, options = {}) {
  ensureDutyFacts(graph);
  const dutyAudit = auditLegalDutyFacts(graph);
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
  const plans = options.splitFocusRoots && focusResult.nodes.length
    ? focusRootPlans(graph, tree, focusResult.nodes, maxRows)
    : buildPagePlans(graph, tree, focused, maxRows);
  const asOf = options.asOfOverride || graph.meta.asOf || (options.asOf ? normalizeDate(options.asOf) : null);
  const institution = options.institutionOverride || graph.meta.institution;
  const warnings = uniq([
    ...(options.extraWarnings || []),
    ...focusResult.missing.map((name) => `작도 범위를 찾지 못해 제외했습니다: ${name}`),
    ...(focusNames.length && !focused.length ? [`작도 범위(${focusNames.join(", ")})를 이 시점에서 찾지 못해 전체 조직도를 그립니다.`] : []),
    ...(graph.meta.warnings || []),
    ...dutyAudit.issues.map((issue) => `법령 기능 검수: ${issue}`),
    ...(!options.splitFocusRoots && plans.length > 1 ? [`가독성을 지키기 위해 A4 ${plans.length}쪽으로 자동 분할했습니다.`] : []),
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
    dutyAudit,
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
        dutyFactCount: graph.meta?.dutyFacts?.length || 0,
        legalReadingAudit: dutyAudit,
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
      dutyFactCount: side.graph.meta?.dutyFacts?.length || 0,
      legalReadingAudit: side.dutyAudit,
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

function compactDutyLineage(lineage) {
  if (!lineage) return null;
  return {
    schema: lineage.schema,
    before: lineage.before,
    after: lineage.after,
    automaticEligible: lineage.automaticEligible,
    links: (lineage.links || []).filter((link) => (
      link.from !== link.to || link.fromParent !== link.toParent
    )),
    reviews: lineage.reviews || [],
    stats: lineage.stats || {},
  };
}

function ensureDutyFacts(graph) {
  graph.meta.dutyEvidenceQuality ||= graph.meta?.parserVersion === PARSER_VERSION
    ? "structured-law-text"
    : "legacy-synthesized";
  if (Array.isArray(graph.meta?.dutyFacts) && graph.meta.dutyFacts.length) return;
  graph.meta.dutyFacts = [];
  const sourceRoles = new Map((graph.meta.sourceInventory || []).map((item) => [item.source, item.role]));
  const seen = new Set();
  const push = (item, context) => {
    const fact = createLegalDutyFact(item, context);
    if (seen.has(fact.id)) return;
    seen.add(fact.id);
    graph.meta.dutyFacts.push(fact);
  };
  for (const entry of graph.meta.departmentDutyCatalog || []) {
    for (const item of entry.items || []) {
      const article = item.article || entry.article || null;
      const paragraph = item.paragraph ?? entry.paragraph ?? null;
      push({
        ...item,
        article,
        paragraph,
        citation: item.citation || `${article || "조문 미상"}${paragraph ? `제${paragraph}항` : ""}제${item.subparagraph || item.number}호`,
      }, {
        owner: entry.department,
        ownerKind: "department",
        source: item.source || entry.source || "",
        role: item.role || sourceRoles.get(entry.source) || "rule",
        article,
        paragraph,
      });
    }
  }
  for (const item of graph.meta.dutyItemCatalog || []) {
    const source = item.source || "";
    const citation = item.citation || `${item.refKey || "직제"}제${item.subparagraph || item.number}호`;
    push({ ...item, citation }, {
      owner: item.owner || "직제 사무분장",
      ownerKind: "decree-holder",
      source,
      role: item.role || sourceRoles.get(source) || "decree",
      article: item.article || item.refKey || null,
      paragraph: item.paragraph ?? null,
    });
  }
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

function focusRootPlans(graph, tree, focusNodes, maxRows) {
  const roots = removeNestedRoots(focusNodes.map((node) => node.id), tree.parentEdge);
  return roots.flatMap((id) => splitSubtreePlan(graph, tree, id, maxRows));
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

function layoutTreeInFrame(graph, tree, plan, frame, prefix = "", options = {}) {
  const selected = new Set(plan.nodeIds);
  const side = options.side || prefix || "single";
  const idKey = options.idPrefix || prefix;
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
  const frameHeight = Math.max(1, frame.bottom - frame.top);
  // A3 3~4단표에서는 여러 실·국을 한 대역에 합칠 수 있다. 고정 최솟값을
  // 강제하면 마지막 행이 대역과 용지 밖으로 밀려난다. 행 간격과 상자 높이를
  // 실제 대역 높이에 맞춰 함께 축소해, 좁더라도 항상 편집 가능한 용지 안에 둔다.
  const pitch = Math.min(8.35, frameHeight / Math.max(rows.length, 1));
  const boxHeight = Math.min(7.2, Math.max(1.8, pitch - Math.min(1.05, pitch * 0.22)), pitch);
  const maxDepth = Math.max(0, ...rows.map((row) => row.depth));
  const indent = Math.min(columnWidth > 120 ? 11.5 : 7.2, Math.max(5.4, (columnWidth * 0.36) / Math.max(1, maxDepth)));
  const idPrefix = idKey ? `${idKey}-` : "";
  const positions = new Map();
  const boxes = [];
  rows.forEach((row, index) => {
    const node = graph.nodes.get(row.id);
    const parentName = graph.nodes.get(tree.parentEdge.get(row.id)?.parent)?.name || "";
    const officeName = officeNameFor(row.id, graph, tree);
    const jurisdictionContainer = node.kind === "advisor"
      && (tree.children.get(row.id) || []).some((childId) => (
        selected.has(childId) && tree.parentEdge.get(childId)?.type === "jurisdiction"
      ));
    const x = round(frame.left + row.depth * indent);
    const y = round(frame.top + index * pitch);
    const style = styleForNode(node, row.depth, roots.includes(row.id), { jurisdictionContainer });
    const displayLabel = contextualNodeLabel(node, {
      isRoot: roots.includes(row.id),
      parentName,
      officeName,
    });
    const availableWidth = frame.right - x;
    const compactMaxWidth = columnWidth * 0.72;
    const labelLength = Array.from(displayLabel).length;
    const compactContentWidth = 10 + labelLength * 2.45;
    const compactMinWidth = style.root ? 54 : 46;
    // 세로 조직도(1단)처럼 프레임이 넓을 때 상자가 프레임 전체 폭으로 늘어나지
    // 않도록 상한을 둘 수 있다. 좌우 2단 대비표의 열폭(약 83mm)이 기준이다.
    const wideCap = Number.isFinite(options.maxBoxWidthMm) ? options.maxBoxWidthMm : Infinity;
    const width = round(options.compactWidth
      ? Math.min(availableWidth, Math.max(compactMinWidth, Math.min(compactMaxWidth, compactContentWidth)))
      : Math.max(columnWidth > 120 ? 42 : 28, Math.min(availableWidth, wideCap)));
    const fontSizePt = round(Math.min(style.root ? 8.4 : 7.2, Math.max(3.6, boxHeight * 1.28)));
    const objectId = `${idPrefix}node-${node.id}`;
    const geometry = { x, y, width, height: round(boxHeight) };
    positions.set(row.id, { ...geometry, objectId, centerY: round(y + boxHeight / 2), bottom: round(y + boxHeight) });
    boxes.push({
      id: objectId,
      type: "textbox",
      text: displayLabel,
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
        side,
        nodeId: node.id,
        nodeName: node.name,
        kind: node.kind,
        rank: node.rank,
        parentName,
        officeName,
        ...(displayLabel !== nodeLabel(node) ? { contextualLabel: displayLabel } : {}),
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
        { role: "child-trunk", parentId: parent.objectId, side },
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
          side,
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
  }, "", comparison ? {} : { maxBoxWidthMm: 83 });
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
      dutyFactCount: graph.meta?.dutyFacts?.length || 0,
      legalReadingAudit: context.dutyAudit,
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
  // Color follows legal rank, not tree-root status. An independent 국 is
  // still 나급, so it must not pick up the 가급 실 yellow just because it
  // is drawn as a focus root.
  if (isDepartmentNode(node)) {
    return { fill: COLORS.leafFill, stroke: COLORS.leafLine, text: COLORS.ink, dash: "solid", bold: false, root: false };
  }
  if (isOfficeNode(node)) {
    return { fill: COLORS.officeFill, stroke: COLORS.officeLine, text: COLORS.ink, dash: "solid", bold: true, root: true };
  }
  return { fill: COLORS.bureauFill, stroke: COLORS.bureauLine, text: COLORS.ink, dash: "solid", bold: true, root: false };
}

function gradeLetter(node) {
  return String(node?.metadata?.grade || "").replace(/등급$/, "");
}

function isDepartmentNode(node) {
  const rank = Number.isFinite(node.rank) ? node.rank : 99;
  return rank >= 5 || /(?:과|팀|담당관)$/.test(node.name || "");
}

function isOfficeNode(node) {
  if (!node || node.kind === "institution" || node.kind === "head" || node.kind === "deputy") return false;
  const grade = gradeLetter(node);
  if (grade === "가") return true;
  if (["나", "다", "라"].includes(grade)) return false;
  if (/(?:실|본부)$/.test(node.name || "")) return true;
  return Number.isFinite(node.rank) && node.rank <= 3;
}

function officeNameFor(nodeId, graph, tree) {
  let cursor = nodeId;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = graph.nodes.get(cursor);
    if (node && (/(?:실|본부)$/.test(node.name || "") || isOfficeNode(node))) return node.name;
    cursor = tree.parentEdge.get(cursor)?.parent;
  }
  return graph.nodes.get(nodeId)?.name || "";
}

function buildBandedComparisonManifest({
  before,
  after,
  institution,
  warnings,
  dutyAllocation,
  dutyLineage,
}) {
  const dividerX = 104;
  const notable = pickDisplayedAllocations(dutyAllocation);
  const frameTop = 40;
  const frameBottom = notable.length ? 248 : 279.5;
  const gutter = COMPARISON_GUTTER;
  const bandCount = Math.max(before.plans.length, after.plans.length, 1);
  const gap = 6.4;
  const caption = 5.4;
  const weights = Array.from({ length: bandCount }, (_, index) => Math.max(
    before.plans[index]?.nodeIds.length || 0,
    after.plans[index]?.nodeIds.length || 0,
    1,
  ));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const available = frameBottom - frameTop - gap * Math.max(0, bandCount - 1) - caption * bandCount;
  let cursor = frameTop;
  const trees = [];
  const bandMarks = [];
  weights.forEach((weight, index) => {
    const treeHeight = available * (weight / totalWeight);
    const top = cursor;
    const treeTop = top + caption;
    const treeBottom = treeTop + treeHeight;
    cursor = treeBottom + gap;
    const beforePlan = before.plans[index] || null;
    const afterPlan = after.plans[index] || null;
    const beforeTree = beforePlan
      ? layoutTreeInFrame(before.graph, before.tree, beforePlan, {
        left: 14,
        right: dividerX - gutter,
        top: treeTop,
        bottom: treeBottom,
      }, "before", { idPrefix: `before-${index + 1}` })
      : { boxes: [], lines: [] };
    const afterTree = afterPlan
      ? layoutTreeInFrame(after.graph, after.tree, afterPlan, {
        left: dividerX + gutter,
        right: 198,
        top: treeTop,
        bottom: treeBottom,
      }, "after", { idPrefix: `after-${index + 1}` })
      : { boxes: [], lines: [] };
    trees.push({ beforeTree, afterTree });
    const captionText = [beforePlan?.subtitle, afterPlan?.subtitle].filter(Boolean).join(" → ") || `개편 ${index + 1}`;
    bandMarks.push(textObject(`band-caption-${index + 1}`, 12, top, 186, 5, captionText, {
      fontSizePt: 6.4,
      bold: true,
      color: COLORS.muted,
      role: "comparison-band",
    }));
    if (index > 0) {
      bandMarks.push(lineObject(
        `band-rule-${index + 1}`,
        12,
        top - gap / 2,
        198,
        top - gap / 2,
        { role: "comparison-band-rule", color: "#D4DAE0", widthMm: 0.24 },
      ));
    }
  });

  const beforeAsOf = before.asOf ? `현행 ${displayDateLoose(before.asOf)}` : "현행";
  const afterAsOf = after.asOf ? `개정 ${displayDateLoose(after.asOf)}` : "개정";
  const pageLabel = before.plans.map((plan, index) => (
    [plan?.subtitle, after.plans[index]?.subtitle].filter(Boolean).join(" → ")
  )).filter(Boolean).join(" · ") || "두 개편 한 장";
  const labels = [
    textObject("document-title", 12, 7, 128, 7.6, `${institution} 조직 대비`, { fontSizePt: 12.2, bold: true }),
    textObject("document-asof", 142, 7, 56, 7.6, `${beforeAsOf} · ${afterAsOf}`, {
      fontSizePt: 6.4,
      bold: true,
      align: "right",
      color: COLORS.muted,
    }),
    textObject("document-subtitle", 12, 16.4, 146, 6.2, pageLabel, { fontSizePt: 6.6, bold: true, color: COLORS.muted }),
    textObject("document-page", 160, 16.4, 38, 6.2, "1 / 1", {
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
    textObject("footer-source", 12, 286.1, 150, 5.8, "위·아래 대역 · 바뀐 과 점선 · 신설·폐지는 글자", {
      fontSizePt: 5.3,
      color: COLORS.quiet,
    }),
    textObject("footer-format", 164, 286.1, 34, 5.8, "A4 세로 · 편집형", {
      fontSizePt: 5.3,
      bold: true,
      align: "right",
      color: COLORS.muted,
    }),
    ...bandMarks,
    ...allocationLabelObjects(notable),
  ];

  const objects = [
    lineObject("header-rule", 12, 25.7, 198, 25.7, { role: "header-rule", color: "#AAB3BC", widthMm: 0.3 }),
    lineObject("footer-rule", 12, 283.5, 198, 283.5, { role: "footer-rule", color: "#D4DAE0", widthMm: 0.24 }),
    lineObject("comparison-divider", dividerX, 31, dividerX, 279.5, {
      role: "comparison-divider",
      color: "#D4DAE0",
      widthMm: 0.35,
    }),
    ...trees.flatMap((tree) => tree.beforeTree.lines),
    ...trees.flatMap((tree) => tree.afterTree.lines),
    ...trees.flatMap((tree) => tree.beforeTree.boxes),
    ...trees.flatMap((tree) => tree.afterTree.boxes),
    ...correspondenceTransferObjects(
      mergeTrees(trees.map((tree) => tree.beforeTree)),
      mergeTrees(trees.map((tree) => tree.afterTree)),
      dividerX,
      { dutyLineage },
    ),
    ...lifecycleLabelObjects(
      mergeTrees(trees.map((tree) => tree.beforeTree)),
      mergeTrees(trees.map((tree) => tree.afterTree)),
      { dutyLineage },
    ),
    ...allocationTransferObjects(
      mergeTrees(trees.map((tree) => tree.beforeTree)),
      mergeTrees(trees.map((tree) => tree.afterTree)),
      notable,
      dividerX,
    ),
    ...labels,
  ];
  return {
    schema: NATIVE_LAW_SCHEMA,
    version: 1,
    title: `${institution} 조직 대비 · ${pageLabel}`,
    fileName: `${safeFilePart(institution)}-좌우조직도-두개편-편집형.hwpx`,
    source: {
      institution,
      asOf: after.asOf || before.asOf || "",
      beforeAsOf: before.asOf || "",
      afterAsOf: after.asOf || "",
      laws: uniq([...before.lawNames, ...after.lawNames]),
      fingerprints: { ...before.fingerprints, ...after.fingerprints },
      layout: NATIVE_LAW_LAYOUTS.COMPARISON_TWO_COLUMN,
      comparison: "dual-outline-bands",
      dutyAllocation,
      dutyLineage,
      dutyFactCount: (before.graph.meta?.dutyFacts?.length || 0) + (after.graph.meta?.dutyFacts?.length || 0),
      dutyFactStages: [
        { asOf: before.asOf, count: before.graph.meta?.dutyFacts?.length || 0 },
        { asOf: after.asOf, count: after.graph.meta?.dutyFacts?.length || 0 },
      ],
      legalReadingAudits: [
        { asOf: before.asOf, audit: before.dutyAudit },
        { asOf: after.asOf, audit: after.dutyAudit },
      ],
      pageLabel,
      renderView: "comparison",
      inputRoles: ["decree", "rule"].filter((role) => before.fingerprints[role] || after.fingerprints[role]),
      parserWarnings: warnings,
      note: "두 시점의 직제 개편을 위·아래 대역으로 한 장에 작도한 한글 네이티브 객체 명세",
    },
    page: PAGE,
    objects,
    verification: countObjects(objects),
  };
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
  dutyLineage,
}) {
  const dividerX = 104;
  const frameTop = 40;
  const notable = pickDisplayedAllocations(dutyAllocation);
  const frameBottom = notable.length ? 248 : 279.5;
  const gutter = COMPARISON_GUTTER;
  const beforeTree = beforePlan
    ? layoutTreeInFrame(before.graph, before.tree, beforePlan, {
      left: 14,
      right: dividerX - gutter,
      top: frameTop,
      bottom: frameBottom,
    }, "before")
    : { boxes: [], lines: [] };
  const afterTree = afterPlan
    ? layoutTreeInFrame(after.graph, after.tree, afterPlan, {
      left: dividerX + gutter,
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
      ? "원래 과와 이동된 과를 점선 상자로 감싸고 직각 선으로 연결 · 갈라진 과는 모두 표시"
      : "두 시점 조직도를 좌우로 나란히 작도 · 대응 조직을 점선으로 연결", {
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
  const transfers = [
    ...correspondenceTransferObjects(beforeTree, afterTree, dividerX, { dutyLineage }),
    ...lifecycleLabelObjects(beforeTree, afterTree, { dutyLineage }),
    ...allocationTransferObjects(beforeTree, afterTree, notable, dividerX),
  ];
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
    ...transfers,
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
      dutyLineage,
      dutyFactCount: (before.graph.meta?.dutyFacts?.length || 0) + (after.graph.meta?.dutyFacts?.length || 0),
      dutyFactStages: [
        { asOf: before.asOf, count: before.graph.meta?.dutyFacts?.length || 0 },
        { asOf: after.asOf, count: after.graph.meta?.dutyFacts?.length || 0 },
      ],
      legalReadingAudits: [
        { asOf: before.asOf, audit: before.dutyAudit },
        { asOf: after.asOf, audit: after.dutyAudit },
      ],
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

const STRUCTURAL_RENAMES = Object.freeze({
  디지털정부실: ["인공지능정부실"],
  디지털정부혁신실: ["인공지능정부실"],
  참여혁신실: ["참여혁신조직실"],
  공공서비스국: ["인공지능정부서비스국"],
  디지털정부정책국: ["인공지능정부정책국", "인공지능정부기반국"],
  공공지능데이터국: ["인공지능정부정책국"],
  정부혁신국: ["참여혁신국"],
  정보공개과: ["정보공개제도과"],
  공공지능데이터정책과: ["공공데이터정책과"],
  공공지능데이터분석과: ["공공데이터분석관리과"],
  해외문화홍보기획관: ["해외홍보정책관"],
  해외문화홍보사업과: ["국제문화사업과"],
  해외문화홍보콘텐츠과: ["해외홍보콘텐츠과"],
  외신협력과: ["해외미디어협력과"],
  외신분석팀: ["해외뉴스분석팀"],
  국제문화과: ["국제문화정책과", "국제문화사업과"],
  영상콘텐츠산업과: ["영상방송콘텐츠산업과"],
  방송영상광고과: ["미디어정책과", "영상방송콘텐츠산업과"],
  문화통상협력과: ["문화수출통상과"],
  관광산업정책과: ["관광산업진흥과"],
  관광개발과: ["지역관광개발과"],
  국내관광진흥과: ["국민관광진흥과"],
  국제관광과: ["국제관광정책과"],
  관광기반과: ["국제관광서비스과"],
  융합관광산업과: ["융복합관광과"],
});

// Some amendments reuse an old displayed name for a different predecessor.
// These cases must be resolved before the normal exact-name rule.  The
// 2026-07-28 MCST amendment explicitly renamed 문화산업정책과 to
// 콘텐츠산업정책과 and 문화산업기반과 to 문화산업정책과.  Likewise, the
// 2024-02-06 personnel order confirms 기획운영과장 -> 해외홍보기획과장.
const CONTEXTUAL_TRANSITIONS = Object.freeze([
  Object.freeze({
    sourceName: "기획운영과",
    sourceParent: "해외문화홍보원",
    requiresAfter: Object.freeze(["해외홍보기획과"]),
    destinations: Object.freeze(["해외홍보기획과"]),
  }),
  Object.freeze({
    sourceName: "문화산업정책과",
    requiresAfter: Object.freeze(["콘텐츠산업정책과", "문화산업정책과"]),
    destinations: Object.freeze(["콘텐츠산업정책과"]),
  }),
  Object.freeze({
    sourceName: "문화산업기반과",
    requiresAfter: Object.freeze(["콘텐츠산업정책과", "문화산업정책과"]),
    destinations: Object.freeze(["문화산업정책과"]),
  }),
]);

function mergeTrees(trees) {
  return {
    boxes: trees.flatMap((tree) => tree.boxes || []),
    lines: trees.flatMap((tree) => tree.lines || []),
  };
}

function correspondencePairs(beforeTree, afterTree, options = {}) {
  const afterByName = new Map();
  for (const box of afterTree.boxes || []) {
    const name = box.metadata?.nodeName;
    if (name && !afterByName.has(name)) afterByName.set(name, box);
  }
  const pairs = [];
  for (const source of beforeTree.boxes || []) {
    const name = source.metadata?.nodeName;
    if (!name || !isDepartmentBox(source)) continue;
    const destinations = correspondenceDestinations(source, afterByName, options.dutyLineage);
    for (const destination of destinations) {
      const destName = destination.name;
      const dest = afterByName.get(destName);
      if (!dest || !isDepartmentBox(dest)) continue;
      const pair = {
        source,
        dest,
        sourceName: name,
        destName,
        basis: destination.basis,
        confidence: destination.confidence,
        matchedFunctions: destination.matchedFunctions,
        sourceFunctions: destination.sourceFunctions,
        evidence: destination.evidence || [],
        reason: destination.reason || "",
      };
      if (departmentPairChanged(pair)) pairs.push(pair);
    }
  }
  return pairs;
}

function correspondenceDestinations(source, afterByName, dutyLineage) {
  const name = source?.metadata?.nodeName || source?.name || "";
  const sourceParent = source?.metadata?.parentName || "";
  const contextual = CONTEXTUAL_TRANSITIONS.find((rule) => (
    rule.sourceName === name
    && (!rule.sourceParent || rule.sourceParent === sourceParent)
    && rule.requiresAfter.every((candidate) => afterByName.has(candidate))
  ));
  if (contextual) {
    return contextual.destinations
      .filter((candidate) => afterByName.has(candidate))
      .map((candidate) => ({
        name: candidate,
        basis: "explicit-amendment-map",
        confidence: 1,
        matchedFunctions: null,
        sourceFunctions: null,
        evidence: [],
        reason: "개정문·인사발령으로 확인한 명칭 승계",
      }));
  }
  const functionLinks = (dutyLineage?.automaticEligible === false ? [] : (dutyLineage?.links || []))
    .filter((link) => link.accepted && link.from === name && afterByName.has(link.to));
  // 같은 이름의 과가 다음 시점에도 있으면 그 조직의 존속을 우선한다.
  // 이후 개편용 분할·개명 사전을 함께 적용하면, 존속한 과가 다른 과로
  // 이동한 것처럼 앞선 시점에 거짓 연결선이 생긴다.
  if (afterByName.has(name)) {
    return [{
      name,
      basis: "exact-name",
      confidence: 1,
      matchedFunctions: null,
      sourceFunctions: null,
      evidence: [],
      reason: "동일 명칭 조직 존속",
    }];
  }
  if (functionLinks.length) return functionLinks.map(lineageDestination);
  return (STRUCTURAL_RENAMES[name] || [])
    .filter((mapped) => afterByName.has(mapped))
    .map((mapped) => ({
      name: mapped,
      basis: "curated-name-map",
      confidence: 0.8,
      matchedFunctions: null,
      sourceFunctions: null,
      evidence: [],
      reason: "검증된 개편 명칭 사전",
    }));
}

function lineageDestination(link) {
  return {
    name: link.to,
    basis: link.basis || "duty-function",
    confidence: link.confidence,
    matchedFunctions: link.matchedFunctions,
    sourceFunctions: link.sourceFunctions,
    evidence: link.evidence || [],
    reason: link.reason || "각 호 분장사무 승계",
  };
}

function isDepartmentBox(box) {
  const name = box.metadata?.nodeName || "";
  const rank = Number.isFinite(box.metadata?.rank) ? box.metadata.rank : 99;
  return rank >= 5 || /(?:과|팀|담당관)$/.test(name);
}

function isOneToOneRename(from, to) {
  const dests = STRUCTURAL_RENAMES[from];
  return Array.isArray(dests) && dests.length === 1 && dests[0] === to;
}

function departmentPairChanged(pair) {
  if (pair.sourceName !== pair.destName) return true;
  const sourceParent = pair.source.metadata?.parentName || "";
  const destParent = pair.dest.metadata?.parentName || "";
  if (!sourceParent || !destParent || sourceParent === destParent) return false;
  // 국 이름만 1:1로 바뀐 블록(정부혁신국→참여혁신국)은 과 점선이 필요 없다.
  // 정책국→기반국처럼 국이 갈라진 과는 남긴다.
  if (isOneToOneRename(sourceParent, destParent)) return false;
  return true;
}

function changeLinkColor(destParent, colorMap) {
  if (!colorMap.has(destParent)) {
    colorMap.set(destParent, CHANGE_LINK_COLORS[colorMap.size % CHANGE_LINK_COLORS.length]);
  }
  return colorMap.get(destParent);
}

function departmentBoxes(tree) {
  return (tree.boxes || []).filter(isDepartmentBox);
}

function departmentLineage(beforeTree, afterTree, options = {}) {
  const beforeDepts = departmentBoxes(beforeTree);
  const afterDepts = departmentBoxes(afterTree);
  const afterByName = new Map();
  for (const box of afterDepts) {
    const name = box.metadata?.nodeName;
    if (name && !afterByName.has(name)) afterByName.set(name, box);
  }
  const linkedBefore = new Set();
  const linkedAfter = new Set();
  for (const source of beforeDepts) {
    const name = source.metadata?.nodeName;
    if (!name) continue;
    // 기능 승계 점선은 사무의 이동 근거이고, 조직 자체의 존속 근거는 아니다.
    // 따라서 기능을 넘겨준 폐지 과와 기능을 받은 신설 과의 상태 표시는 유지한다.
    const destinations = correspondenceDestinations(source, afterByName, options.dutyLineage)
      .filter((destination) => (
        destination.basis !== "duty-function"
        || (STRUCTURAL_RENAMES[name] || []).includes(destination.name)
      ));
    if (!destinations.length) continue;
    linkedBefore.add(source.id);
    for (const destination of destinations) {
      const dest = afterByName.get(destination.name);
      if (dest) linkedAfter.add(dest.id);
    }
  }
  return {
    created: afterDepts.filter((box) => !linkedAfter.has(box.id)),
    abolished: beforeDepts.filter((box) => !linkedBefore.has(box.id)),
  };
}

function lifecycleLabelObjects(beforeTree, afterTree, options = {}) {
  const idPrefix = options.idPrefix ? `${options.idPrefix}-` : "";
  const { created, abolished } = departmentLineage(beforeTree, afterTree, options);
  const objects = [];
  const push = (box, status, color) => {
    const geometry = box.geometry;
    const width = 8.2;
    objects.push(textObject(
      `${idPrefix}status-${status}-${safeFilePart(box.metadata.nodeName)}`,
      geometry.x + geometry.width - width - 0.55,
      geometry.y,
      width,
      geometry.height,
      status,
      {
        fontSizePt: 5,
        align: "right",
        color,
        role: "status-label",
        status,
        unit: box.metadata.nodeName,
        side: box.metadata.side,
      },
    ));
  };
  for (const box of created) push(box, "신설", STATUS_NEW_COLOR);
  for (const box of abolished) push(box, "폐지", STATUS_GONE_COLOR);
  return objects;
}

function coalesceStatusLabels(objects) {
  const result = [];
  const byUnit = new Map();
  for (const object of objects) {
    if (object.metadata?.role !== "status-label") {
      result.push(object);
      continue;
    }
    const key = `${object.metadata.side || ""}:${object.metadata.unit || object.id}`;
    const existing = byUnit.get(key);
    if (!existing) {
      byUnit.set(key, object);
      result.push(object);
      continue;
    }
    if (existing.metadata.status === object.metadata.status) continue;
    existing.text = "신설·폐지";
    existing.metadata.status = "신설·폐지";
    existing.style.textColor = "#7C3AED";
    existing.geometry.x = round(existing.geometry.x - 5.2);
    existing.geometry.width = round(existing.geometry.width + 5.2);
  }
  return result;
}

function correspondenceTransferObjects(beforeTree, afterTree, dividerX, options = {}) {
  const idPrefix = options.idPrefix ? `${options.idPrefix}-` : "";
  const pairs = correspondencePairs(beforeTree, afterTree, options);
  if (!pairs.length) return [];
  const groups = correspondencePairGroups(pairs).sort((left, right) => {
    const leftY = Math.min(...left.map((pair) => pair.source.geometry.y));
    const rightY = Math.min(...right.map((pair) => pair.source.geometry.y));
    return leftY - rightY;
  });
  const midXs = spreadGutterX(dividerX, groups.length, options.gutterMm);
  const objects = [];
  const colorMap = new Map();
  const wrapped = new Set();
  const wrapBox = (box, roleSide, from, color, pair) => {
    if (wrapped.has(box.id)) return;
    wrapped.add(box.id);
    objects.push(rectangleObject(
      `${idPrefix}correspondence-wrap-${roleSide}-${safeFilePart(box.metadata.nodeName)}`,
      huggingWrap(box, roleSide === "before" ? beforeTree.boxes : afterTree.boxes),
      {
        role: "correspondence-wrap",
        side: roleSide,
        unit: box.metadata.nodeName,
        from,
        to: pair?.destName,
        basis: pair?.basis,
        confidence: pair?.confidence,
        matchedFunctions: pair?.matchedFunctions,
        sourceFunctions: pair?.sourceFunctions,
        color,
        widthMm: 0.38,
        dashArray: CHANGE_WRAP_DASH,
      },
    ));
  };
  const pushSegment = (id, x1, y1, x2, y2, color, pair) => {
    objects.push(lineObject(`${idPrefix}${id}-under`, x1, y1, x2, y2, {
      role: "correspondence-underlay",
      color: "#FFFFFF",
      widthMm: 0.74,
      dash: "solid",
    }));
    objects.push(lineObject(`${idPrefix}${id}`, x1, y1, x2, y2, {
      role: "correspondence-link",
      from: pair?.sourceName,
      to: pair?.destName,
      basis: pair?.basis,
      confidence: pair?.confidence,
      matchedFunctions: pair?.matchedFunctions,
      sourceFunctions: pair?.sourceFunctions,
      evidence: pair?.evidence,
      reason: pair?.reason,
      color,
      widthMm: 0.44,
      dash: "dash",
      dashArray: CHANGE_LINK_DASH,
    }));
  };

  groups.forEach((group, groupIndex) => {
    const colorKey = uniq(group.map((pair) => pair.dest.metadata?.parentName || pair.destName)).join("|");
    const color = changeLinkColor(colorKey, colorMap);
    const midX = midXs[groupIndex];
    const joints = [];
    group.forEach((pair, pairIndex) => {
      wrapBox(pair.source, "before", undefined, color, pair);
      wrapBox(pair.dest, "after", pair.sourceName, color, pair);
      const sourceWrap = huggingWrap(pair.source, beforeTree.boxes);
      const destWrap = huggingWrap(pair.dest, afterTree.boxes);
      const start = { x: sourceWrap.x + sourceWrap.width, y: sourceWrap.y + sourceWrap.height / 2 };
      const end = { x: destWrap.x, y: destWrap.y + destWrap.height / 2 };
      joints.push(start.y, end.y);
      pushSegment(`correspondence-link-${groupIndex + 1}-${pairIndex + 1}-h1`, start.x, start.y, midX, start.y, color, pair);
      pushSegment(`correspondence-link-${groupIndex + 1}-${pairIndex + 1}-h2`, midX, end.y, end.x, end.y, color, pair);
    });
    const yMin = Math.min(...joints);
    const yMax = Math.max(...joints);
    if (yMax - yMin > 0.05) {
      const groupPair = group.length === 1 ? group[0] : null;
      pushSegment(`correspondence-link-${groupIndex + 1}-spine`, midX, yMin, midX, yMax, color, groupPair);
    }
  });
  return objects;
}

function correspondencePairGroups(pairs) {
  const parent = pairs.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  const unite = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let index = 0; index < pairs.length; index += 1) {
    for (let next = index + 1; next < pairs.length; next += 1) {
      if (
        pairs[index].sourceName === pairs[next].sourceName
        || pairs[index].destName === pairs[next].destName
      ) {
        unite(index, next);
      }
    }
  }
  const groups = new Map();
  pairs.forEach((pair, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(pair);
  });
  return [...groups.values()];
}

function spreadGutterX(dividerX, count, gutterMm = COMPARISON_GUTTER) {
  const half = gutterMm < 16
    ? Math.max(1.2, gutterMm / 2 - 1.8)
    : Math.min(10, COMPARISON_GUTTER - 6);
  if (count <= 1) return [dividerX];
  return Array.from({ length: count }, (_, index) => (
    round(dividerX - half + ((2 * half) * index) / (count - 1))
  ));
}

function pickDisplayedAllocations(dutyAllocation) {
  const department = notableAllocations(dutyAllocation?.units || []);
  if (department.length) return department.slice(0, 4);
  return notableAllocations(dutyAllocation?.parentUnits || []).slice(0, 4);
}

function allocationTransferObjects(beforeTree, afterTree, units, dividerX) {
  const objects = [];
  const beforeBoxes = beforeTree.boxes || [];
  const afterBoxes = afterTree.boxes || [];
  units.forEach((unit, unitIndex) => {
    const sourceBox = boxByNodeName(beforeTree, unit.unit);
    if (!sourceBox) return;
    const sourceWrap = huggingWrap(sourceBox, beforeBoxes);
    objects.push(rectangleObject(
      `allocation-wrap-before-${safeFilePart(unit.unit)}`,
      sourceWrap,
      { role: "allocation-wrap", side: "before", unit: unit.unit },
    ));
    const destinations = unit.shares
      .map((share, shareIndex) => ({ share, shareIndex, box: boxByNodeName(afterTree, share.unit) }))
      .filter((item) => item.box);
    if (!destinations.length) return;
    destinations.forEach(({ share, shareIndex, box }) => {
      const destWrap = huggingWrap(box, afterBoxes);
      objects.push(rectangleObject(
        `allocation-wrap-after-${safeFilePart(unit.unit)}-${shareIndex + 1}`,
        destWrap,
        { role: "allocation-wrap", side: "after", unit: share.unit, from: unit.unit },
      ));
      const start = { x: sourceWrap.x + sourceWrap.width, y: sourceWrap.y + sourceWrap.height / 2 };
      const end = { x: destWrap.x, y: destWrap.y + destWrap.height / 2 };
      const midX = gutterX(dividerX, shareIndex, destinations.length);
      objects.push(lineObject(
        `allocation-link-${unitIndex + 1}-${shareIndex + 1}-h1`,
        start.x,
        start.y,
        midX,
        start.y,
        { role: "allocation-link", color: COLORS.transfer, widthMm: 0.32, dash: "dash" },
      ));
      if (Math.abs(start.y - end.y) > 0.05) {
        objects.push(lineObject(
          `allocation-link-${unitIndex + 1}-${shareIndex + 1}-v`,
          midX,
          start.y,
          midX,
          end.y,
          { role: "allocation-link", color: COLORS.transfer, widthMm: 0.32, dash: "dash" },
        ));
      }
      objects.push(lineObject(
        `allocation-link-${unitIndex + 1}-${shareIndex + 1}-h2`,
        midX,
        end.y,
        end.x,
        end.y,
        { role: "allocation-link", color: COLORS.transfer, widthMm: 0.32, dash: "dash" },
      ));
      const labelWidth = 9.2;
      const labelX = round(Math.min(end.x - labelWidth - 0.4, midX + 0.6));
      objects.push(textObject(
        `allocation-link-label-${unitIndex + 1}-${shareIndex + 1}`,
        labelX,
        end.y - 3.2,
        labelWidth,
        4.2,
        `${share.percent}%`,
        {
          fontSizePt: 5.4,
          bold: true,
          align: "right",
          color: COLORS.transfer,
          role: "allocation-link-label",
        },
      ));
    });
  });
  return objects;
}

function boxByNodeName(tree, name) {
  return (tree.boxes || []).find((box) => box.metadata?.nodeName === name) || null;
}

function huggingWrap(box, siblings) {
  const padX = 0.7;
  const padY = 0.42;
  const geometry = box.geometry;
  let top = geometry.y - padY;
  let bottom = geometry.y + geometry.height + padY;
  const left = geometry.x - padX;
  const right = geometry.x + geometry.width + padX;
  for (const sibling of siblings) {
    if (sibling.id === box.id) continue;
    const other = sibling.geometry;
    if (other.x + other.width < left - 1 || other.x > right + 1) continue;
    if (other.y + other.height <= geometry.y + 0.15) {
      top = Math.max(top, (other.y + other.height + geometry.y) / 2);
    }
    if (other.y >= geometry.y + geometry.height - 0.15) {
      bottom = Math.min(bottom, (geometry.y + geometry.height + other.y) / 2);
    }
  }
  return {
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(Math.max(geometry.height + 0.4, bottom - top)),
  };
}

function gutterX(dividerX, shareIndex, shareCount) {
  const spread = Math.min(3.2, 6 / Math.max(shareCount, 1));
  return round(dividerX + (shareIndex - (shareCount - 1) / 2) * spread);
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

function rectangleObject(id, geometry, options = {}) {
  return {
    id,
    type: "rectangle",
    geometry: {
      x: round(geometry.x),
      y: round(geometry.y),
      width: round(geometry.width),
      height: round(geometry.height),
    },
    style: {
      fill: "none",
      stroke: options.color || COLORS.transfer,
      strokeWidthMm: options.widthMm || 0.34,
      dash: options.dash || "dash",
      ...(options.dashArray ? { dashArray: options.dashArray } : {}),
    },
    metadata: Object.fromEntries(
      [
        "role",
        "side",
        "unit",
        "from",
        "to",
        "basis",
        "confidence",
        "matchedFunctions",
        "sourceFunctions",
      ].map((key) => [key, options[key]]).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    ),
  };
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
      ...(options.dashArray ? { dashArray: options.dashArray } : {}),
    },
    metadata: Object.fromEntries(
      [
        "role",
        "parentId",
        "childId",
        "side",
        "from",
        "to",
        "basis",
        "confidence",
        "matchedFunctions",
        "sourceFunctions",
        "evidence",
        "reason",
      ].map((key) => [key, options[key]]).filter(([, value]) => value !== undefined && value !== null && value !== ""),
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
    metadata: Object.fromEntries(
      [
        ["role", options.role || "document-label"],
        ["status", options.status],
        ["unit", options.unit],
        ["side", options.side],
      ].filter(([, value]) => value),
    ),
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
  return (left.rank ?? 99) - (right.rank ?? 99)
    || (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0)
    || left.name.localeCompare(right.name, "ko");
}

function nodeLabel(node) {
  const markers = [];
  if (node.metadata?.grade) markers.push(node.metadata.grade);
  if (node.metadata?.temporary || node.kind === "temporary") markers.push("한시");
  const prefix = markers.length ? `(${markers.join("·")})  ` : "";
  return `${prefix}${node.name}`;
}

function contextualNodeLabel(node, options = {}) {
  const base = nodeLabel(node);
  if (!options.isRoot) return base;
  if (isDepartmentNode(node) && options.officeName && options.officeName !== node.name) {
    return `${options.officeName} › ${base}`;
  }
  if (node.kind !== "advisor") return base;
  if (options.officeName && options.officeName !== node.name) {
    return `${options.officeName} › ${base}`;
  }
  if (options.parentName === "장관") return `장관 보좌 › ${base}`;
  return base;
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
