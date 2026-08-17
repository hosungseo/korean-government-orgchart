#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { applyAnnexOrganizations, attachAnnexes } from "./annex.mjs";
import { buildAuditReport, formatAuditMarkdown } from "./audit.mjs";
import { formatBatchAuditMarkdown, runBatchAudit } from "./batch-audit.mjs";
import { formatBatchBuildMarkdown, runBatchBuild } from "./batch-build.mjs";
import { buildAuditCaseSpecs } from "./case-scaffold.mjs";
import {
  buildComparisonReportPages,
  compareOrgGraphs,
  formatComparisonCsv,
  formatComparisonMarkdown,
} from "./graph-diff.mjs";
import { fetchLawAtDate } from "./law-api.mjs";
import { organizationLawNameCandidateGroups } from "./law-name.mjs";
import { buildLawAppendixPages, enrichGraphWithLawMap } from "./law-map.mjs";
import { planBestPages, planLayoutVariants, planPages } from "./layout.mjs";
import { OrgGraph, projectOperationalView, summarizeStructure } from "./model.mjs";
import { parseOrganizationTexts } from "./parser.mjs";
import { renderReviewHtml } from "./render-html.mjs";
import { renderSvg } from "./render-svg.mjs";
import { runReviewPack } from "./review-pack.mjs";
import { buildNativeComparisonWorkflow } from "./native-law-workflow.mjs";
import { nativePreviewWidth, renderNativeManifestSvg } from "./render-native-manifest.mjs";
import { ensureParent, jsonReplacer, parseArgs, readInputs, writeText } from "./utils.mjs";

const [command = "help", ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (command === "build") await buildCommand(args);
  else if (command === "render-json") await renderJsonCommand(args);
  else if (command === "compare-json") await compareJsonCommand(args);
  else if (command === "compare-law") await compareLawCommand(args);
  else if (command === "compare-native") await compareNativeCommand(args);
  else if (command === "from-law") await fromLawCommand(args);
  else if (command === "fetch") await fetchCommand(args);
  else if (command === "inspect") await inspectCommand(args);
  else if (command === "audit") await auditCommand(args);
  else if (command === "batch-audit") await batchAuditCommand(args);
  else if (command === "batch-build") await batchBuildCommand(args);
  else if (command === "review-pack") await reviewPackCommand(args);
  else if (command === "make-cases") await makeCasesCommand(args);
  else printHelp();
} catch (error) {
  console.error(process.env.DEBUG ? error.stack : `오류: ${error.message}`);
  process.exitCode = 1;
}

async function buildCommand(args) {
  const graph = await graphFromInputs(args);
  await emitOutputs(graph, args);
}

async function renderJsonCommand(args) {
  const graph = await graphFromJsonArgs(args);
  await emitOutputs(graph, args);
}

async function compareJsonCommand(args) {
  const beforePath = stringArg(args, "before") || stringArg(args, "old");
  const afterPath = stringArg(args, "after") || stringArg(args, "new");
  if (!beforePath || !afterPath) {
    throw new Error("--before <기존.json> 및 --after <개정.json> 값이 필요합니다.");
  }
  const before = await readGraphFromJsonPath(beforePath);
  const after = await readGraphFromJsonPath(afterPath);
  const graph = compareOrgGraphs(before, after, { title: stringArg(args, "title") });
  const outputArgs = {
    ...args,
    layout: stringArg(args, "layout") || "change-lanes",
    paper: stringArg(args, "paper") || "a4-landscape",
  };
  await emitComparisonReportsIfRequested(graph, args);
  await emitOutputs(graph, outputArgs);
}

async function compareLawCommand(args) {
  const before = await graphFromCompareLawSide(args, "before");
  const after = await graphFromCompareLawSide(args, "after");
  const graph = compareOrgGraphs(before, after, { title: stringArg(args, "title") });
  const outputArgs = {
    ...args,
    layout: stringArg(args, "layout") || "change-lanes",
    paper: stringArg(args, "paper") || "a4-landscape",
  };
  await emitComparisonReportsIfRequested(graph, args);
  await emitOutputs(graph, outputArgs);
}

