import fs from "node:fs/promises";
import path from "node:path";
import { applyAnnexOrganizations, attachAnnexes } from "./annex.mjs";
import { buildAuditReport } from "./audit.mjs";
import { fetchLawAtDate } from "./law-api.mjs";
import { organizationLawNameCandidateGroups } from "./law-name.mjs";
import { buildLawAppendixPages, enrichGraphWithLawMap } from "./law-map.mjs";
import { planBestPages, planLayoutVariants, planPages } from "./layout.mjs";
import { projectOperationalView } from "./model.mjs";
import { parseOrganizationTexts } from "./parser.mjs";
import { compactDate, jsonReplacer, writeText } from "./utils.mjs";

const STATUS_LABELS = {
  ready: "사용 가능",
  "needs-review": "검토 필요",
  "needs-correction": "수정 필요",
  error: "오류",
};

export async function runBatchAudit(args = {}) {
  const context = await loadBatchContext(args);
  const cases = [];
  const lawMapCache = new Map();
  for (let index = 0; index < context.caseSpecs.length; index += 1) {
    const caseSpec = normalizeCaseSpec(context.caseSpecs[index], index);
    try {
      const graph = await graphFromCase(caseSpec, context);
      await enrichCaseWithLawMap(graph, caseSpec, context, lawMapCache);
      const view = caseSpec.view || context.view || "legal";
      if (!new Set(["legal", "operational"]).has(view)) {
        throw new Error(`view는 legal 또는 operational이어야 합니다: ${view}`);
      }
      const displayGraph = view === "operational" ? projectOperationalView(graph) : graph;
      const pages = planCasePages(displayGraph, caseSpec, context);
      const report = buildAuditReport(displayGraph, pages);
      const summary = summarizeAuditCase({ caseSpec, report, view, pages });
      cases.push({ case: publicCaseSpec(caseSpec), summary, report });
    } catch (error) {
      const summary = summarizeCaseError(caseSpec, error);
      cases.push({ case: publicCaseSpec(caseSpec), summary, error: error.message });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    total: cases.length,
    statusCounts: countStatuses(cases),
    cases,
  };
}

export function summarizeAuditCase({ caseSpec = {}, report, view = "legal", pages = [] }) {
  const reviewCounts = countBy(report.reviewActions || [], (item) => item.priority || "low");
  const layout = countLayoutDiagnostics(report.layoutDiagnostics || []);
  const layoutSelection = summarizeLayoutSelection(caseSpec, pages);
  const jurisdictionRunInferences = report.jurisdictionRunInferences || [];
  const jurisdictionCandidates = report.jurisdictionCandidates || [];
  const jurisdictionCrosswalks = report.jurisdictionCrosswalks || {};
  const annexRequirements = report.annexRequirements || [];
  const lawMap = report.lawMap || null;
  return {
    id: caseSpec.id || report.meta.institution,
    institution: report.meta.institution,
    title: report.meta.title,
    asOf: report.meta.asOf || caseSpec.date || null,
    view,
    paper: caseSpec.paper || null,
    layout: caseSpec.layouts || caseSpec.layout || null,
    layoutSelection,
    focus: caseSpec.focus || null,
    status: report.meta.status,
    statusLabel: STATUS_LABELS[report.meta.status] || report.meta.status,
    nodes: report.summary.nodes,
    edges: report.summary.edges,
    pages: pages.length || report.layoutDiagnostics?.length || 0,
    reviewActions: {
      high: reviewCounts.high || 0,
      medium: reviewCounts.medium || 0,
      low: reviewCounts.low || 0,
      total: (report.reviewActions || []).length,
    },
    validationIssues: report.validation?.length || 0,
    warnings: report.warnings?.length || 0,
    annex: {
      requirements: annexRequirements.length,
      missing: annexRequirements.filter((item) => !item.matchedAnnex).length,
      appliedOrganizations: report.annexOrganizations?.length || 0,
    },
    jurisdiction: {
      relations: report.jurisdictionRelations?.length || 0,
      candidateGroups: jurisdictionCandidates.length,
      candidateDepartments: sum(jurisdictionCandidates, (item) => item.departments?.length || 0),
      rangeConfirmed: jurisdictionCrosswalks.confirmed?.length || 0,
      rangeUnresolved: jurisdictionCrosswalks.unresolved?.length || 0,
      orderedRunGroups: jurisdictionRunInferences.length,
      orderedRunDepartments: sum(jurisdictionRunInferences, (item) => item.departments?.length || 0),
    },
    lawMap: lawMap
      ? {
          matchedInstitution: lawMap.matchedInstitution || null,
          matchedDepartments: lawMap.matchedDepartments || 0,
          lawCount: lawMap.lawCount || 0,
          unmatchedDepartments: lawMap.unmatchedDepartments?.length || 0,
          ambiguousDepartments: lawMap.ambiguousDepartments?.length || 0,
          excludedScopedNodes: lawMap.excludedScopedNodes || 0,
        }
      : null,
    layoutDiagnostics: layout,
    layoutRecommendations: report.layoutRecommendations?.length || 0,
  };
}

export function formatBatchAuditMarkdown(result) {
  const lines = [];
  lines.push("# 조직도 batch audit");
  lines.push(`- 실행시각: ${result.generatedAt}`);
  lines.push(`- 케이스: ${result.total}`);
  lines.push(
    `- 상태: 사용 가능 ${result.statusCounts.ready || 0} · 검토 필요 ${result.statusCounts["needs-review"] || 0} · 수정 필요 ${result.statusCounts["needs-correction"] || 0} · 오류 ${result.statusCounts.error || 0}`,
  );
  lines.push("");
  lines.push(
    "| 기관 | 기준일 | 보기 | 대상 | 선택유형 | 상태 | 노드 | 페이지 | 높은 확인 | 중간 확인 | 낮은 확인 | 소관관계 | 소관 후보 | 배치 문제 | 품질 | 별표 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const item of result.cases) {
    const summary = item.summary;
    lines.push(
      [
        escapeCell(summary.institution || summary.id),
        escapeCell(summary.asOf || ""),
        escapeCell(summary.view || ""),
        escapeCell(summary.focus || summary.layout || ""),
        escapeCell(formatSelectedLayouts(summary.layoutSelection)),
        escapeCell(summary.statusLabel || summary.status),
        summary.nodes ?? "",
        summary.pages ?? "",
        summary.reviewActions?.high ?? "",
        summary.reviewActions?.medium ?? "",
        summary.reviewActions?.low ?? "",
        summary.jurisdiction?.relations ?? "",
        summary.jurisdiction?.candidateDepartments ?? "",
        summary.layoutDiagnostics?.totalIssues ?? "",
        summary.layoutDiagnostics?.qualityIssues ?? "",
        `${summary.annex?.missing ?? ""}/${summary.annex?.requirements ?? ""}`,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push("");

  for (const item of result.cases) {
    const summary = item.summary;
    const report = item.report;
    const needsDetail =
      summary.status === "error" ||
      summary.reviewActions?.total ||
      summary.reviewActions?.high ||
      summary.reviewActions?.medium ||
      summary.validationIssues ||
      summary.annex?.missing ||
      summary.jurisdiction?.candidateDepartments ||
      summary.jurisdiction?.rangeUnresolved ||
      summary.layoutDiagnostics?.totalIssues ||
      summary.layoutDiagnostics?.qualityIssues;
    if (!needsDetail) continue;
    lines.push(`## ${summary.institution || summary.id}`);
    lines.push(`- 상태: ${summary.statusLabel || summary.status}`);
    if (summary.asOf) lines.push(`- 기준일: ${summary.asOf}`);
    if (summary.focus) lines.push(`- 대상: ${summary.focus}`);
    if (summary.layout || summary.paper) {
      lines.push(`- 작도: ${[summary.paper, summary.layout].filter(Boolean).join(" / ")}`);
    }
    if (summary.layoutSelection?.selected?.length) {
      lines.push(`- 선택 유형: ${formatSelectedLayouts(summary.layoutSelection)}`);
    }
    if (summary.layoutSelection?.bestFit?.candidateScores?.length) {
      lines.push("- best-fit 후보 점수:");
      for (const candidate of summary.layoutSelection.bestFit.candidateScores.slice(0, 4)) {
        const d = candidate.diagnostics || {};
        const maxNodes = candidate.maxNodes ? `, maxNodes ${candidate.maxNodes}` : "";
        lines.push(`  - ${candidate.style}${maxNodes}: 점수 ${candidate.score}, 문제 ${d.totalIssues || 0}, 품질 ${d.qualityIssues || 0}, 페이지 ${d.pages || 0}`);
      }
    }
    if (item.error) {
      lines.push(`- 오류: ${item.error}`);
      lines.push("");
      continue;
    }
    const actions = report.reviewActions || [];
    if (actions.length) {
      lines.push("- 우선 확인:");
      for (const action of actions.slice(0, 8)) {
        lines.push(`  - [${priorityLabel(action.priority)}] ${action.message}`);
      }
      if (actions.length > 8) lines.push(`  - 외 ${actions.length - 8}건`);
    }
    if (summary.layoutDiagnostics?.totalIssues) {
      const diag = summary.layoutDiagnostics;
      lines.push(
        `- 배치 문제: 넘침 ${diag.overflow} · 겹침 ${diag.overlaps} · 연결선 ${diag.edgeIssues}`,
      );
    }
    if (summary.layoutDiagnostics?.qualityIssues) {
      const diag = summary.layoutDiagnostics;
      lines.push(`- 작도 품질: 간격 ${diag.spacingIssues || 0} · 정렬 ${diag.alignmentIssues || 0} · 선교차 ${diag.crossingIssues || 0} · 선-상자 관통 ${diag.occlusionIssues || 0} · 균형 ${diag.balanceIssues || 0} · 가독성 ${diag.readabilityIssues || 0}`);
    }
    if (report.layoutRecommendations?.length) {
      lines.push("- 작도 개선:");
      for (const recommendation of report.layoutRecommendations.slice(0, 4)) {
        lines.push(`  - ${recommendation.message}`);
      }
      if (report.layoutRecommendations.length > 4) {
        lines.push(`  - 외 ${report.layoutRecommendations.length - 4}건`);
      }
    }
    if (summary.jurisdiction?.orderedRunDepartments) {
      lines.push(`- 순서 기반 소관 보강: ${summary.jurisdiction.orderedRunDepartments}개 과·팀`);
    }
    if (summary.lawMap) {
      lines.push(
        `- 소관법령 지도: 매칭 부서 ${summary.lawMap.matchedDepartments}, 미매칭 ${summary.lawMap.unmatchedDepartments}, 중복 후보 ${summary.lawMap.ambiguousDepartments}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function summarizeLayoutSelection(caseSpec = {}, pages = []) {
  const selected = unique(pages.map((page) => page.layoutStyle).filter(Boolean));
  const selectedBy = unique(pages.map((page) => page.selectedBy).filter(Boolean));
  const bestFit = pages.find((page) => page.bestFit)?.bestFit || null;
  return {
    requested: caseSpec.layouts || caseSpec.layout || null,
    selected,
    selectedBy,
    pageStyles: pages.map((page) => ({
      pageNumber: page.pageNumber,
      pageCount: page.pageCount,
      subtitle: page.subtitle,
      layoutStyle: page.layoutStyle,
      selectedBy: page.selectedBy || null,
    })),
    ...(bestFit
      ? {
          bestFit: {
            selectedLayoutStyle: bestFit.selectedLayoutStyle,
            selectedMaxNodes: bestFit.selectedMaxNodes,
            candidateScores: bestFit.candidateScores,
          },
        }
      : {}),
  };
}

export async function loadBatchContext(args) {
  const caseSpecs = args.caseSpecs || (await readCasesFile(requiredString(args, "cases")));
  return {
    caseSpecs,
    casesPath: args.cases ? path.resolve(String(args.cases)) : null,
    casesBaseDir: args.casesBaseDir
      ? path.resolve(String(args.casesBaseDir))
      : args.cases
        ? path.dirname(path.resolve(String(args.cases)))
        : process.cwd(),
    date: stringArg(args, "date"),
    view: stringArg(args, "view"),
    paper: stringArg(args, "paper"),
    layout: stringArg(args, "layout"),
    layouts: stringArg(args, "layouts"),
    focus: stringArg(args, "focus"),
    maxNodes: numberArg(args, "max-nodes"),
    oc: stringArg(args, "oc"),
    sourceDir: stringArg(args, "source-dir"),
    lawMap: stringArg(args, "law-map"),
    lawMapDate: stringArg(args, "law-map-date"),
    lawAppendix: args["law-appendix"] === true,
    lawCounts: args["law-counts"] === true,
    routedPptx: args["routed-pptx"] === true || args["pptx-route"] === true,
    lawFetchCache: args.lawFetchCache || new Map(),
    fetchLawAtDate: args.fetchLawAtDate || fetchLawAtDate,
  };
}

async function readCasesFile(filePath) {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(cases)) throw new Error("--cases JSON은 배열 또는 { cases: [...] } 형식이어야 합니다.");
  return cases;
}

export function normalizeCaseSpec(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`케이스 ${index + 1}은 객체여야 합니다.`);
  }
  return {
    ...raw,
    id: raw.id || raw.institution || raw.title || `case-${index + 1}`,
  };
}

export function publicCaseSpec(spec) {
  const {
    text,
    texts,
    annexes,
    ...rest
  } = spec;
  return {
    ...rest,
    text: text ? "[inline text]" : undefined,
    texts: texts ? `[inline texts: ${Array.isArray(texts) ? texts.length : 1}]` : undefined,
    annexes: annexes ? `[inline annexes: ${Array.isArray(annexes) ? annexes.length : 1}]` : undefined,
  };
}

export async function graphFromCase(caseSpec, context) {
  const date = caseSpec.date || context.date;
  if (caseSpec.text || caseSpec.texts || caseSpec.input || caseSpec.inputs) {
    const texts = await localTextsFromCase(caseSpec, context.casesBaseDir);
    const graph = parseOrganizationTexts(texts, {
      institution: caseSpec.institution,
      title: caseSpec.title || caseSpec.institution,
      asOf: date,
      headName: caseSpec.head || caseSpec.headName,
      deputyName: caseSpec.deputy || caseSpec.deputyName,
      sources: localSourceNames(caseSpec),
    });
    await applyCaseAnnexes(graph, caseSpec, context);
    return graph;
  }

  if (!date) throw new Error(`${caseSpec.id}: date가 필요합니다.`);
  const lawNames = lawNamesFromCase(caseSpec);
  const fetched = lawNames.length
    ? await fetchExplicitLaws(lawNames, date, caseSpec, context)
    : await fetchInferredOrganizationLaws(caseSpec, date, context);
  await writeFetchedSourcesIfRequested(fetched, caseSpec, context);
  const directiveText = directiveTextFromCase(caseSpec);
  const graph = parseOrganizationTexts(
    [...fetched.map((item) => item.text), directiveText].filter(Boolean),
    {
      institution: caseSpec.institution,
      title: caseSpec.title || caseSpec.institution,
      asOf: date,
      headName: caseSpec.head || caseSpec.headName,
      deputyName: caseSpec.deputy || caseSpec.deputyName,
      sources: fetched.map((item) => `${item.lawName} [시행 ${item.effectiveDate}]`),
    },
  );
  graph.meta.laws = fetched.map((item) => ({
    name: item.lawName,
    requestedDate: item.requestedDate,
    effectiveDate: item.effectiveDate,
    mst: item.mst,
    sourceUrl: item.sourceUrl,
    annexCount: item.annexes?.length || 0,
  }));
  attachAnnexes(graph, fetched.flatMap((item) => item.annexes || []));
  await applyCaseAnnexes(graph, caseSpec, context);
  return graph;
}

async function fetchExplicitLaws(lawNames, date, caseSpec, context) {
  const fetched = [];
  for (const lawName of lawNames) {
    fetched.push(await fetchLawCached(lawName, date, caseSpec, context));
  }
  return fetched;
}

async function fetchInferredOrganizationLaws(caseSpec, date, context) {
  if (!caseSpec.institution) {
    throw new Error(`${caseSpec.id}: inputs/texts, decree/rule/law/laws 또는 institution 중 하나가 필요합니다.`);
  }
  const fetched = [];
  for (const group of organizationLawNameCandidateGroups(caseSpec.institution)) {
    fetched.push(await fetchFirstLawCandidate(group, date, caseSpec, context));
  }
  return fetched;
}

async function fetchFirstLawCandidate(group, date, caseSpec, context) {
  const errors = [];
  for (const lawName of group.candidates) {
    try {
      return await fetchLawCached(lawName, date, caseSpec, context);
    } catch (error) {
      errors.push(`${lawName}: ${error.message}`);
    }
  }
  throw new Error(`${caseSpec.id}: ${group.label} 후보를 찾지 못했습니다. 시도한 제명: ${errors.join(" / ")}`);
}

async function fetchLawCached(lawName, date, caseSpec, context) {
  const oc = caseSpec.oc || context.oc || process.env.LAW_API_OC || "test";
  const key = `${lawName}\u0000${date}\u0000${oc}`;
  if (!context.lawFetchCache.has(key)) {
    context.lawFetchCache.set(key, readOrFetchLaw(lawName, date, caseSpec, context, oc));
  }
  return context.lawFetchCache.get(key);
}

async function readOrFetchLaw(lawName, date, caseSpec, context, oc) {
  const cached = await readFetchedSourceCache(lawName, date, caseSpec, context);
  if (cached) return cached;
  const fetched = await context.fetchLawAtDate(lawName, date, { oc });
  await writeFetchedSourceCache(fetched, lawName, date, caseSpec, context);
  return fetched;
}

async function readFetchedSourceCache(lawName, date, caseSpec, context) {
  const filePath = fetchedSourceCachePath(lawName, date, caseSpec, context);
  if (!filePath) return null;
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (parsed.lawName !== lawName || parsed.requestedDate !== compactDate(date) || typeof parsed.text !== "string") {
    return null;
  }
  return {
    lawName: parsed.lawName,
    requestedDate: parsed.requestedDate,
    effectiveDate: parsed.effectiveDate,
    mst: parsed.mst,
    metadata: parsed.metadata || {},
    json: parsed.json || null,
    annexes: parsed.annexes || [],
    text: parsed.text,
    sourceUrl: parsed.sourceUrl || "",
    cached: true,
  };
}

async function writeFetchedSourceCache(item, lawName, date, caseSpec, context) {
  const filePath = fetchedSourceCachePath(lawName, date, caseSpec, context);
  if (!filePath) return;
  await writeText(
    filePath,
    `${JSON.stringify({
      lawName: item.lawName || lawName,
      requestedDate: item.requestedDate || compactDate(date),
      effectiveDate: item.effectiveDate,
      mst: item.mst,
      metadata: item.metadata || {},
      json: item.json || null,
      annexes: item.annexes || [],
      text: item.text,
      sourceUrl: item.sourceUrl || "",
    }, jsonReplacer, 2)}\n`,
  );
}

function fetchedSourceCachePath(lawName, date, caseSpec, context) {
  const dir = fetchedSourceDir(caseSpec, context);
  if (!dir) return null;
  return path.join(dir, ".law-cache", `${safeFilePart(lawName)}-${compactDate(date)}.json`);
}

function fetchedSourceDir(caseSpec, context) {
  if (caseSpec.sourceDir) return resolveCasePath(caseSpec.sourceDir, context.casesBaseDir);
  if (context.sourceDir) return path.resolve(context.sourceDir);
  return null;
}

async function localTextsFromCase(caseSpec, baseDir) {
  const texts = [];
  if (caseSpec.text) texts.push(String(caseSpec.text));
  if (caseSpec.texts) {
    for (const text of asArray(caseSpec.texts)) texts.push(String(text));
  }
  for (const inputPath of asArray(caseSpec.inputs || caseSpec.input)) {
    texts.push(await fs.readFile(resolveCasePath(inputPath, baseDir), "utf8"));
  }
  const directives = directiveTextFromCase(caseSpec);
  if (directives) texts.push(directives);
  return texts;
}

function localSourceNames(caseSpec) {
  const names = [];
  if (caseSpec.text) names.push(`${caseSpec.id}: inline text`);
  for (const _text of asArray(caseSpec.texts)) names.push(`${caseSpec.id}: inline texts`);
  for (const inputPath of asArray(caseSpec.inputs || caseSpec.input)) names.push(String(inputPath));
  if (directiveTextFromCase(caseSpec)) names.push(`${caseSpec.id}: directives`);
  return names;
}

function directiveTextFromCase(caseSpec) {
  const chunks = [];
  for (const directive of asArray(caseSpec.directives)) chunks.push(String(directive));
  if (caseSpec.directiveText) chunks.push(String(caseSpec.directiveText));
  return chunks.map((item) => item.trim()).filter(Boolean).join("\n");
}

function lawNamesFromCase(caseSpec) {
  return [
    caseSpec.decree,
    caseSpec.rule,
    ...asArray(caseSpec.law),
    ...asArray(caseSpec.laws),
  ].filter((value) => typeof value === "string" && value.trim());
}

async function applyCaseAnnexes(graph, caseSpec, context) {
  const annexes = [];
  for (const annex of asArray(caseSpec.annexes)) annexes.push(annex);
  for (const annexPath of asArray(caseSpec.annexFiles || caseSpec.annexFile)) {
    const parsed = JSON.parse(await fs.readFile(resolveCasePath(annexPath, context.casesBaseDir), "utf8"));
    annexes.push(...asArray(parsed));
  }
  if (annexes.length) attachAnnexes(graph, annexes);
  applyAnnexOrganizations(graph);
  graph.validateLegalStructure();
}

async function writeFetchedSourcesIfRequested(fetched, caseSpec, context) {
  const dir = fetchedSourceDir(caseSpec, context);
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  const prefix = safeFilePart(caseSpec.id || caseSpec.institution || "case");
  for (const item of fetched) {
    const safeName = safeFilePart(item.lawName);
    await writeText(path.join(dir, `${prefix}-${safeName}-${item.effectiveDate}.txt`), item.text);
    if (item.annexes?.length) {
      await writeText(
        path.join(dir, `${prefix}-${safeName}-${item.effectiveDate}.annexes.json`),
        `${JSON.stringify(item.annexes, jsonReplacer, 2)}\n`,
      );
    }
  }
}

export async function enrichCaseWithLawMap(graph, caseSpec, context, cache) {
  const lawMapPath = caseSpec.lawMap || context.lawMap;
  if (!lawMapPath) return;
  const resolved = caseSpec.lawMap
    ? resolveCasePath(lawMapPath, context.casesBaseDir)
    : path.resolve(lawMapPath);
  if (!cache.has(resolved)) {
    const raw = await fs.readFile(resolved, "utf8");
    cache.set(resolved, JSON.parse(raw.replace(/^\uFEFF/, "")));
  }
  enrichGraphWithLawMap(graph, cache.get(resolved), {
    asOf: caseSpec.lawMapDate || context.lawMapDate,
    source: path.basename(resolved),
  });
}

export function planCasePages(graph, caseSpec, context) {
  const layout = caseSpec.layout || context.layout || "auto";
  if (layout === "best") {
    return planBestPages(graph, {
      maxNodes: numberValue(caseSpec.maxNodes, context.maxNodes, 38),
      paper: caseSpec.paper || context.paper || "slide",
      focus: caseSpec.focus || context.focus,
    });
  }
  const layouts = caseSpec.layouts || context.layouts || (layout === "all" ? "all" : undefined);
  const options = {
    mode: layout === "all" ? "auto" : layout,
    maxNodes: numberValue(caseSpec.maxNodes, context.maxNodes, 38),
    paper: caseSpec.paper || context.paper || "slide",
    focus: caseSpec.focus || context.focus,
  };
  let pages = layouts ? planLayoutVariants(graph, { ...options, layouts }) : planPages(graph, options);
  if (caseSpec.lawAppendix === true || context.lawAppendix === true) {
    if (graph.meta.lawMap) pages = renumberPages([...pages, ...buildLawAppendixPages(graph)]);
  }
  return pages;
}

function summarizeCaseError(caseSpec, error) {
  return {
    id: caseSpec.id,
    institution: caseSpec.institution || caseSpec.id,
    title: caseSpec.title || caseSpec.institution || caseSpec.id,
    asOf: caseSpec.date || null,
    view: caseSpec.view || null,
    paper: caseSpec.paper || null,
    layout: caseSpec.layouts || caseSpec.layout || null,
    focus: caseSpec.focus || null,
    status: "error",
    statusLabel: STATUS_LABELS.error,
    nodes: 0,
    edges: 0,
    pages: 0,
    reviewActions: { high: 1, medium: 0, low: 0, total: 1 },
    validationIssues: 0,
    warnings: 0,
    annex: { requirements: 0, missing: 0, appliedOrganizations: 0 },
    jurisdiction: {
      relations: 0,
      candidateGroups: 0,
      candidateDepartments: 0,
      rangeConfirmed: 0,
      rangeUnresolved: 0,
      orderedRunGroups: 0,
      orderedRunDepartments: 0,
    },
    lawMap: null,
    layoutDiagnostics: {
      pages: 0,
      overflow: 0,
      overlaps: 0,
      edgeIssues: 0,
      spacingIssues: 0,
      alignmentIssues: 0,
      crossingIssues: 0,
      occlusionIssues: 0,
      balanceIssues: 0,
      readabilityIssues: 0,
      qualityIssues: 0,
      totalIssues: 0,
    },
    error: error.message,
  };
}

function countLayoutDiagnostics(layoutDiagnostics) {
  const totals = {
    pages: layoutDiagnostics.length,
    overflow: 0,
    overlaps: 0,
    edgeIssues: 0,
    spacingIssues: 0,
    alignmentIssues: 0,
    crossingIssues: 0,
    occlusionIssues: 0,
    balanceIssues: 0,
    readabilityIssues: 0,
    qualityIssues: 0,
    totalIssues: 0,
  };
  for (const item of layoutDiagnostics) {
    totals.overflow += item.diagnostics?.overflow?.length || 0;
    totals.overlaps += item.diagnostics?.overlaps?.length || 0;
    totals.edgeIssues += item.diagnostics?.edgeIssues?.length || 0;
    totals.spacingIssues += item.diagnostics?.spacingIssues?.length || 0;
    totals.alignmentIssues += item.diagnostics?.alignmentIssues?.length || 0;
    totals.crossingIssues += item.diagnostics?.crossingIssues?.length || 0;
    totals.occlusionIssues += item.diagnostics?.occlusionIssues?.length || 0;
    totals.balanceIssues += item.diagnostics?.balanceIssues?.length || 0;
    totals.readabilityIssues += item.diagnostics?.readabilityIssues?.length || 0;
    totals.qualityIssues += item.diagnostics?.qualityIssues?.length || 0;
  }
  totals.totalIssues = totals.overflow + totals.overlaps + totals.edgeIssues;
  return totals;
}

function countStatuses(cases) {
  return countBy(cases, (item) => item.summary.status);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sum(items, valueFn) {
  return items.reduce((total, item) => total + valueFn(item), 0);
}

function renumberPages(pages) {
  return pages.map((page, index) => ({ ...page, pageNumber: index + 1, pageCount: pages.length }));
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveCasePath(filePath, baseDir) {
  return path.isAbsolute(String(filePath)) ? String(filePath) : path.resolve(baseDir, String(filePath));
}

function safeFilePart(value) {
  return String(value || "case").replace(/[\\/:*?"<>|]/g, "-");
}

function requiredString(args, key) {
  const value = stringArg(args, key);
  if (!value) throw new Error(`--${key} 값이 필요합니다.`);
  return value;
}

function stringArg(args, key) {
  return typeof args[key] === "string" ? args[key] : undefined;
}

function numberArg(args, key) {
  if (args[key] == null || args[key] === true) return undefined;
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : undefined;
}

function numberValue(...values) {
  for (const value of values) {
    if (value == null || value === true || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\n+/g, " ");
}

function formatSelectedLayouts(layoutSelection) {
  const selected = layoutSelection?.selected || [];
  if (!selected.length) return "";
  return selected.join(",");
}

function priorityLabel(value) {
  if (value === "high") return "높음";
  if (value === "medium") return "중간";
  return "낮음";
}
