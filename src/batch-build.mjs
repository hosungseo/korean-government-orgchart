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
import { normalizePaper } from "./layout.mjs";
import { projectOperationalView } from "./model.mjs";
import { renderReviewHtml } from "./render-html.mjs";
import { renderSvg } from "./render-svg.mjs";
import { buildTraceRows, formatTraceCsv } from "./trace.mjs";
import { jsonReplacer, writeText } from "./utils.mjs";

const BUILD_STATUS_LABELS = {
  built: "생성",
  error: "오류",
};

export async function runBatchBuild(args = {}) {
  const context = await loadBatchContext(args);
  const outDir = path.resolve(stringArg(args, "out-dir") || "outputs/batch");
  const outputs = parseOutputFormats(stringArg(args, "outputs") || "svg,json,audit");
  if (stringArg(args, "deck") && !outputs.includes("deck")) outputs.push("deck");
  const cases = [];
  const deckItems = [];
  const lawMapCache = new Map();
  let pptxRenderer = null;
  if (outputs.includes("pptx") || outputs.includes("deck")) {
    pptxRenderer = await import("./render-pptx.mjs");
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
      const showLawCounts = caseSpec.lawCounts === true || context.lawCounts === true || caseSpec.lawAppendix === true || context.lawAppendix === true;

      if (outputs.includes("json")) {
        written.json = await writeCaseOutput(outDir, `${stem}.json`, `${JSON.stringify(graph.toJSON(), jsonReplacer, 2)}\n`);
      }
      if (outputs.includes("svg")) {
        written.svg = await writeCaseOutput(outDir, `${stem}.svg`, renderSvg(displayGraph, pages, { showLawCounts }));
      }
      if (outputs.includes("html")) {
        written.html = await writeCaseOutput(
          outDir,
          `${stem}.html`,
          renderReviewHtml(displayGraph, pages, { showLawCounts, sourceGraph: graph }),
        );
      }
      if (outputs.includes("audit")) {
        written.audit = await writeCaseOutput(outDir, `${stem}.audit.md`, formatAuditMarkdown(report));
      }
      if (outputs.includes("trace")) {
        written.trace = await writeCaseOutput(outDir, `${stem}.trace.csv`, formatTraceCsv(buildTraceRows(graph)));
      }
      if (outputs.includes("pptx")) {
        const pptxPath = path.join(outDir, `${stem}.pptx`);
        await pptxRenderer.renderPptx(displayGraph, pages, pptxPath, { showLawCounts });
        written.pptx = pptxPath;
      }
      if (outputs.includes("deck")) {
        deckItems.push({
          caseId: summary.id,
          institution: summary.institution,
          paper: deckItemPaper(pages, caseSpec, context),
          graph: displayGraph,
          pages,
          showLawCounts,
        });
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

  let deck = null;
  let decks = [];
  let deckError = null;
  if (outputs.includes("deck")) {
    if (deckItems.length) {
      const deckResult = await writeDeckOutputs(deckItems, args, outDir, pptxRenderer);
      deck = deckResult.deck;
      decks = deckResult.decks;
      deckError = deckResult.deckError;
    } else {
      deckError = "생성 가능한 케이스가 없어 통합 PPTX deck을 만들지 않았습니다.";
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    outDir,
    outputs,
    deck,
    decks,
    deckError,
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
  if (result.decks?.length) {
    for (const deck of result.decks) {
      lines.push(`- 통합 PPTX deck(${deck.paper}): ${deck.path}`);
    }
  } else if (result.deck) {
    lines.push(`- 통합 PPTX deck: ${result.deck}`);
  }
  if (result.deckError) lines.push(`- 통합 PPTX deck 오류: ${result.deckError}`);
  lines.push("");
  lines.push("| 기관 | 기준일 | 보기 | 대상 | 선택유형 | 상태 | 페이지 | 배치 문제 | 품질 | 산출물 |");
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |");
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
        escapeCell(formatSelectedLayouts(summary.layoutSelection)),
        escapeCell(item.statusLabel || item.status),
        summary.pages ?? "",
        summary.layoutDiagnostics?.totalIssues ?? "",
        summary.layoutDiagnostics?.qualityIssues ?? "",
        outputList || escapeCell(item.error || (result.deck || result.decks?.length ? "deck 포함" : "")),
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
    combined: "deck",
    "pptx-deck": "deck",
    pptxdeck: "deck",
  };
  const perCaseOutputs = ["svg", "html", "json", "audit", "trace", "pptx"];
  const allowed = new Set([...perCaseOutputs, "deck"]);
  const result = [];
  for (const raw of String(value || "").split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "all" || token === "*") {
      for (const item of perCaseOutputs) if (!result.includes(item)) result.push(item);
      continue;
    }
    const normalized = aliases[token] || token;
    if (!allowed.has(normalized)) throw new Error(`지원하지 않는 batch-build 출력 형식입니다: ${raw}`);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length ? result : ["svg", "json", "audit"];
}

function deckOutputPath(args, outDir) {
  const explicit = stringArg(args, "deck");
  if (explicit) return path.resolve(explicit);
  return path.join(outDir, "batch-orgcharts.pptx");
}

async function writeDeckOutputs(deckItems, args, outDir, pptxRenderer) {
  const groups = groupBy(deckItems, (item) => item.paper);
  const basePath = deckOutputPath(args, outDir);
  const singleGroup = groups.size === 1;
  const decks = [];
  const errors = [];
  for (const [paper, items] of groups) {
    const outputPath = singleGroup ? basePath : suffixedDeckPath(basePath, paper);
    try {
      await pptxRenderer.renderPptxDeck(items, outputPath);
      decks.push({
        paper,
        path: outputPath,
        cases: items.map((item) => item.caseId).filter(Boolean),
        pages: items.reduce((sum, item) => sum + item.pages.length, 0),
      });
    } catch (error) {
      errors.push(`${paper}: ${error.message}`);
    }
  }
  return {
    deck: decks.length === 1 ? decks[0].path : null,
    decks,
    deckError: errors.length ? errors.join(" / ") : null,
  };
}

function deckItemPaper(pages, caseSpec, context) {
  const papers = new Set((pages || []).map((page) => normalizePaper(page.paper || caseSpec.paper || context.paper || "slide")));
  if (!papers.size) return normalizePaper(caseSpec.paper || context.paper || "slide");
  if (papers.size > 1) {
    throw new Error(`한 케이스 안에 서로 다른 용지 크기가 섞여 있습니다: ${[...papers].join(", ")}`);
  }
  return [...papers][0];
}

function suffixedDeckPath(filePath, suffix) {
  const parsed = path.parse(filePath);
  const ext = parsed.ext || ".pptx";
  return path.join(parsed.dir, `${parsed.name}-${safeFilePart(suffix)}${ext}`);
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
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

function formatSelectedLayouts(layoutSelection) {
  return (layoutSelection?.selected || []).join(",");
}