async function compareNativeCommand(args) {
  const stages = await loadNativeComparisonStages(args);
  const onePage = args["split-pages"] !== true && args["no-one-page"] !== true;
  const workflow = buildNativeComparisonWorkflow({
    stages,
    institution: stringArg(args, "institution"),
    focus: stringArg(args, "focus"),
    onePage,
  });
  const manifest = workflow.manifests[0];
  if (!manifest) throw new Error("대비 조직도를 만들지 못했습니다.");
  const outputs = {};
  if (stringArg(args, "json")) {
    const jsonPath = path.resolve(stringArg(args, "json"));
    await writeText(jsonPath, `${JSON.stringify(manifest, jsonReplacer, 2)}\n`);
    outputs.json = jsonPath;
  }
  if (stringArg(args, "svg")) {
    const svgPath = path.resolve(stringArg(args, "svg"));
    await writeText(svgPath, renderNativeManifestSvg(manifest));
    outputs.svg = svgPath;
  }
  if (stringArg(args, "png")) {
    const pngPath = path.resolve(stringArg(args, "png"));
    const { default: sharp } = await import("sharp");
    await ensureParent(pngPath);
    await sharp(Buffer.from(renderNativeManifestSvg(manifest)))
      .png()
      .resize({ width: nativePreviewWidth(manifest) })
      .toFile(pngPath);
    outputs.png = pngPath;
  }
  if (stringArg(args, "out")) {
    throw new Error("compare-native는 PPTX를 만들지 않습니다. --svg, --png, --json을 쓰거나 Windows 데스크톱에서 한글로 생성하세요.");
  }
  console.log(JSON.stringify({
    institution: workflow.summary.institution,
    paper: workflow.summary.paper || manifest.page.paper,
    layout: workflow.summary.layout,
    comparison: workflow.summary.comparison,
    columns: workflow.summary.columns || 2,
    pageCount: workflow.summary.pageCount,
    stageAsOf: workflow.summary.stageAsOf || [workflow.summary.beforeAsOf, workflow.summary.afterAsOf],
    warnings: workflow.summary.warnings,
    outputs,
  }, null, 2));
}

async function loadNativeComparisonStages(args) {
  const stagePaths = listArg(args, "stage");
  const stageDates = listArg(args, "stage-date");
  if (stagePaths.length) {
    if (stagePaths.length < 2) throw new Error("대비할 --stage를 두 개 이상 지정하세요.");
    if (stagePaths.length > 4) throw new Error("대비 시점은 최대 4개까지입니다.");
    if (stageDates.length && stageDates.length !== stagePaths.length) {
      throw new Error("--stage-date는 --stage와 같은 개수여야 합니다.");
    }
    const stages = [];
    for (const [index, stagePath] of stagePaths.entries()) {
      stages.push(await loadNativeStage(stagePath, stageDates[index], stringArg(args, "institution")));
    }
    return stages;
  }

  const beforeInputs = args["before-input"] || [];
  const afterInputs = args["after-input"] || [];
  if (beforeInputs.length && afterInputs.length) {
    return [
      await stageFromInputFiles(beforeInputs, stringArg(args, "before-date") || stringArg(args, "date"), stringArg(args, "institution")),
      await stageFromInputFiles(afterInputs, stringArg(args, "after-date") || stringArg(args, "date"), stringArg(args, "institution")),
    ];
  }
  throw new Error("compare-native는 --stage 폴더를 두 개 이상 쓰거나 --before-input과 --after-input을 함께 지정하세요.");
}

async function loadNativeStage(stagePath, asOf, institution) {
  const resolved = path.resolve(stagePath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    const files = await fs.readdir(resolved);
    const decreeName = files.find((name) => /직제/.test(name) && !/시행규칙/.test(name) && name.endsWith(".txt"));
    const ruleName = files.find((name) => /시행규칙/.test(name) && name.endsWith(".txt"));
    if (!decreeName && !ruleName) {
      throw new Error(`${stagePath}에서 직제 또는 시행규칙 텍스트를 찾지 못했습니다.`);
    }
    return {
      institution,
      asOf: asOf || inferDateFromName(decreeName || ruleName || stagePath),
      decreeText: decreeName ? await fs.readFile(path.join(resolved, decreeName), "utf8") : "",
      ruleText: ruleName ? await fs.readFile(path.join(resolved, ruleName), "utf8") : "",
    };
  }
  if (resolved.endsWith(".json")) {
    const snapshot = JSON.parse(await fs.readFile(resolved, "utf8"));
    if (snapshot.graph || snapshot.schema === "kr.go.mois.orgchart.history/v1") {
      return { ...snapshot, asOf: asOf || snapshot.asOf, institution: institution || snapshot.institution };
    }
    throw new Error(`${stagePath}는 조직 스냅샷 JSON이 아닙니다.`);
  }
  throw new Error(`--stage는 스냅샷 폴더 또는 이력 JSON이어야 합니다: ${stagePath}`);
}

async function stageFromInputFiles(paths, asOf, institution) {
  const texts = await readInputs(paths);
  const split = { decreeText: "", ruleText: "" };
  paths.forEach((filePath, index) => {
    if (/시행규칙/.test(filePath)) split.ruleText += texts[index];
    else if (/직제/.test(filePath)) split.decreeText += texts[index];
    else if (!split.decreeText) split.decreeText = texts[index];
    else split.ruleText += texts[index];
  });
  return { ...split, asOf, institution };
}

