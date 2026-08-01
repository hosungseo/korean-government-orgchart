import path from "node:path";
import { buildAuditReport, formatAuditMarkdown } from "./audit.mjs";
import {
  enrichCaseWithLawMap,
  graphFromCase,
  loadBatchContext,
  normalizeCaseSpec,
  planCasePages,
  publicCaseSpec,
  summarizeAuditCase,
} from "./batch-audit.mjs";
import { projectOperationalView } from "./model.mjs";
import { renderSvg } from "./render-svg.mjs";
import { jsonReplacer, writeText } from "./utils.mjs";

const BUILD_STATUS_LABELS = {
  built: "생성",
  error: "오류",
};

export async function runBatchBuild(args = {}) {
  const context = await loadBatchContext(args);
  const outDir = path.resolve(stringArg(args, "out-dir") || "outputs/batch");
  const outputs = parseOutputFormats(stringArg(args, "outputs") || "svg,json,audit");
  const cases = [];
  const lawMapCache = new Map();
  let renderPptx = null;
  if (outputs.includes("pptx")) {
    ({ renderPptx } = await import("./render-pptx.mjs"));
  }

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
      const stem = outputStem(caseSpec, summary);
      const written = {};

      if (outputs.includes("json")) {
        written.json = await writeCaseOutput(outDir, `${stem}.json`, `${JSON.stringify(graph.toJSON(), jsonReplacer, 2)}\n`);
      }
      if (outputs.includes("svg")) {
        written.svg = await writeCaseOutput(outDir, `${stem}.svg`, renderSvg(displayGraph, pages, {
          showLawCounts: caseSpec.lawCounts === true || context.lawCounts === true || caseSpec.lawAppendix === true || context.lawAppendix === true,
        }));
      }
      if (outputs.includes("audit")) {
        written.audit = await writeCaseOutput(outDir, `${stem}.audit.md`, formatAuditMarkdown(report));
      }
      if (outputs.includes("pptx")) {
        const pptxPath = path.join(outDir, `${stem}.pptx`);
        await renderPptx(displayGraph, pages, pptxPath, {
          showLawCounts: caseSpec.lawCounts === true || context.lawCounts === true || caseSpec.lawAppendix === true || context.lawAppendix === true,
        });
        written.pptx = pptxPath;
      }

      cases.push({
        case: publicCaseSpec(caseSpec),
        status: "built",
        statusLabel: BUILD_STATUS_LABELS.built,
        summary,
        outputs: written,
      });
    } catch (error) {
      cases.push({
        case: publicCaseSpec(caseSpec),
        status: "error",
        statusLabel: BUILD_STATUS_LABELS.error,
        summary: {
          id: caseSpec.id,
          institution: caseSpec.institution || caseSpec.id,
          asOf: caseSpec.date || null,
          view: caseSpec.view || context.view || null,
          paper: caseSpec.paper || context.paper || null,
          layout: caseSpec.layouts || caseSpec.layout || context.layouts || context.layout || null,
          focus: caseSpec.focus || context.focus || null,
          status: "error",
        },
        error: error.message,
        outputs: {},
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    outDir,
    outputs,
    total: cases.length,
    statusCounts: countBy(cases, (item) => item.status),
    cases,
  };
}

export function formatBatchBuildMarkdown(result) {
  const lines = [];
  lines.push("# 조직도 batch build");
  lines.push(`- 실행시각: ${result.generatedAt}`);
  lines.push(`- 출력 폴더: ${result.outDir}`);
  lines.push(`- 출력 형식: ${result.outputs.join(", ")}`);
  lines.push(`- 케이스: ${result.total} · 생성 ${result.statusCounts.built || 0} · 오류 ${result.statusCounts.error || 0}`);
  lines.push("");
  lines.push("| 기관 | 기준일 | 보기 | 대상 | 상태 | 페이지 | 배치 문제 | 산출물 |");
  lines.push("| --- | --- | --- | --- | --- | ---: | ---: | --- |");
  for (const item of result.cases) {
    const summary = item.summary || {};
    const outputList = Object.entries(item.outputs || {})
      .map(([kind, filePath]) => `${kind}: ${path.basename(filePath)}`)
      .join("<br>");
    lines.push(
      [
        escapeCell(summary.institution || summary.id),
        escapeCell(summary.asOf || ""),
        escapeCell(summary.view || ""),
        escapeCell(summary.focus || summary.layout || ""),
        escapeCell(item.statusLabel || item.status),
        summary.pages ?? "",
        summary.layoutDiagnostics?.totalIssues ?? "",
        outputList || escapeCell(item.error || ""),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function parseOutputFormats(value) {
  const aliases = {
    markdown: "audit",
    md: "audit",
    report: "audit",
    ppt: "pptx",
  };
  const allowed = new Set(["svg", "json", "audit", "pptx"]);
  const result = [];
  for (const raw of String(value || "").split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "all" || token === "*") {
      for (const item of allowed) if (!result.includes(item)) result.push(item);
      continue;
    }
    const normalized = aliases[token] || token;
    if (!allowed.has(normalized)) throw new Error(`지원하지 않는 batch-build 출력 형식입니다: ${raw}`);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length ? result : ["svg", "json", "audit"];
}

async function writeCaseOutput(outDir, fileName, contents) {
  const filePath = path.join(outDir, fileName);
  await writeText(filePath, contents);
  return filePath;
}

function outputStem(caseSpec, summary) {
  const raw = caseSpec.outputName || [
    summary.institution || caseSpec.institution || caseSpec.id,
    summary.asOf || caseSpec.date,
    summary.view,
    summary.focus || summary.layout,
  ].filter(Boolean).join("-");
  return safeFilePart(raw);
}

function safeFilePart(value) {
  return String(value || "case").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "");
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function stringArg(args, key) {
  return typeof args[key] === "string" ? args[key] : undefined;
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\n+/g, " ");
}
