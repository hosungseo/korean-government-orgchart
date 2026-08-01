import path from "node:path";
import { formatBatchAuditMarkdown, loadBatchContext, runBatchAudit } from "./batch-audit.mjs";
import { formatBatchBuildMarkdown, runBatchBuild } from "./batch-build.mjs";
import { buildAuditCaseSpecs } from "./case-scaffold.mjs";
import { jsonReplacer, readInputs, writeText } from "./utils.mjs";

export async function runReviewPack(args = {}) {
  const outDir = path.resolve(stringArg(args, "out-dir") || "outputs/review-pack");
  const caseSpecs = await resolveReviewCases(args);
  const sharedLawFetchCache = args.lawFetchCache || new Map();
  const common = {
    ...args,
    caseSpecs,
    lawFetchCache: sharedLawFetchCache,
  };
  const artifactDir = path.resolve(stringArg(args, "artifact-dir") || path.join(outDir, "artifacts"));
  const deckPath = stringArg(args, "deck")
    ? path.resolve(stringArg(args, "deck"))
    : path.join(artifactDir, "review-deck.pptx");
  const outputs = stringArg(args, "outputs") || "svg,json,audit,pptx,deck";

  const audit = await runBatchAudit(common);
  const build = await runBatchBuild({
    ...common,
    "out-dir": artifactDir,
    outputs,
    deck: deckPath,
  });

  const files = {
    readme: path.join(outDir, stringArg(args, "readme-out") || "README.md"),
    cases: path.join(outDir, stringArg(args, "cases-out") || "cases.json"),
    audit: path.join(outDir, stringArg(args, "audit-out") || "audit.md"),
    auditJson: path.join(outDir, stringArg(args, "audit-json-out") || "audit.json"),
    manifest: path.join(outDir, stringArg(args, "manifest-out") || "manifest.md"),
    manifestJson: path.join(outDir, stringArg(args, "manifest-json-out") || "manifest.json"),
  };

  await writeText(files.cases, `${JSON.stringify({ cases: caseSpecs }, jsonReplacer, 2)}\n`);
  await writeText(files.audit, formatBatchAuditMarkdown(audit));
  await writeText(files.auditJson, `${JSON.stringify(audit, jsonReplacer, 2)}\n`);
  await writeText(files.manifest, formatBatchBuildMarkdown(build));
  await writeText(files.manifestJson, `${JSON.stringify(build, jsonReplacer, 2)}\n`);

  const result = {
    generatedAt: new Date().toISOString(),
    outDir,
    artifactDir,
    files,
    caseCount: caseSpecs.length,
    audit,
    build,
  };
  await writeText(files.readme, formatReviewPackMarkdown(result));
  return result;
}