function inferDateFromName(value) {
  const iso = String(value || "").match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const digits = String(value || "").match(/(\d{8})/);
  if (!digits) return undefined;
  return `${digits[1].slice(0, 4)}-${digits[1].slice(4, 6)}-${digits[1].slice(6, 8)}`;
}

function listArg(args, key) {
  if (Array.isArray(args[key])) return args[key].filter((value) => typeof value === "string");
  if (typeof args[key] === "string") return [args[key]];
  return [];
}

async function fromLawCommand(args) {
  const graph = await graphFromLawArgs(args);
  await emitOutputs(graph, args);
}

async function graphFromLawArgs(args) {
  const date = required(args, "date");
  const institution = stringArg(args, "institution");
  const names = [
    stringArg(args, "decree"),
    stringArg(args, "rule"),
    ...args.law.filter((value) => typeof value === "string"),
  ].filter(Boolean);
  if (!names.length && !institution) {
    throw new Error("--institution, --decree 또는 --law로 법령명을 지정해야 합니다.");
  }
  const fetched = names.length
    ? await fetchExplicitLaws(names, date, args)
    : await fetchInferredOrganizationLaws(institution, date, args);
  if (args["source-dir"]) {
    await fs.mkdir(path.resolve(args["source-dir"]), { recursive: true });
    for (const item of fetched) {
      const safeName = item.lawName.replace(/[\\/:*?"<>|]/g, "-");
      await writeText(path.join(path.resolve(args["source-dir"]), `${safeName}-${item.effectiveDate}.txt`), item.text);
      if (item.annexes?.length) {
        await writeText(
          path.join(path.resolve(args["source-dir"]), `${safeName}-${item.effectiveDate}.annexes.json`),
          `${JSON.stringify(item.annexes, jsonReplacer, 2)}\n`,
        );
      }
    }
  }
  const graph = parseOrganizationTexts(
    fetched.map((item) => item.text),
    {
      institution: stringArg(args, "institution"),
      title: stringArg(args, "title"),
      asOf: date,
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
  applyAnnexOrganizations(graph);
  graph.validateLegalStructure();
  return graph;
}

async function graphFromCompareLawSide(args, side) {
  const inputKey = `${side}-input`;
  const dateKey = `${side}-date`;
  const sideInputs = args[inputKey] || [];
  const sideDate = stringArg(args, dateKey) || stringArg(args, "date");
  if (sideInputs.length) {
    const texts = await readInputs(sideInputs);
    return parseOrganizationTexts(texts, {
      institution: stringArg(args, "institution"),
      title: stringArg(args, side === "before" ? "before-title" : "after-title") || stringArg(args, "title"),
      asOf: sideDate,
      headName: stringArg(args, "head"),
      deputyName: stringArg(args, "deputy"),
      sources: sideInputs,
    });
  }

  if (!sideDate) throw new Error(`--${dateKey} 값 또는 --${inputKey} 경로가 필요합니다.`);
  const sideArgs = {
    ...args,
    date: sideDate,
    decree: stringArg(args, `${side}-decree`) || stringArg(args, "decree"),
    rule: stringArg(args, `${side}-rule`) || stringArg(args, "rule"),
    law: (args[`${side}-law`] || []).length ? args[`${side}-law`] : args.law,
    title: stringArg(args, side === "before" ? "before-title" : "after-title") || stringArg(args, "title"),
  };
  return graphFromLawArgs(sideArgs);
}

async function fetchExplicitLaws(names, date, args) {
  const fetched = [];
  for (const name of names) {
    fetched.push(await fetchLawAtDate(name, date, { oc: stringArg(args, "oc") }));
  }
  return fetched;
}

async function fetchInferredOrganizationLaws(institution, date, args) {
  const groups = organizationLawNameCandidateGroups(institution);
  const fetched = [];
  for (const group of groups) {
    fetched.push(await fetchFirstLawCandidate(group, date, args));
  }
  return fetched;
}

async function fetchFirstLawCandidate(group, date, args) {
  const errors = [];
  for (const name of group.candidates) {
    try {
      return await fetchLawAtDate(name, date, { oc: stringArg(args, "oc") });
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`${group.label} 후보를 찾지 못했습니다. 시도한 제명: ${errors.join(" / ")}`);
}

async function fetchCommand(args) {
  const date = required(args, "date");
  const names = args.law.filter((value) => typeof value === "string");
  if (!names.length) throw new Error("하나 이상의 --law가 필요합니다.");
  const chunks = [];
  for (const name of names) {
    const item = await fetchLawAtDate(name, date, { oc: stringArg(args, "oc") });
    chunks.push(`# ${item.lawName} [시행 ${item.effectiveDate}]\n${item.text}`);
  }
  const output = required(args, "out");
  await writeText(output, chunks.join("\n\n"));
  console.log(`법령 문언 저장: ${path.resolve(output)}`);
}

async function inspectCommand(args) {
  const graph = await graphFromInputs(args);
  const summary = summarize(graph, planRequestedPages(graph, args));
  console.log(JSON.stringify(summary, null, 2));
}

async function auditCommand(args) {
  const graph = args.input?.length ? await graphFromInputs(args) : await graphFromLawArgs(args);
  await enrichWithLawMapIfRequested(graph, args);
  const view = stringArg(args, "view") || "legal";
  if (!new Set(["legal", "operational"]).has(view)) {
    throw new Error(`--view는 legal 또는 operational이어야 합니다: ${view}`);
  }
  const displayGraph = view === "operational" ? projectOperationalView(graph) : graph;
  const pages = planRequestedPages(displayGraph, args);
  const report = buildAuditReport(displayGraph, pages);
  const format = String(args.format || "markdown").toLowerCase();
  const output = format === "json" ? `${JSON.stringify(report, jsonReplacer, 2)}\n` : formatAuditMarkdown(report);
  if (args.out) {
    await writeText(path.resolve(args.out), output);
    console.log(`감사 리포트 저장: ${path.resolve(args.out)}`);
  } else {
    console.log(output);
  }
}

async function batchAuditCommand(args) {
  const result = await runBatchAudit(args);
  const format = String(args.format || "markdown").toLowerCase();
  const output =
    format === "json" ? `${JSON.stringify(result, jsonReplacer, 2)}\n` : formatBatchAuditMarkdown(result);
  if (args.out) {
    await writeText(path.resolve(args.out), output);
    console.log(`배치 감사 리포트 저장: ${path.resolve(args.out)}`);
  } else {
    console.log(output);
  }
  if (args.strict === true) {
    const failing = result.cases.some((item) =>
      ["error", "needs-correction"].includes(item.summary.status),
    );
    if (failing) process.exitCode = 2;
  }
}

async function batchBuildCommand(args) {
  const result = await runBatchBuild(args);
  const format = String(args.format || "markdown").toLowerCase();
  const output =
    format === "json" ? `${JSON.stringify(result, jsonReplacer, 2)}\n` : formatBatchBuildMarkdown(result);
  if (args.out) {
    await writeText(path.resolve(args.out), output);
    console.log(`배치 생성 매니페스트 저장: ${path.resolve(args.out)}`);
  } else {
    console.log(output);
  }
  if (args.strict === true && (result.deckError || result.cases.some((item) => item.status === "error"))) {
    process.exitCode = 2;
  }
}

async function makeCasesCommand(args) {
  const inputInstitutions = args.input?.length ? await readInputs(args.input) : [];
  const institutions = [stringArg(args, "institutions"), stringArg(args, "institution"), ...inputInstitutions];
  const result = buildAuditCaseSpecs({
    institutions,
    date: stringArg(args, "date"),
    view: stringArg(args, "view") || "operational",
    paper: stringArg(args, "paper") || "a4-half",
    layout: stringArg(args, "layout") || "best",
    layouts: stringArg(args, "layouts"),
    focus: stringArg(args, "focus"),
    maxNodes: args["max-nodes"] ? Number(args["max-nodes"]) : undefined,
    lawMap: stringArg(args, "law-map"),
    lawMapDate: stringArg(args, "law-map-date"),
    expandLayouts: args["expand-layouts"],
  });
  const output = `${JSON.stringify(result, jsonReplacer, 2)}\n`;
  if (args.out) {
    await writeText(path.resolve(args.out), output);
    console.log(`배치 케이스 저장: ${path.resolve(args.out)}`);
  } else {
    console.log(output);
  }
}

async function reviewPackCommand(args) {
  const result = await runReviewPack(args);
  const summary = {
    outDir: result.outDir,
    artifactDir: result.artifactDir,
    cases: result.caseCount,
    auditStatusCounts: result.audit.statusCounts,
    buildStatusCounts: result.build.statusCounts,
    deck: result.build.deck,
    decks: result.build.decks,
    files: result.files,
    suggestedCases: result.suggestedCases
      ? {
          changedCases: result.suggestedCases.changedCases,
          cases: result.suggestedCases.cases.length,
        }
      : undefined,
    acceptedCases: result.acceptedCases
      ? {
          evaluated: result.acceptedCases.evaluated,
          acceptedCases: result.acceptedCases.acceptedCases,
          rejectedCases: result.acceptedCases.rejectedCases,
          unchangedCases: result.acceptedCases.unchangedCases,
          notEvaluatedCases: result.acceptedCases.notEvaluatedCases,
          cases: result.acceptedCases.cases.length,
        }
      : undefined,
    rerun: summarizeReviewPackRerun(result.rerun),
    acceptedBuild: summarizeAcceptedBuild(result.acceptedBuild),
  };
  console.log(JSON.stringify(summary, jsonReplacer, 2));
  if (args.strict === true) {
    const auditFailing = result.audit.cases.some((item) =>
      ["error", "needs-correction"].includes(item.summary.status),
    );
    const buildFailing = result.build.deckError || result.build.cases.some((item) => item.status === "error");
    const rerunAuditFailing = result.rerun?.audit?.cases?.some((item) =>
      ["error", "needs-correction"].includes(item.summary.status),
    );
    const rerunBuildFailing = result.rerun?.build?.deckError || result.rerun?.build?.cases?.some((item) => item.status === "error");
    const acceptedBuildFailing =
      (args["build-accepted"] === true && result.acceptedBuild?.skipped) ||
      result.acceptedBuild?.build?.deckError ||
      result.acceptedBuild?.build?.cases?.some((item) => item.status === "error");
    if (auditFailing || buildFailing || rerunAuditFailing || rerunBuildFailing || acceptedBuildFailing) process.exitCode = 2;
  }
}

function summarizeReviewPackRerun(rerun) {
  if (!rerun) return undefined;
  if (rerun.skipped) {
    return {
      skipped: true,
      reason: rerun.reason,
      changedCases: rerun.changedCases || 0,
    };
  }
  return {
    outDir: rerun.outDir,
    artifactDir: rerun.artifactDir,
    cases: rerun.caseCount,
    auditStatusCounts: rerun.audit?.statusCounts,
    buildStatusCounts: rerun.build?.statusCounts,
    deck: rerun.build?.deck,
    decks: rerun.build?.decks,
    files: rerun.files,
    comparison: rerun.comparison,
  };
}

function summarizeAcceptedBuild(acceptedBuild) {
  if (!acceptedBuild) return undefined;
  if (acceptedBuild.skipped) {
    return {
      skipped: true,
      reason: acceptedBuild.reason,
      acceptedCases: acceptedBuild.acceptedCases || 0,
    };
  }
  return {
    outDir: acceptedBuild.outDir,
    files: acceptedBuild.files,
    acceptedCases: acceptedBuild.acceptedCases,
    rejectedCases: acceptedBuild.rejectedCases,
    unchangedCases: acceptedBuild.unchangedCases,
    buildStatusCounts: acceptedBuild.build?.statusCounts,
    deck: acceptedBuild.build?.deck,
    decks: acceptedBuild.build?.decks,
  };
}

async function graphFromInputs(args) {
  const texts = await readInputs(args.input);
  return parseOrganizationTexts(texts, {
    institution: stringArg(args, "institution"),
    title: stringArg(args, "title"),
    asOf: stringArg(args, "date"),
    headName: stringArg(args, "head"),
    deputyName: stringArg(args, "deputy"),
    sources: args.input,
  });
}

async function graphFromJsonArgs(args) {
  const graphPath = stringArg(args, "graph") || args.input?.[0];
  if (!graphPath) throw new Error("--graph 또는 --input으로 조직도 JSON 경로를 지정해야 합니다.");
  const graph = await readGraphFromJsonPath(graphPath);
  const title = stringArg(args, "title");
  const date = stringArg(args, "date");
  if (title) graph.meta.title = title;
  if (date) graph.meta.asOf = date;
  return graph;
}

async function readGraphFromJsonPath(graphPath) {
  const raw = graphPath === "-" ? (await readInputs(["-"]))[0] : await fs.readFile(path.resolve(graphPath), "utf8");
  let json;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`조직도 JSON을 읽을 수 없습니다: ${graphPath}`);
  }
  return OrgGraph.fromJSON(json);
}

async function emitOutputs(graph, args) {
  await enrichWithLawMapIfRequested(graph, args);
  const view = stringArg(args, "view") || "legal";
  if (!new Set(["legal", "operational"]).has(view)) {
    throw new Error(`--view는 legal 또는 operational이어야 합니다: ${view}`);
  }
  const displayGraph = view === "operational" ? projectOperationalView(graph) : graph;
  let pages = planRequestedPages(displayGraph, args);
  const lawAppendix = args["law-appendix"] === true;
  const changeAppendix = args["change-appendix"] === true;
  const showLawCounts = args["law-counts"] === true || lawAppendix;
  if (lawAppendix) {
    if (!graph.meta.lawMap) throw new Error("--law-appendix에는 --law-map <dept_map.json>이 필요합니다.");
    pages = renumberPages([...pages, ...buildLawAppendixPages(graph)]);
  }
  if (changeAppendix) {
    if (!graph.meta.comparison) throw new Error("--change-appendix는 compare-json/compare-law 결과에만 사용할 수 있습니다.");
    pages = renumberPages([
      ...pages,
      ...buildComparisonReportPages(graph, { paper: pages[0]?.paper || stringArg(args, "paper") || "slide" }),
    ]);
  }
  if (args.json) {
    await writeText(path.resolve(args.json), `${JSON.stringify(graph.toJSON(), jsonReplacer, 2)}\n`);
  }
  if (args.svg) {
    await writeText(path.resolve(args.svg), renderSvg(displayGraph, pages, { showLawCounts }));
  }
  if (args.html) {
    await writeText(path.resolve(args.html), renderReviewHtml(displayGraph, pages, {
      showLawCounts,
      sourceGraph: graph,
      artifactLinks: cliArtifactLinks(args),
    }));
  }
  if (args.hwpx) {
    const { renderHwpx } = await import("./render-hwpx.mjs");
    await renderHwpx(displayGraph, pages, path.resolve(args.hwpx), {
      showLawCounts,
      sourceGraph: graph,
    });
  }
  if (args.out) {
    await ensureParent(args.out);
    const { renderPptx } = await import("./render-pptx.mjs");
    await renderPptx(displayGraph, pages, path.resolve(args.out), {
      previewDir: stringArg(args, "preview-dir"),
      showLawCounts,
      routedConnectors: routedPptxEnabled(args),
    });
  }
  if (!args.out && !args.svg && !args.json && !args.html && !args.hwpx) {
    console.log(JSON.stringify(graph.toJSON(), jsonReplacer, 2));
  }
  console.log(JSON.stringify({ ...summarize(graph, pages), view }, null, 2));
}

function cliArtifactLinks(args) {
  const links = {};
  if (args.svg) links.svg = path.basename(path.resolve(args.svg));
  if (args.json) links.json = path.basename(path.resolve(args.json));
  if (args.hwpx) links.hwpx = path.basename(path.resolve(args.hwpx));
  if (args.out) links.pptx = path.basename(path.resolve(args.out));
  return links;
}

async function emitComparisonReportsIfRequested(graph, args) {
  const reportPath = stringArg(args, "change-report") || stringArg(args, "changes");
  const csvPath = stringArg(args, "change-csv");
  if (reportPath) {
    await writeText(path.resolve(reportPath), formatComparisonMarkdown(graph));
  }
  if (csvPath) {
    await writeText(path.resolve(csvPath), formatComparisonCsv(graph));
  }
}

function planRequestedPages(graph, args) {
  const layout = stringArg(args, "layout") || "auto";
  if (layout === "best") {
    return planBestPages(graph, {
      maxNodes: args["max-nodes"] ? Number(args["max-nodes"]) : 38,
      paper: stringArg(args, "paper") || "slide",
      focus: stringArg(args, "focus"),
    });
  }
  const layouts = stringArg(args, "layouts") || (layout === "all" ? "all" : undefined);
  const options = {
    mode: layout === "all" ? "auto" : layout,
    maxNodes: args["max-nodes"] ? Number(args["max-nodes"]) : 38,
    paper: stringArg(args, "paper") || "slide",
    focus: stringArg(args, "focus"),
  };
  return layouts ? planLayoutVariants(graph, { ...options, layouts }) : planPages(graph, options);
}

function renumberPages(pages) {
  return pages.map((page, index) => ({ ...page, pageNumber: index + 1, pageCount: pages.length }));
}

function summarize(graph, pages) {
  const kindCounts = {};
  for (const node of graph.nodes.values()) {
    kindCounts[node.kind] = (kindCounts[node.kind] || 0) + 1;
  }
  return {
    institution: graph.meta.institution,
    asOf: graph.meta.asOf,
    nodes: graph.nodes.size,
    edges: graph.edges.size,
    pages: pages.length,
    kinds: kindCounts,
    warnings: graph.meta.warnings,
    validation: graph.meta.validation,
    temporaryHeadcounts: graph.meta.temporaryHeadcounts?.length || 0,
    jurisdictionRelations: graph.meta.jurisdictionRelations?.length || 0,
    annexes: graph.meta.annexes?.length || 0,
    annexOrganizations: graph.meta.annexOrganizations?.length || 0,
    structure: summarizeStructure(graph),
    spanDiagnostics: graph.meta.spanDiagnostics || [],
    lawMappedDepartments: graph.meta.lawMap?.matchedDepartments || 0,
    lawMappedLaws: graph.meta.lawMap?.lawCount || 0,
    comparison: graph.meta.comparison || undefined,
  };
}

async function enrichWithLawMapIfRequested(graph, args) {
  const mapPath = stringArg(args, "law-map");
  if (!mapPath) return;
  const raw = await fs.readFile(path.resolve(mapPath), "utf8");
  let map;
  try {
    map = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`소관법령 지도 JSON을 읽을 수 없습니다: ${mapPath}`);
  }
  enrichGraphWithLawMap(graph, map, {
    asOf: stringArg(args, "law-map-date"),
    source: path.basename(mapPath),
  });
}

function required(args, key) {
  const value = stringArg(args, key);
  if (!value) throw new Error(`--${key} 값이 필요합니다.`);
  return value;
}

function stringArg(args, key) {
  return typeof args[key] === "string" ? args[key] : undefined;
}

function routedPptxEnabled(args) {
  return args["routed-pptx"] === true || args["pptx-route"] === true;
}

function printHelp() {
  console.log(`
대한민국 행정기관 직제 문언 → 조직도

사용법
  node src/cli.mjs build \\
    --input 직제.txt --input 시행규칙.txt \\
    --date 2025-11-25 \\
    --out outputs/조직도.pptx \\
    --svg outputs/조직도.svg \\
    --hwpx outputs/조직도-검토보고서.hwpx \\
    --html outputs/조직도.html \\
    --json outputs/조직도.json

  node src/cli.mjs from-law \\
    --decree "행정안전부와 그 소속기관 직제" \\
    --rule "행정안전부와 그 소속기관 직제 시행규칙" \\
    --date 2025-11-25 \\
    --out outputs/행정안전부.pptx

  node src/cli.mjs from-law \\
    --institution "산업통상부" \\
    --date 2026-07-24 \\
    --layout best \\
    --svg outputs/산업통상부.svg

  node src/cli.mjs render-json \\
    --graph outputs/행정안전부.json \\
    --paper a4-half --layout best --focus 재난안전관리본부 \\
    --svg outputs/행정안전부-재난본부.svg \\
    --out outputs/행정안전부-재난본부.pptx

  node src/cli.mjs compare-json \\
    --before outputs/기관-개정전.json \\
    --after outputs/기관-개정후.json \\
    --svg outputs/기관-변경비교.svg \\
    --out outputs/기관-변경비교.pptx \\
    --change-report outputs/기관-변경목록.md \\
    --change-appendix

  node src/cli.mjs compare-law \\
    --before-input old-직제.txt --before-input old-시행규칙.txt \\
    --after-input new-직제.txt --after-input new-시행규칙.txt \\
    --svg outputs/기관-변경비교.svg \\
    --change-csv outputs/기관-변경목록.csv \\
    --change-appendix

  node src/cli.mjs compare-native \\
    --stage work/legal-snapshots/mois-20251001 \\
    --stage work/legal-snapshots/mois \\
    --stage work/legal-snapshots/mois-2026 \\
    --focus "디지털정부혁신실, 인공지능정부실, 참여혁신국, 조직국, 참여혁신조직실" \\
    --svg outputs/행정안전부-3단-대비.svg \\
    --png outputs/행정안전부-3단-대비.png

  node src/cli.mjs review-pack \\
    --institutions "행정안전부,문화체육관광부,공정거래위원회" \\
    --date 2026-07-24 \\
    --out-dir outputs/review-pack \\
    --source-dir work/law-sources

명령
  build      로컬 텍스트를 파싱하여 HWPX/PPTX/SVG/JSON 생성
  render-json 기존 조직도 JSON을 다시 배치하여 HWPX/PPTX/SVG/JSON 생성
  compare-json 기존·개정 조직도 JSON을 비교해 신설·폐지·명칭변경·이체 표식 생성
  compare-law 개정 전·후 직제 문언 또는 법제처 기준일을 바로 비교해 변경 도표 생성
  compare-native 직제 시점 2~4개를 좌우/다단 기구도로 작도(2단 A4, 3단 이상 A3). 점선·신설·폐지 규칙은 docs/drafting-rulebook.md §7의4
  from-law   법제처 OPEN API에서 기준일 연혁을 찾아 바로 생성
  fetch      법령 문언만 로컬 텍스트로 저장
  inspect    파싱 결과 요약 출력
  audit      파싱·소관·별표·배치 품질 감사 리포트 출력
  batch-audit 여러 기관·기준일·레이아웃을 한 번에 감사하여 품질 매트릭스 출력
  batch-build 여러 기관·기준일·레이아웃의 HWPX/SVG/JSON/PPTX/감사리포트·통합 deck 일괄 생성
  review-pack 기관 목록 또는 cases.json에서 감사 리포트·산출물·통합 deck을 한 번에 생성
  make-cases 기관명 목록에서 batch-audit 케이스 JSON 생성

주요 옵션
  --layout auto|best|compact|split|vertical|horizontal|two-column|matrix|flow|change-lanes|affiliate-strip|catalog|all
  --layouts vertical,horizontal,two-column,matrix,flow,change-lanes,affiliate-strip,catalog  같은 문언을 여러 유형으로 한 번에 출력
  --expand-layouts <list>|all  batch/review-pack 케이스를 레이아웃별 별도 산출물로 자동 확장
  --paper slide|a4-portrait|a4-landscape|a4-half  출력 용지와 방향
  --hwpx <file.hwpx>       조직도·자동점검·편집 가능한 근거표를 담은 HWPX 보고서 저장
  --html <file.html>       한글/HWPX 붙여넣기·인쇄용 A4 HTML 검토시트 저장
  --focus <조직명>  해당 조직과 하위조직만 한 장으로 출력
  --view legal|operational  법정 설치형(기본) 또는 확인된 정책관·국 소관 묶음형
  --preview-dir <dir>       슬라이드 PNG·layout JSON·montage 생성
  --routed-pptx             PPTX도 SVG와 같은 route 조각선으로 그림(편집 안정형 커넥터 대신 최종본 품질 우선)
  --law-map <dept_map.json> 부서별 소관법령을 정확히 일치하는 조직 노드에 연결
  --law-map-date <YYYY-MM-DD>  소관법령 지도 기준일(기구도 기준일 불일치 경고용)
  --law-counts              소관법령이 연결된 조직 상자에 법령 수 배지 표시
  --law-appendix            PPTX·SVG 뒤에 부서별 소관법령 색인 부록 추가(--law-map 필요)
  --before <graph.json>     compare-json의 개정 전 조직도 JSON
  --after <graph.json>      compare-json의 개정 후 조직도 JSON
  --before-input <file>     compare-law의 개정 전 직제/시행규칙 문언(반복 가능)
  --after-input <file>      compare-law의 개정 후 직제/시행규칙 문언(반복 가능)
  --before-date <YYYY-MM-DD> compare-law 법제처 조회 또는 개정 전 문언 기준일
  --after-date <YYYY-MM-DD> compare-law 법제처 조회 또는 개정 후 문언 기준일
  --stage <dir|snapshot.json> compare-native 시점(반복, 2~4). 폴더는 직제·시행규칙 txt
  --stage-date <YYYY-MM-DD>   compare-native 각 --stage의 기준일(같은 개수)
  --png <file.png>            compare-native SVG 미리보기 PNG
  --change-report <file.md> compare-json/compare-law 변경목록 Markdown 표 저장
  --change-csv <file.csv>   compare-json/compare-law 변경목록 CSV 저장
  --change-appendix         compare-json/compare-law SVG·PPTX 뒤에 변경목록 표 페이지 추가
  --graph <graph.json>      render-json의 기존 조직도 JSON
  --oc <인증값>             LAW_API_OC 환경변수로도 지정 가능
  --source-dir <dir>        조회한 기준일 법령 문언 보관 및 다음 실행 재사용 캐시
  --format markdown|json    audit 리포트 출력 형식
  --cases <cases.json>      batch-audit/build/review-pack 케이스 목록
  cases.json graph/jsonFile 저장된 조직도 JSON을 법령 재조회 없이 케이스 입력으로 사용
  --out-dir <dir>           batch-build 산출물 폴더
  --outputs svg,html,hwpx,json,audit,trace,pptx,deck|all  batch-build/review-pack 산출 형식(all은 케이스별 svg/html/hwpx/json/audit/trace/pptx)
  --deck <file.pptx>        batch-build 통합 PPTX deck 경로(--outputs deck 없이도 활성화)
  --artifact-dir <dir>      review-pack 내부 산출물 폴더(기본: <out-dir>/artifacts)
  --index-html-out <file>   review-pack HTML 첫 화면 파일명(기본: index.html)
  --gallery-html-out <file> review-pack SVG 미리보기 갤러리 파일명(기본: gallery.html)
  --sheets-html-out <file>  review-pack A4 2-up 인쇄 시트 파일명(기본: sheets.html)
  --triage-out <file>       review-pack 우선순위 CSV 파일명(기본: triage.csv)
  --suggested-cases-out <file> review-pack 자동 보강 케이스 파일명(기본: suggested-cases.json)
  --accepted-cases-out <file>  review-pack 점수 게이트 통과 케이스 파일명(기본: accepted-cases.json)
  --rerun-suggested         review-pack에서 suggested-cases.json을 바로 2차 실행
  --rerun-out-dir <dir>     2차 리뷰팩 폴더(기본: <out-dir>/rerun)
  --build-accepted          review-pack에서 accepted-cases.json 기반 최종 산출물을 바로 생성
  --accepted-out-dir <dir>  최종 채택 산출물 폴더(기본: <out-dir>/accepted)
  --accepted-outputs <list> 최종 채택 산출물 형식(기본: --outputs 값)
  --institutions "A,B"      make-cases/review-pack 기관명 목록(쉼표 또는 줄바꿈)
  --strict                  batch-audit에서 오류·수정 필요가 있으면 종료코드 2

cases.json 추가 필드
  "directives": ["@소관: 정책관 > 정책과ㆍ지원과"]  원문과 별도로 적용할 보강 지시문
`);
}
