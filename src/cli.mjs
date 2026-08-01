#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { applyAnnexOrganizations, attachAnnexes } from "./annex.mjs";
import { buildAuditReport, formatAuditMarkdown } from "./audit.mjs";
import { fetchLawAtDate } from "./law-api.mjs";
import { buildLawAppendixPages, enrichGraphWithLawMap } from "./law-map.mjs";
import { planLayoutVariants, planPages } from "./layout.mjs";
import { projectOperationalView, summarizeStructure } from "./model.mjs";
import { parseOrganizationTexts } from "./parser.mjs";
import { renderPptx } from "./render-pptx.mjs";
import { renderSvg } from "./render-svg.mjs";
import { ensureParent, jsonReplacer, parseArgs, readInputs, writeText } from "./utils.mjs";

const [command = "help", ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (command === "build") await buildCommand(args);
  else if (command === "from-law") await fromLawCommand(args);
  else if (command === "fetch") await fetchCommand(args);
  else if (command === "inspect") await inspectCommand(args);
  else if (command === "audit") await auditCommand(args);
  else printHelp();
} catch (error) {
  console.error(process.env.DEBUG ? error.stack : `오류: ${error.message}`);
  process.exitCode = 1;
}

async function buildCommand(args) {
  const graph = await graphFromInputs(args);
  await emitOutputs(graph, args);
}

async function fromLawCommand(args) {
  const graph = await graphFromLawArgs(args);
  await emitOutputs(graph, args);
}

async function graphFromLawArgs(args) {
  const date = required(args, "date");
  const names = [
    stringArg(args, "decree"),
    stringArg(args, "rule"),
    ...args.law.filter((value) => typeof value === "string"),
  ].filter(Boolean);
  if (!names.length) throw new Error("--decree 또는 --law로 법령명을 지정해야 합니다.");
  const fetched = [];
  for (const name of names) {
    fetched.push(await fetchLawAtDate(name, date, { oc: stringArg(args, "oc") }));
  }
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

async function emitOutputs(graph, args) {
  await enrichWithLawMapIfRequested(graph, args);
  const view = stringArg(args, "view") || "legal";
  if (!new Set(["legal", "operational"]).has(view)) {
    throw new Error(`--view는 legal 또는 operational이어야 합니다: ${view}`);
  }
  const displayGraph = view === "operational" ? projectOperationalView(graph) : graph;
  let pages = planRequestedPages(displayGraph, args);
  const lawAppendix = args["law-appendix"] === true;
  const showLawCounts = args["law-counts"] === true || lawAppendix;
  if (lawAppendix) {
    if (!graph.meta.lawMap) throw new Error("--law-appendix에는 --law-map <dept_map.json>이 필요합니다.");
    pages = renumberPages([...pages, ...buildLawAppendixPages(graph)]);
  }
  if (args.json) {
    await writeText(path.resolve(args.json), `${JSON.stringify(graph.toJSON(), jsonReplacer, 2)}\n`);
  }
  if (args.svg) {
    await writeText(path.resolve(args.svg), renderSvg(displayGraph, pages, { showLawCounts }));
  }
  if (args.out) {
    await ensureParent(args.out);
    await renderPptx(displayGraph, pages, path.resolve(args.out), {
      previewDir: stringArg(args, "preview-dir"),
      showLawCounts,
    });
  }
  if (!args.out && !args.svg && !args.json) {
    console.log(JSON.stringify(graph.toJSON(), jsonReplacer, 2));
  }
  console.log(JSON.stringify({ ...summarize(graph, pages), view }, null, 2));
}

function planRequestedPages(graph, args) {
  const layout = stringArg(args, "layout") || "auto";
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

function printHelp() {
  console.log(`
대한민국 행정기관 직제 문언 → 조직도

사용법
  node src/cli.mjs build \\
    --input 직제.txt --input 시행규칙.txt \\
    --date 2025-11-25 \\
    --out outputs/조직도.pptx \\
    --svg outputs/조직도.svg \\
    --json outputs/조직도.json

  node src/cli.mjs from-law \\
    --decree "행정안전부와 그 소속기관 직제" \\
    --rule "행정안전부와 그 소속기관 직제 시행규칙" \\
    --date 2025-11-25 \\
    --out outputs/행정안전부.pptx

명령
  build      로컬 텍스트를 파싱하여 PPTX/SVG/JSON 생성
  from-law   법제처 OPEN API에서 기준일 연혁을 찾아 바로 생성
  fetch      법령 문언만 로컬 텍스트로 저장
  inspect    파싱 결과 요약 출력
  audit      파싱·소관·별표·배치 품질 감사 리포트 출력

주요 옵션
  --layout auto|compact|split|vertical|horizontal|two-column|matrix|flow|change-lanes|affiliate-strip|catalog|all
  --layouts vertical,horizontal,two-column,matrix,flow,change-lanes,affiliate-strip,catalog  같은 문언을 여러 유형으로 한 번에 출력
  --paper slide|a4-portrait|a4-landscape|a4-half  출력 용지와 방향
  --focus <조직명>  해당 조직과 하위조직만 한 장으로 출력
  --view legal|operational  법정 설치형(기본) 또는 확인된 정책관·국 소관 묶음형
  --preview-dir <dir>       슬라이드 PNG·layout JSON·montage 생성
  --law-map <dept_map.json> 부서별 소관법령을 정확히 일치하는 조직 노드에 연결
  --law-map-date <YYYY-MM-DD>  소관법령 지도 기준일(기구도 기준일 불일치 경고용)
  --law-counts              소관법령이 연결된 조직 상자에 법령 수 배지 표시
  --law-appendix            PPTX·SVG 뒤에 부서별 소관법령 색인 부록 추가(--law-map 필요)
  --oc <인증값>             LAW_API_OC 환경변수로도 지정 가능
  --source-dir <dir>        조회한 기준일 법령 문언 보관
  --format markdown|json    audit 리포트 출력 형식
`);
}