export function formatReviewPackMarkdown(result) {
  const lines = [];
  const auditCounts = result.audit?.statusCounts || {};
  const buildCounts = result.build?.statusCounts || {};
  lines.push("# 조직도 검토팩");
  lines.push("");
  lines.push(`- 생성시각: ${result.generatedAt}`);
  lines.push(`- 케이스: ${result.caseCount}`);
  lines.push(
    `- 감사 상태: 사용 가능 ${auditCounts.ready || 0} · 검토 필요 ${auditCounts["needs-review"] || 0} · 수정 필요 ${auditCounts["needs-correction"] || 0} · 오류 ${auditCounts.error || 0}`,
  );
  lines.push(`- 산출 상태: 생성 ${buildCounts.built || 0} · 오류 ${buildCounts.error || 0}`);
  if (result.build?.decks?.length) {
    for (const deck of result.build.decks) {
      lines.push(`- 통합 PPTX deck(${deck.paper}): ${linkPath(result.outDir, deck.path)}`);
    }
  } else if (result.build?.deck) {
    lines.push(`- 통합 PPTX deck: ${linkPath(result.outDir, result.build.deck)}`);
  }
  if (result.build?.deckError) lines.push(`- 통합 deck 오류: ${result.build.deckError}`);
  lines.push("");

  lines.push("## 먼저 열 파일");
  lines.push("");
  lines.push(`- 감사 요약: ${linkPath(result.outDir, result.files.audit)}`);
  lines.push(`- 산출물 매니페스트: ${linkPath(result.outDir, result.files.manifest)}`);
  lines.push(`- 케이스 정의: ${linkPath(result.outDir, result.files.cases)}`);
  lines.push(`- 기계 판독용 감사 JSON: ${linkPath(result.outDir, result.files.auditJson)}`);
  lines.push(`- 기계 판독용 매니페스트 JSON: ${linkPath(result.outDir, result.files.manifestJson)}`);
  lines.push("");

  const topActions = topReviewActions(result.audit?.cases || []);
  lines.push("## 우선 확인");
  lines.push("");
  if (topActions.length) {
    for (const item of topActions) {
      lines.push(`- [${priorityLabel(item.priority)}] ${item.institution}: ${item.message}`);
    }
  } else {
    lines.push("- 높은·중간 우선순위 확인 항목이 없습니다. 산출물 deck을 열어 작도 품질만 육안 확인하세요.");
  }
  lines.push("");

  lines.push("## 케이스별 산출물");
  lines.push("");
  lines.push("| 기관 | 기준일 | 대상 | 상태 | 선택유형 | 확인 | 배치 | 품질 | 산출물 |");
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |");
  for (const item of result.audit?.cases || []) {
    const summary = item.summary || {};
    const built = findBuildCase(result.build?.cases || [], summary.id);
    const outputs = Object.entries(built?.outputs || {})
      .map(([kind, filePath]) => `${kind}: ${linkPath(result.outDir, filePath)}`)
      .join("<br>");
    const review = summary.reviewActions || {};
    lines.push(
      [
        escapeCell(summary.institution || summary.id || ""),
        escapeCell(summary.asOf || ""),
        escapeCell(summary.focus || summary.layout || ""),
        escapeCell(summary.statusLabel || summary.status || built?.statusLabel || built?.status || ""),
        escapeCell(selectedLayouts(summary)),
        `${review.high || 0}/${review.medium || 0}/${review.low || 0}`,
        summary.layoutDiagnostics?.totalIssues ?? "",
        summary.layoutDiagnostics?.qualityIssues ?? "",
        outputs || escapeCell(built?.error || item.error || ""),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push("> 확인 열은 `높음/중간/낮음` 우선순위 개수입니다. 배치 문제는 넘침·겹침·연결선 같은 hard issue, 품질은 간격·정렬·선교차·컬럼 균형 같은 polish issue입니다.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function resolveReviewCases(args) {
  if (args.caseSpecs) return args.caseSpecs;
  if (stringArg(args, "cases")) {
    const context = await loadBatchContext(args);
    return context.caseSpecs;
  }
  const inputInstitutions = args.input?.length ? await readInputs(args.input) : [];
  const institutions = [stringArg(args, "institutions"), stringArg(args, "institution"), ...inputInstitutions];
  return buildAuditCaseSpecs({
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
  }).cases;
}

function stringArg(args, key) {
  return typeof args[key] === "string" ? args[key] : undefined;
}

function topReviewActions(cases) {
  const weight = { high: 0, medium: 1, low: 2 };
  return cases
    .flatMap((item) =>
      (item.report?.reviewActions || []).map((action) => ({
        institution: item.summary?.institution || item.summary?.id || item.case?.id || "",
        ...action,
      })),
    )
    .filter((item) => item.priority === "high" || item.priority === "medium")
    .sort((a, b) => (weight[a.priority] ?? 9) - (weight[b.priority] ?? 9))
    .slice(0, 12);
}

function findBuildCase(cases, id) {
  return cases.find((item) => item.summary?.id === id || item.case?.id === id) || null;
}

function selectedLayouts(summary = {}) {
  return summary.layoutSelection?.selected?.length
    ? summary.layoutSelection.selected.join(", ")
    : summary.layout || "";
}

function priorityLabel(priority) {
  if (priority === "high") return "높음";
  if (priority === "medium") return "중간";
  return "낮음";
}

function linkPath(baseDir, filePath) {
  const relative = path.relative(baseDir, filePath).split(path.sep).join("/");
  return `[${relative || path.basename(filePath)}](${encodeURI(relative || path.basename(filePath))})`;
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
