import path from "node:path";
import { formatBatchAuditMarkdown, loadBatchContext, runBatchAudit } from "./batch-audit.mjs";
import { formatBatchBuildMarkdown, runBatchBuild } from "./batch-build.mjs";
import { buildAuditCaseSpecs, expandCaseSpecsByLayouts } from "./case-scaffold.mjs";
import { jsonReplacer, readInputs, writeText } from "./utils.mjs";

export async function runReviewPack(args = {}) {
  const outDir = path.resolve(stringArg(args, "out-dir") || "outputs/review-pack");
  const reviewContext = await resolveReviewContext(args);
  const caseSpecs = reviewContext.caseSpecs;
  const exportedCases = exportCaseSpecs(caseSpecs, {
    fromDir: reviewContext.casesBaseDir,
    outDir,
  });
  const sharedLawFetchCache = args.lawFetchCache || new Map();
  const common = {
    ...args,
    caseSpecs,
    caseSpecsExpanded: true,
    lawFetchCache: sharedLawFetchCache,
  };
  const artifactDir = path.resolve(stringArg(args, "artifact-dir") || path.join(outDir, "artifacts"));
  const deckPath = stringArg(args, "deck")
    ? path.resolve(stringArg(args, "deck"))
    : path.join(artifactDir, "review-deck.pptx");
  const outputs = stringArg(args, "outputs") || "svg,html,json,audit,trace,pptx,deck";

  const audit = await runBatchAudit(common);
  const build = await runBatchBuild({
    ...common,
    "out-dir": artifactDir,
    outputs,
    deck: deckPath,
  });

  const files = {
    indexHtml: path.join(outDir, stringArg(args, "index-html-out") || "index.html"),
    galleryHtml: path.join(outDir, stringArg(args, "gallery-html-out") || "gallery.html"),
    sheetsHtml: path.join(outDir, stringArg(args, "sheets-html-out") || "sheets.html"),
    readme: path.join(outDir, stringArg(args, "readme-out") || "README.md"),
    worklist: path.join(outDir, stringArg(args, "worklist-out") || "worklist.md"),
    triageCsv: path.join(outDir, stringArg(args, "triage-out") || "triage.csv"),
    cases: path.join(outDir, stringArg(args, "cases-out") || "cases.json"),
    suggestedCases: path.join(outDir, stringArg(args, "suggested-cases-out") || "suggested-cases.json"),
    acceptedCases: path.join(outDir, stringArg(args, "accepted-cases-out") || "accepted-cases.json"),
    audit: path.join(outDir, stringArg(args, "audit-out") || "audit.md"),
    auditJson: path.join(outDir, stringArg(args, "audit-json-out") || "audit.json"),
    manifest: path.join(outDir, stringArg(args, "manifest-out") || "manifest.md"),
    manifestJson: path.join(outDir, stringArg(args, "manifest-json-out") || "manifest.json"),
  };

  await writeText(files.cases, `${JSON.stringify({ cases: exportedCases }, jsonReplacer, 2)}\n`);
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
    exportedCases,
    audit,
    build,
  };
  result.suggestedCases = buildSuggestedCasesDocument(result);
  await writeText(files.suggestedCases, `${JSON.stringify(result.suggestedCases, jsonReplacer, 2)}\n`);
  if (args["rerun-suggested"] === true) {
    result.rerun = await runSuggestedReviewPack(result, args, sharedLawFetchCache);
  }
  result.acceptedCases = buildAcceptedCasesDocument(result);
  await writeText(files.acceptedCases, `${JSON.stringify(result.acceptedCases, jsonReplacer, 2)}\n`);
  if (args["build-accepted"] === true) {
    result.acceptedBuild = await runAcceptedBuild(result, args, sharedLawFetchCache);
  }
  await writeText(files.triageCsv, formatReviewTriageCsv(result));
  await writeText(files.worklist, formatReviewWorklistMarkdown(result));
  await writeText(files.readme, formatReviewPackMarkdown(result));
  await writeText(files.galleryHtml, formatReviewGalleryHtml(result));
  await writeText(files.sheetsHtml, formatReviewSheetsHtml(result));
  await writeText(files.indexHtml, formatReviewPackHtml(result));
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
  lines.push(`- HTML 첫 화면: ${linkPath(result.outDir, result.files.indexHtml)}`);
  lines.push(`- 시각 갤러리: ${linkPath(result.outDir, result.files.galleryHtml)}`);
  lines.push(`- A4 2-up 인쇄 시트: ${linkPath(result.outDir, result.files.sheetsHtml)}`);
  lines.push(`- 우선순위 CSV: ${linkPath(result.outDir, result.files.triageCsv)}`);
  lines.push(`- 검토 작업목록: ${linkPath(result.outDir, result.files.worklist)}`);
  lines.push(`- 감사 요약: ${linkPath(result.outDir, result.files.audit)}`);
  lines.push(`- 산출물 매니페스트: ${linkPath(result.outDir, result.files.manifest)}`);
  lines.push(`- 케이스 정의: ${linkPath(result.outDir, result.files.cases)}`);
  lines.push(`- 자동 보강 케이스 후보: ${linkPath(result.outDir, result.files.suggestedCases)}`);
  lines.push(`- 채택 케이스: ${linkPath(result.outDir, result.files.acceptedCases)}`);
  lines.push(`- 기계 판독용 감사 JSON: ${linkPath(result.outDir, result.files.auditJson)}`);
  lines.push(`- 기계 판독용 매니페스트 JSON: ${linkPath(result.outDir, result.files.manifestJson)}`);
  lines.push("");

  appendRerunSection(lines, result);
  appendAcceptedBuildSection(lines, result);

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
  lines.push("> 확인 열은 `높음/중간/낮음` 우선순위 개수입니다. 배치 문제는 넘침·겹침·연결선 같은 hard issue, 품질은 간격·정렬·선교차·선-상자 관통·과도한 선 우회·컬럼 균형·세로글자 폭 같은 polish issue입니다.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function formatReviewPackHtml(result) {
  const auditCounts = result.audit?.statusCounts || {};
  const buildCounts = result.build?.statusCounts || {};
  const title = "조직도 검토팩";
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root { --ink:#111827; --muted:#6B7280; --rule:#D1D5DB; --soft:#F3F4F6; --paper:#FFFFFF; --accent:#315A8A; }
    * { box-sizing: border-box; }
    body { margin:0; background:#E5E7EB; color:var(--ink); font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif; line-height:1.48; }
    main { max-width:1180px; margin:18px auto; padding:24px; background:var(--paper); box-shadow:0 4px 18px rgba(15,23,42,.12); }
    h1 { margin:0; font-size:28px; letter-spacing:-.02em; }
    h2 { margin:28px 0 10px; font-size:18px; border-bottom:1px solid var(--rule); padding-bottom:7px; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--rule); border-radius:999px; padding:3px 9px; background:#fff; }
    .quick { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; margin-top:12px; }
    .card { border:1px solid var(--rule); border-radius:8px; padding:12px; background:#FAFAFA; }
    .card strong { display:block; margin-bottom:4px; }
    table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
    th,td { border:1px solid var(--rule); padding:7px 8px; vertical-align:top; text-align:left; }
    th { background:var(--soft); font-weight:700; }
    .num { text-align:right; white-space:nowrap; }
    .outputs a { display:inline-block; margin:0 6px 4px 0; }
    .primary { font-weight:700; }
    .muted { color:var(--muted); }
    .warn { color:#92400E; }
    @media print {
      body { background:white; }
      main { margin:0; max-width:none; box-shadow:none; padding:0; }
      .quick,.card,table { break-inside:avoid; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>${htmlEscape(title)}</h1>
    <div class="meta">
      <span class="pill">생성시각 ${htmlEscape(result.generatedAt || "")}</span>
      <span class="pill">케이스 ${result.caseCount || 0}</span>
      <span class="pill">감사: 사용 가능 ${auditCounts.ready || 0} · 검토 필요 ${auditCounts["needs-review"] || 0} · 수정 필요 ${auditCounts["needs-correction"] || 0} · 오류 ${auditCounts.error || 0}</span>
      <span class="pill">산출: 생성 ${buildCounts.built || 0} · 오류 ${buildCounts.error || 0}</span>
    </div>
  </header>

  <section>
    <h2>먼저 열 파일</h2>
    <div class="quick">
      ${quickLink(result, "검토 작업목록", result.files?.worklist, "보강 지시문 후보와 재시도 항목")}
      ${quickLink(result, "시각 갤러리", result.files?.galleryHtml, "SVG 미리보기와 품질지표를 한 화면에서 비교")}
      ${quickLink(result, "A4 2-up 인쇄 시트", result.files?.sheetsHtml, "a4-half SVG를 좌우 두 칸으로 배치한 검토서 붙여넣기용 시트")}
      ${quickLink(result, "우선순위 CSV", result.files?.triageCsv, "엑셀·시트에서 여는 케이스별 점검 순서")}
      ${quickLink(result, "감사 요약", result.files?.audit, "파싱·소관·별표·배치 품질")}
      ${quickLink(result, "산출물 매니페스트", result.files?.manifest, "케이스별 산출물 링크")}
      ${quickLink(result, "케이스 정의", result.files?.cases, "재실행 가능한 입력 목록")}
      ${quickLink(result, "자동 보강 후보", result.files?.suggestedCases, "suggested-cases.json")}
      ${quickLink(result, "채택 케이스", result.files?.acceptedCases, "accepted-cases.json")}
    </div>
  </section>

  ${htmlDeckSection(result)}
  ${htmlRerunSection(result)}
  ${htmlAcceptedSection(result)}
  ${htmlTopActionsSection(result)}
  ${htmlCasesSection(result)}
</main>
</body>
</html>
`;
}

export function formatReviewGalleryHtml(result) {
  const title = "조직도 시각 갤러리";
  const cards = reviewGalleryCards(result);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root { --ink:#111827; --muted:#6B7280; --rule:#D1D5DB; --soft:#F3F4F6; --paper:#FFFFFF; --accent:#315A8A; --bad:#B91C1C; --warn:#92400E; --ok:#166534; }
    * { box-sizing:border-box; }
    body { margin:0; background:#E5E7EB; color:var(--ink); font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif; line-height:1.45; }
    main { max-width:1440px; margin:18px auto; padding:22px; background:var(--paper); box-shadow:0 4px 18px rgba(15,23,42,.12); }
    header { display:flex; gap:12px; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; border-bottom:2px solid var(--ink); padding-bottom:12px; }
    h1 { margin:0; font-size:27px; letter-spacing:-.02em; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--rule); border-radius:999px; padding:3px 9px; background:#fff; white-space:nowrap; }
    .toolbar { display:flex; flex-wrap:wrap; gap:8px; font-size:13px; }
    .toolbar a { border:1px solid var(--rule); border-radius:6px; padding:5px 9px; background:#FAFAFA; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px; margin-top:18px; }
    .case { border:1px solid var(--rule); border-radius:10px; overflow:hidden; background:#FAFAFA; break-inside:avoid; }
    .case-head { padding:12px 13px 10px; background:#fff; border-bottom:1px solid var(--rule); }
    .case h2 { margin:0; font-size:17px; }
    .subtitle { margin-top:4px; color:var(--muted); font-size:12.5px; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; padding:10px 13px; background:#F9FAFB; border-bottom:1px solid var(--rule); font-size:12px; }
    .metric { border:1px solid var(--rule); border-radius:6px; background:#fff; padding:6px; min-height:45px; }
    .metric strong { display:block; font-size:15px; }
    .metric .label { color:var(--muted); font-size:11px; }
    .metric.bad strong { color:var(--bad); }
    .metric.warn strong { color:var(--warn); }
    .metric.ok strong { color:var(--ok); }
    .preview { height:520px; background:white; display:flex; align-items:flex-start; justify-content:center; padding:10px; overflow:auto; border-bottom:1px solid var(--rule); }
    .preview img { max-width:100%; height:auto; border:1px solid #EEF0F3; background:white; }
    .placeholder { color:var(--muted); padding:40px 12px; text-align:center; }
    .links { padding:10px 13px 12px; font-size:12.5px; }
    .links a { display:inline-block; margin:0 8px 6px 0; }
    .best { padding:0 13px 12px; color:var(--muted); font-size:12px; }
    .best code { color:var(--ink); background:#EEF2F7; border-radius:4px; padding:1px 4px; }
    @media print {
      body { background:white; }
      main { margin:0; max-width:none; box-shadow:none; padding:0; }
      .grid { grid-template-columns:repeat(2,1fr); gap:10px; }
      .preview { height:360px; }
      .toolbar { display:none; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${htmlEscape(title)}</h1>
      <div class="meta">
        <span class="pill">생성시각 ${htmlEscape(result.generatedAt || "")}</span>
        <span class="pill">케이스 ${result.caseCount || 0}</span>
        <span class="pill">SVG 미리보기 ${cards.filter((card) => card.outputs.svg).length}/${cards.length}</span>
      </div>
    </div>
    <nav class="toolbar">
      ${result.files?.indexHtml ? `<a href="${htmlAttr(hrefPath(result.outDir, result.files.indexHtml))}">검토팩 첫 화면</a>` : ""}
      ${result.files?.triageCsv ? `<a href="${htmlAttr(hrefPath(result.outDir, result.files.triageCsv))}">우선순위 CSV</a>` : ""}
      ${result.files?.worklist ? `<a href="${htmlAttr(hrefPath(result.outDir, result.files.worklist))}">작업목록</a>` : ""}
      ${result.files?.manifest ? `<a href="${htmlAttr(hrefPath(result.outDir, result.files.manifest))}">매니페스트</a>` : ""}
    </nav>
  </header>
  <section class="grid">
    ${cards.map((card) => galleryCardHtml(result.outDir, card)).join("") || `<p class="placeholder">표시할 산출물이 없습니다.</p>`}
  </section>
</main>
</body>
</html>
`;
}

export function formatReviewSheetsHtml(result) {
  const title = "A4 조직도 2-up 인쇄 시트";
  const sheets = reviewPrintSheets(result);
  const itemCount = sheets.reduce((sum, sheet) => sum + sheet.items.filter(Boolean).length, 0);
  const halfSheets = sheets.filter((sheet) => sheet.kind === "two-up").length;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root { --ink:#111827; --muted:#6B7280; --rule:#D1D5DB; --paper:#FFFFFF; --soft:#F9FAFB; --accent:#315A8A; }
    * { box-sizing:border-box; }
    @page { size:A4 portrait; margin:0; }
    body { margin:0; background:#E5E7EB; color:var(--ink); font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif; line-height:1.35; }
    header { max-width:210mm; margin:14px auto 10px; padding:12px 14px; background:var(--paper); border:1px solid var(--rule); }
    h1 { margin:0; font-size:22px; letter-spacing:-.02em; }
    a { color:var(--accent); text-decoration:none; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; color:var(--muted); font-size:12px; }
    .pill { border:1px solid var(--rule); border-radius:999px; padding:3px 8px; background:#fff; }
    .sheet { width:210mm; min-height:297mm; margin:12px auto; padding:7mm; background:var(--paper); box-shadow:0 4px 18px rgba(15,23,42,.13); page-break-after:always; break-after:page; display:grid; gap:4mm; }
    .sheet.two-up { grid-template-columns:1fr 1fr; }
    .sheet.full { grid-template-columns:1fr; }
    .slot { border:1px solid var(--rule); background:#fff; min-width:0; min-height:0; padding:2.5mm; display:flex; flex-direction:column; overflow:hidden; }
    .slot.empty { border-style:dashed; background:var(--soft); color:var(--muted); align-items:center; justify-content:center; text-align:center; font-size:12px; }
    .slot-title { font-size:10.5px; font-weight:700; margin-bottom:1.8mm; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .slot-meta { font-size:9.2px; color:var(--muted); margin-bottom:2mm; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .figure { flex:1; min-height:0; display:flex; align-items:flex-start; justify-content:center; overflow:hidden; }
    .figure img { max-width:100%; max-height:100%; object-fit:contain; border:1px solid #EEF0F3; background:white; }
    .links { margin-top:1.7mm; font-size:9.4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .links a { margin-right:5px; }
    @media print {
      body { background:white; }
      header { display:none; }
      .sheet { margin:0; box-shadow:none; border:0; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${htmlEscape(title)}</h1>
    <div class="meta">
      <span class="pill">생성시각 ${htmlEscape(result.generatedAt || "")}</span>
      <span class="pill">SVG ${itemCount}건</span>
      <span class="pill">A4 2-up ${halfSheets}쪽</span>
      ${result.files?.indexHtml ? `<span class="pill"><a href="${htmlAttr(hrefPath(result.outDir, result.files.indexHtml))}">검토팩 첫 화면</a></span>` : ""}
      ${result.files?.galleryHtml ? `<span class="pill"><a href="${htmlAttr(hrefPath(result.outDir, result.files.galleryHtml))}">시각 갤러리</a></span>` : ""}
    </div>
  </header>
  ${sheets.map((sheet, index) => reviewPrintSheetHtml(result.outDir, sheet, index)).join("") || `<section class="sheet full"><div class="slot empty">SVG 산출물이 없습니다.<br>review-pack outputs에 svg를 포함하세요.</div></section>`}
</body>
</html>
`;
}

function reviewPrintSheets(result) {
  const items = reviewSheetItems(result);
  const sheets = [];
  let half = [];
  const flushHalf = () => {
    if (!half.length) return;
    sheets.push({ kind: "two-up", items: half.length === 1 ? [half[0], null] : half });
    half = [];
  };
  for (const item of items) {
    if (item.paper === "a4-half") {
      half.push(item);
      if (half.length === 2) flushHalf();
    } else {
      flushHalf();
      sheets.push({ kind: "full", items: [item] });
    }
  }
  flushHalf();
  return sheets;
}

function reviewSheetItems(result) {
  return (result.audit?.cases || [])
    .map((item) => {
      const summary = item.summary || {};
      const built = findBuildCase(result.build?.cases || [], summary.id) || {};
      if (!built.outputs?.svg) return null;
      return {
        summary,
        outputs: built.outputs || {},
        paper: summary.paper || "slide",
      };
    })
    .filter(Boolean);
}

function reviewPrintSheetHtml(baseDir, sheet, index) {
  return `<section class="sheet ${sheet.kind}" aria-label="A4 sheet ${index + 1}">
    ${sheet.items.map((item) => item ? reviewPrintSlotHtml(baseDir, item) : `<div class="slot empty">빈 반쪽면<br>다음 조직도를 추가해 2-up으로 배치할 수 있습니다.</div>`).join("")}
  </section>`;
}

function reviewPrintSlotHtml(baseDir, item) {
  const summary = item.summary || {};
  const label = [summary.institution || summary.id || "조직도", summary.asOf].filter(Boolean).join(" · ");
  const target = [summary.focus || summary.layout, selectedLayouts(summary)].filter(Boolean).join(" · ");
  return `<div class="slot">
    <div class="slot-title">${htmlEscape(label)}</div>
    <div class="slot-meta">${htmlEscape(target || item.paper || "")}</div>
    <div class="figure"><img src="${htmlAttr(hrefPath(baseDir, item.outputs.svg))}" alt="${htmlAttr(label)}" loading="lazy" /></div>
    <div class="links">${outputLinksHtml(baseDir, item.outputs)}</div>
  </div>`;
}

function reviewGalleryCards(result) {
  return (result.audit?.cases || []).map((item) => {
    const summary = item.summary || {};
    const built = findBuildCase(result.build?.cases || [], summary.id) || {};
    return {
      summary,
      outputs: built.outputs || {},
      buildStatus: built.statusLabel || built.status || "",
      error: built.error || item.error || "",
    };
  });
}

function galleryCardHtml(baseDir, card) {
  const summary = card.summary || {};
  const diagnostics = summary.layoutDiagnostics || {};
  const bestCandidates = summary.layoutSelection?.bestFit?.candidateScores?.slice(0, 3) || [];
  const selectionReason = summary.layoutSelection?.bestFit?.selectionReason || "";
  return `<article class="case">
    <div class="case-head">
      <h2>${htmlEscape(summary.institution || summary.id || "케이스")}</h2>
      <div class="subtitle">${htmlEscape([summary.asOf, summary.focus || summary.layout, selectedLayouts(summary)].filter(Boolean).join(" · "))}</div>
    </div>
    <div class="metrics">
      ${galleryMetric("상태", summary.statusLabel || summary.status || card.buildStatus || "", metricClass(diagnostics.totalIssues || 0, diagnostics.qualityIssues || 0))}
      ${galleryMetric("페이지", summary.pages ?? "", "")}
      ${galleryMetric("배치 hard", diagnostics.totalIssues ?? 0, diagnostics.totalIssues ? "bad" : "ok")}
      ${galleryMetric("작도 polish", diagnostics.qualityIssues ?? 0, diagnostics.qualityIssues ? "warn" : "ok")}
    </div>
    <div class="preview">
      ${card.outputs.svg ? `<a href="${htmlAttr(hrefPath(baseDir, card.outputs.svg))}"><img src="${htmlAttr(hrefPath(baseDir, card.outputs.svg))}" alt="${htmlAttr(summary.institution || summary.id || "조직도 SVG")}" loading="lazy" /></a>` : `<div class="placeholder">${htmlEscape(card.error || "SVG 산출물이 없습니다.")}</div>`}
    </div>
    <div class="links">${outputLinksHtml(baseDir, card.outputs)}</div>
    ${selectionReason ? `<div class="best reason">선택 사유: ${htmlEscape(selectionReason)}</div>` : ""}
    ${bestCandidates.length ? `<div class="best">best-fit 후보: ${bestCandidates.map((candidate) => {
      const diag = candidate.diagnostics || {};
      const maxNodes = candidate.maxNodes ? `/${candidate.maxNodes}` : "";
      return `<code>${htmlEscape(candidate.style)}${htmlEscape(maxNodes)} 점수 ${htmlEscape(candidate.score)} 문제 ${htmlEscape(diag.totalIssues || 0)} 품질 ${htmlEscape(diag.qualityIssues || 0)}</code>`;
    }).join(" ")}</div>` : ""}
  </article>`;
}

function galleryMetric(label, value, className) {
  return `<div class="metric ${htmlAttr(className || "")}"><span class="label">${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong></div>`;
}

function metricClass(hard, quality) {
  if (hard) return "bad";
  if (quality) return "warn";
  return "ok";
}

function quickLink(result, label, filePath, description) {
  if (!filePath) return "";
  return `<div class="card"><strong><a href="${htmlAttr(hrefPath(result.outDir, filePath))}">${htmlEscape(label)}</a></strong><span class="muted">${htmlEscape(description)}</span></div>`;
}

function htmlDeckSection(result) {
  const decks = result.build?.decks || [];
  if (!decks.length && !result.build?.deck && !result.build?.deckError) return "";
  const rows = [];
  for (const deck of decks) {
    rows.push(`<tr><td>${htmlEscape(deck.paper)}</td><td><a href="${htmlAttr(hrefPath(result.outDir, deck.path))}">${htmlEscape(path.basename(deck.path))}</a></td><td class="num">${deck.pages || 0}</td></tr>`);
  }
  if (result.build?.deck) {
    rows.push(`<tr><td>deck</td><td><a href="${htmlAttr(hrefPath(result.outDir, result.build.deck))}">${htmlEscape(path.basename(result.build.deck))}</a></td><td class="num">-</td></tr>`);
  }
  return `<section>
  <h2>통합 PPTX deck</h2>
  ${result.build?.deckError ? `<p class="warn">통합 deck 오류: ${htmlEscape(result.build.deckError)}</p>` : ""}
  <table><thead><tr><th>용지</th><th>파일</th><th>페이지</th></tr></thead><tbody>${rows.join("")}</tbody></table>
</section>`;
}

function htmlRerunSection(result) {
  if (!result.rerun) return "";
  if (result.rerun.skipped) {
    return `<section><h2>자동 보강 재실행</h2><p class="muted">생략: ${htmlEscape(result.rerun.reason)}</p></section>`;
  }
  const rerunEntry = result.rerun.files?.indexHtml || result.rerun.files?.readme || result.rerun.outDir;
  const rows = comparisonRows(result.rerun.comparison)
    .map((row) => `<tr><td>${htmlEscape(row.label)}</td><td class="num">${row.before}</td><td class="num">${row.after}</td><td class="num">${htmlEscape(formatDelta(row.delta))}</td></tr>`)
    .join("");
  return `<section>
  <h2>자동 보강 재실행</h2>
  <p>2차 리뷰팩: <a href="${htmlAttr(hrefPath(result.outDir, rerunEntry))}">${htmlEscape(hrefPath(result.outDir, rerunEntry))}</a> · 적용 ${result.rerun.changedCases || 0}/${result.caseCount || 0}건</p>
  <table><thead><tr><th>지표</th><th>1차</th><th>2차</th><th>변화</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
}

function htmlAcceptedSection(result) {
  if (!result.acceptedBuild) return "";
  if (result.acceptedBuild.skipped) {
    return `<section><h2>최종 채택 산출물</h2><p class="muted">생략: ${htmlEscape(result.acceptedBuild.reason)}</p></section>`;
  }
  const deckLinks = (result.acceptedBuild.build?.decks || [])
    .map((deck) => `<a href="${htmlAttr(hrefPath(result.outDir, deck.path))}">${htmlEscape(path.basename(deck.path))}</a>`)
    .join(" · ");
  return `<section>
  <h2>최종 채택 산출물</h2>
  <p>폴더: <a href="${htmlAttr(hrefPath(result.outDir, result.acceptedBuild.outDir))}">${htmlEscape(hrefPath(result.outDir, result.acceptedBuild.outDir))}</a></p>
  <p>케이스: 채택 ${result.acceptedBuild.acceptedCases || 0} · 거절 ${result.acceptedBuild.rejectedCases || 0} · 유지 ${result.acceptedBuild.unchangedCases || 0}</p>
  ${deckLinks ? `<p>최종 deck: ${deckLinks}</p>` : ""}
</section>`;
}

function htmlTopActionsSection(result) {
  const actions = topReviewActions(result.audit?.cases || []);
  if (!actions.length) {
    return `<section><h2>우선 확인</h2><p class="muted">높은·중간 우선순위 확인 항목이 없습니다. 산출물 deck과 HTML 검토시트를 열어 작도 품질만 육안 확인하세요.</p></section>`;
  }
  return `<section>
  <h2>우선 확인</h2>
  <ul>${actions.map((item) => `<li><strong>[${htmlEscape(priorityLabel(item.priority))}] ${htmlEscape(item.institution)}</strong>: ${htmlEscape(item.message)}</li>`).join("")}</ul>
</section>`;
}

function htmlCasesSection(result) {
  const rows = (result.audit?.cases || []).map((item) => {
    const summary = item.summary || {};
    const built = findBuildCase(result.build?.cases || [], summary.id);
    const review = summary.reviewActions || {};
    return `<tr>
      <td>${htmlEscape(summary.institution || summary.id || "")}</td>
      <td>${htmlEscape(summary.asOf || "")}</td>
      <td>${htmlEscape(summary.focus || summary.layout || "")}</td>
      <td>${htmlEscape(summary.statusLabel || summary.status || built?.statusLabel || built?.status || "")}</td>
      <td>${htmlEscape(selectedLayouts(summary))}</td>
      <td>${review.high || 0}/${review.medium || 0}/${review.low || 0}</td>
      <td class="num">${summary.layoutDiagnostics?.totalIssues ?? ""}</td>
      <td class="num">${summary.layoutDiagnostics?.qualityIssues ?? ""}</td>
      <td class="outputs">${outputLinksHtml(result.outDir, built?.outputs || {}) || htmlEscape(built?.error || item.error || "")}</td>
    </tr>`;
  });
  return `<section>
  <h2>케이스별 산출물</h2>
  <table>
    <thead><tr><th>기관</th><th>기준일</th><th>대상</th><th>상태</th><th>선택유형</th><th>확인</th><th>배치</th><th>품질</th><th>산출물</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <p class="muted">` + "html" + ` 링크는 한글/HWPX 붙여넣기용 검토시트입니다.</p>
</section>`;
}

function outputLinksHtml(baseDir, outputs) {
  const order = ["html", "pptx", "svg", "json", "audit", "trace"];
  return order
    .filter((kind) => outputs[kind])
    .map((kind) => `<a class="${kind === "html" ? "primary" : ""}" href="${htmlAttr(hrefPath(baseDir, outputs[kind]))}">${htmlEscape(kind)}</a>`)
    .join(" ");
}

export function formatReviewWorklistMarkdown(result) {
  const lines = [];
  const suggested = result.suggestedCases || buildSuggestedCasesDocument(result);
  lines.push("# 조직도 검토 작업목록");
  lines.push("");
  lines.push(`- 생성시각: ${result.generatedAt}`);
  lines.push(`- 케이스: ${result.caseCount}`);
  if (result.files?.suggestedCases) {
    lines.push(`- 자동 보강 케이스 후보: ${linkPath(result.outDir, result.files.suggestedCases)} (${suggested.changedCases}/${suggested.cases.length}건 보강)`);
  }
  if (result.files?.acceptedCases && result.acceptedCases) {
    lines.push(`- 채택 케이스: ${linkPath(result.outDir, result.files.acceptedCases)} (채택 ${result.acceptedCases.acceptedCases || 0} · 거절 ${result.acceptedCases.rejectedCases || 0})`);
  }
  if (result.rerun?.outDir) {
    lines.push(`- 자동 보강 재실행: ${linkPath(result.outDir, result.rerun.outDir)}`);
  } else if (result.rerun?.skipped) {
    lines.push(`- 자동 보강 재실행: 생략(${result.rerun.reason})`);
  }
  if (result.acceptedBuild?.outDir) {
    lines.push(`- 최종 채택 산출물: ${linkPath(result.outDir, result.acceptedBuild.outDir)}`);
  } else if (result.acceptedBuild?.skipped) {
    lines.push(`- 최종 채택 산출물: 생략(${result.acceptedBuild.reason})`);
  }
  lines.push("");

  const directiveDrafts = collectDirectiveDrafts(result.audit?.cases || []);
  lines.push("## 입력에 붙여넣을 보강 지시문 후보");
  lines.push("");
  if (directiveDrafts.length) {
    for (const group of directiveDrafts) {
      lines.push(`### ${group.caseLabel}`);
      lines.push("");
      lines.push("```text");
      for (const directive of group.directives) lines.push(directive);
      lines.push("```");
      lines.push("");
      lines.push("- 적용 전 시행규칙 분장사무 또는 공식 조직표로 확인하세요. 이 지시문은 법정 설치관계를 바꾸지 않고 운영상 소관 묶음만 보강합니다.");
      lines.push("");
    }
  } else {
    lines.push("- 자동 제안 가능한 `@소관` 지시문 후보가 없습니다.");
    lines.push("");
  }

  const unresolved = collectUnresolvedJurisdictions(result.audit?.cases || []);
  lines.push("## 소관 대조 필요");
  lines.push("");
  if (unresolved.length) {
    for (const item of unresolved) {
      lines.push(`- ${item.caseLabel}: ${item.message}`);
    }
  } else {
    lines.push("- 단일 보좌기관 범위로 확정되지 않은 소관 대조 항목이 없습니다.");
  }
  lines.push("");

  const annexes = collectMissingAnnexes(result.audit?.cases || []);
  lines.push("## 별표 확보·반영 확인");
  lines.push("");
  if (annexes.length) {
    for (const item of annexes) {
      lines.push(`- ${item.caseLabel}: ${item.annex} — ${item.description} (${item.source || "출처 미상"})`);
    }
  } else {
    lines.push("- 미확보 별표 요구가 없습니다.");
  }
  lines.push("");

  const layoutRetries = collectLayoutRetries(result.audit?.cases || []);
  lines.push("## 레이아웃 재시도");
  lines.push("");
  if (layoutRetries.length) {
    for (const item of layoutRetries) {
      lines.push(`- ${item.caseLabel}: ${item.message}`);
      if (item.casePatch) {
        lines.push("  - cases.json 보정 예:");
        lines.push(`    \`${item.casePatch}\``);
      }
    }
  } else {
    lines.push("- hard 배치 문제 또는 주요 polish 문제가 없습니다.");
  }
  lines.push("");

  const lawMapItems = collectLawMapIssues(result.audit?.cases || []);
  lines.push("## 소관법령 지도 매칭");
  lines.push("");
  if (lawMapItems.length) {
    for (const item of lawMapItems) {
      lines.push(`- ${item.caseLabel}: ${item.message}`);
    }
  } else {
    lines.push("- 소관법령 지도 미매칭·중복 후보 문제가 없습니다.");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function formatReviewTriageCsv(result) {
  const header = [
    "순위",
    "위험점수",
    "위험수준",
    "기관",
    "기준일",
    "대상",
    "상태",
    "산출상태",
    "확인_높음",
    "확인_중간",
    "확인_낮음",
    "배치문제",
    "품질문제",
    "별표누락",
    "소관후보",
    "소관법령_미매칭",
    "소관법령_중복후보",
    "첫확인사항",
    "HTML",
    "PPTX",
    "감사MD",
    "TraceCSV",
  ];
  const rows = reviewTriageRows(result).map((row, index) => [
    index + 1,
    row.riskScore,
    row.riskLevel,
    row.institution,
    row.asOf,
    row.target,
    row.auditStatus,
    row.buildStatus,
    row.high,
    row.medium,
    row.low,
    row.layoutIssues,
    row.qualityIssues,
    row.missingAnnexes,
    row.jurisdictionCandidates,
    row.lawMapUnmatched,
    row.lawMapAmbiguous,
    row.firstAction,
    row.html,
    row.pptx,
    row.audit,
    row.trace,
  ]);
  return `${[header, ...rows].map((columns) => columns.map(csvEscape).join(",")).join("\n")}\n`;
}

function reviewTriageRows(result) {
  return (result.audit?.cases || []).map((item) => {
    const summary = item.summary || {};
    const built = findBuildCase(result.build?.cases || [], summary.id);
    const metrics = caseMetrics(summary);
    const buildPenalty = built?.status === "error" ? 1000 : 0;
    const riskScore = scoreMetrics(metrics) + buildPenalty;
    const firstAction = firstReviewAction(item.report?.reviewActions || []);
    return {
      riskScore,
      riskLevel: riskLevel(riskScore, summary.status, built?.status),
      institution: summary.institution || summary.id || "",
      asOf: summary.asOf || "",
      target: summary.focus || summary.layout || "",
      auditStatus: summary.statusLabel || summary.status || "",
      buildStatus: built?.statusLabel || built?.status || "",
      high: metrics.high,
      medium: metrics.medium,
      low: metrics.low,
      layoutIssues: metrics.layoutIssues,
      qualityIssues: metrics.qualityIssues,
      missingAnnexes: metrics.missingAnnexes,
      jurisdictionCandidates: metrics.jurisdictionCandidates,
      lawMapUnmatched: metrics.lawMapUnmatched,
      lawMapAmbiguous: metrics.lawMapAmbiguous,
      firstAction,
      html: relativeFilePath(result.outDir, built?.outputs?.html),
      pptx: relativeFilePath(result.outDir, built?.outputs?.pptx),
      audit: relativeFilePath(result.outDir, built?.outputs?.audit),
      trace: relativeFilePath(result.outDir, built?.outputs?.trace),
    };
  }).sort((a, b) =>
    b.riskScore - a.riskScore ||
    a.institution.localeCompare(b.institution, "ko") ||
    a.target.localeCompare(b.target, "ko"),
  );
}

function firstReviewAction(actions) {
  const weight = { high: 0, medium: 1, low: 2 };
  return [...actions]
    .sort((a, b) => (weight[a.priority] ?? 9) - (weight[b.priority] ?? 9))
    .map((action) => `[${priorityLabel(action.priority)}] ${action.message}`)
    .find(Boolean) || "";
}

function riskLevel(score, auditStatus, buildStatus) {
  if (buildStatus === "error" || auditStatus === "error" || auditStatus === "needs-correction" || score >= 1000) return "높음";
  if (auditStatus === "needs-review" || score >= 300) return "중간";
  if (score > 0) return "낮음";
  return "정상";
}

async function runSuggestedReviewPack(result, args, sharedLawFetchCache) {
  const suggested = result.suggestedCases || buildSuggestedCasesDocument(result);
  if (!suggested.changedCases) {
    return {
      skipped: true,
      reason: "자동 반영 가능한 보강안이 없습니다.",
      changedCases: 0,
    };
  }
  const rerunOutDir = path.resolve(stringArg(args, "rerun-out-dir") || path.join(result.outDir, "rerun"));
  const rerunArtifactDir = path.resolve(stringArg(args, "rerun-artifact-dir") || path.join(rerunOutDir, "artifacts"));
  const rerunDeck = path.resolve(stringArg(args, "rerun-deck") || path.join(rerunArtifactDir, "review-deck.pptx"));
  const rerunResult = await runReviewPack({
    ...args,
    caseSpecs: suggested.cases,
    caseSpecsExpanded: true,
    casesBaseDir: result.outDir,
    cases: undefined,
    "out-dir": rerunOutDir,
    "artifact-dir": rerunArtifactDir,
    deck: rerunDeck,
    "rerun-suggested": false,
    lawFetchCache: sharedLawFetchCache,
  });
  return {
    outDir: rerunResult.outDir,
    artifactDir: rerunResult.artifactDir,
    files: rerunResult.files,
    changedCases: suggested.changedCases,
    caseCount: rerunResult.caseCount,
    audit: rerunResult.audit,
    build: rerunResult.build,
    comparison: compareAuditMetrics(result.audit, rerunResult.audit),
  };
}

async function runAcceptedBuild(result, args, sharedLawFetchCache) {
  const accepted = result.acceptedCases || buildAcceptedCasesDocument(result);
  if (!accepted.evaluated) {
    return {
      skipped: true,
      reason: "2차 자동 보강 평가가 없어 최종 채택 산출물을 만들지 않았습니다. --rerun-suggested를 함께 사용하세요.",
      acceptedCases: accepted.acceptedCases || 0,
    };
  }
  const acceptedOutDir = path.resolve(stringArg(args, "accepted-out-dir") || path.join(result.outDir, "accepted"));
  const acceptedDeck = path.resolve(stringArg(args, "accepted-deck") || path.join(acceptedOutDir, "accepted-deck.pptx"));
  const acceptedOutputs = stringArg(args, "accepted-outputs") || stringArg(args, "outputs") || "svg,html,json,audit,trace,pptx,deck";
  const build = await runBatchBuild({
    ...args,
    caseSpecs: accepted.cases,
    caseSpecsExpanded: true,
    casesBaseDir: result.outDir,
    cases: undefined,
    "out-dir": acceptedOutDir,
    outputs: acceptedOutputs,
    deck: acceptedDeck,
    "rerun-suggested": false,
    lawFetchCache: sharedLawFetchCache,
  });
  const files = {
    manifest: path.join(acceptedOutDir, "manifest.md"),
    manifestJson: path.join(acceptedOutDir, "manifest.json"),
  };
  await writeText(files.manifest, formatBatchBuildMarkdown(build));
  await writeText(files.manifestJson, `${JSON.stringify(build, jsonReplacer, 2)}\n`);
  return {
    outDir: acceptedOutDir,
    files,
    acceptedCases: accepted.acceptedCases || 0,
    rejectedCases: accepted.rejectedCases || 0,
    unchangedCases: accepted.unchangedCases || 0,
    build,
  };
}

function appendRerunSection(lines, result) {
  if (!result.rerun) return;
  lines.push("## 자동 보강 재실행");
  lines.push("");
  if (result.rerun.skipped) {
    lines.push(`- 생략: ${result.rerun.reason}`);
    lines.push("");
    return;
  }
  lines.push(`- 2차 리뷰팩: ${linkPath(result.outDir, result.rerun.outDir)}`);
  lines.push(`- 적용된 보강 케이스: ${result.rerun.changedCases}/${result.caseCount}`);
  if (result.files?.acceptedCases && result.acceptedCases) {
    lines.push(`- 채택 케이스: ${linkPath(result.outDir, result.files.acceptedCases)} (채택 ${result.acceptedCases.acceptedCases || 0} · 거절 ${result.acceptedCases.rejectedCases || 0} · 유지 ${result.acceptedCases.unchangedCases || 0})`);
  }
  if (result.rerun.files?.readme) lines.push(`- 2차 README: ${linkPath(result.outDir, result.rerun.files.readme)}`);
  if (result.rerun.files?.indexHtml) lines.push(`- 2차 HTML 첫 화면: ${linkPath(result.outDir, result.rerun.files.indexHtml)}`);
  if (result.rerun.files?.audit) lines.push(`- 2차 감사 요약: ${linkPath(result.outDir, result.rerun.files.audit)}`);
  if (result.rerun.files?.manifest) lines.push(`- 2차 산출물 매니페스트: ${linkPath(result.outDir, result.rerun.files.manifest)}`);
  lines.push("");
  lines.push("| 지표 | 1차 | 2차 | 변화 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const row of comparisonRows(result.rerun.comparison)) {
    lines.push(`| ${row.label} | ${row.before} | ${row.after} | ${formatDelta(row.delta)} |`);
  }
  lines.push("");
}

function appendAcceptedBuildSection(lines, result) {
  if (!result.acceptedBuild) return;
  lines.push("## 최종 채택 산출물");
  lines.push("");
  if (result.acceptedBuild.skipped) {
    lines.push(`- 생략: ${result.acceptedBuild.reason}`);
    lines.push("");
    return;
  }
  lines.push(`- 폴더: ${linkPath(result.outDir, result.acceptedBuild.outDir)}`);
  if (result.acceptedBuild.files?.manifest) lines.push(`- 매니페스트: ${linkPath(result.outDir, result.acceptedBuild.files.manifest)}`);
  if (result.acceptedBuild.files?.manifestJson) lines.push(`- 매니페스트 JSON: ${linkPath(result.outDir, result.acceptedBuild.files.manifestJson)}`);
  if (result.acceptedBuild.build?.decks?.length) {
    for (const deck of result.acceptedBuild.build.decks) {
      lines.push(`- 최종 PPTX deck(${deck.paper}): ${linkPath(result.outDir, deck.path)}`);
    }
  } else if (result.acceptedBuild.build?.deck) {
    lines.push(`- 최종 PPTX deck: ${linkPath(result.outDir, result.acceptedBuild.build.deck)}`);
  }
  lines.push(`- 케이스: 채택 ${result.acceptedBuild.acceptedCases || 0} · 거절 ${result.acceptedBuild.rejectedCases || 0} · 유지 ${result.acceptedBuild.unchangedCases || 0}`);
  lines.push("");
}

function compareAuditMetrics(beforeAudit, afterAudit) {
  const before = auditMetrics(beforeAudit);
  const after = auditMetrics(afterAudit);
  const delta = {};
  for (const key of Object.keys(before)) delta[key] = (after[key] || 0) - (before[key] || 0);
  return { before, after, delta };
}

function auditMetrics(audit = {}) {
  const totals = {
    high: 0,
    medium: 0,
    low: 0,
    layoutIssues: 0,
    qualityIssues: 0,
    jurisdictionCandidates: 0,
    missingAnnexes: 0,
    lawMapUnmatched: 0,
    lawMapAmbiguous: 0,
  };
  for (const item of audit.cases || []) {
    const summary = item.summary || {};
    totals.high += summary.reviewActions?.high || 0;
    totals.medium += summary.reviewActions?.medium || 0;
    totals.low += summary.reviewActions?.low || 0;
    totals.layoutIssues += summary.layoutDiagnostics?.totalIssues || 0;
    totals.qualityIssues += summary.layoutDiagnostics?.qualityIssues || 0;
    totals.jurisdictionCandidates += summary.jurisdiction?.candidateDepartments || 0;
    totals.missingAnnexes += summary.annex?.missing || 0;
    totals.lawMapUnmatched += summary.lawMap?.unmatchedDepartments || 0;
    totals.lawMapAmbiguous += summary.lawMap?.ambiguousDepartments || 0;
  }
  return totals;
}

function comparisonRows(comparison = {}) {
  const labels = [
    ["high", "높은 확인"],
    ["medium", "중간 확인"],
    ["layoutIssues", "배치 hard issue"],
    ["qualityIssues", "작도 polish issue"],
    ["jurisdictionCandidates", "소관 후보 과·팀"],
    ["missingAnnexes", "미확보 별표"],
    ["lawMapUnmatched", "소관법령 미매칭"],
    ["lawMapAmbiguous", "소관법령 중복 후보"],
  ];
  return labels.map(([key, label]) => ({
    label,
    before: comparison.before?.[key] || 0,
    after: comparison.after?.[key] || 0,
    delta: comparison.delta?.[key] || 0,
  }));
}

function formatDelta(value) {
  if (!value) return "0";
  return value > 0 ? `+${value}` : String(value);
}

export function buildSuggestedCasesDocument(result) {
  const baseCases = result.exportedCases || (result.audit?.cases || []).map((item) => item.case || {});
  const cases = [];
  let changedCases = 0;
  for (let index = 0; index < baseCases.length; index += 1) {
    const auditCase = result.audit?.cases?.[index] || {};
    const { caseSpec, changes } = suggestCaseSpec(baseCases[index], auditCase);
    if (changes.length) changedCases += 1;
    cases.push(caseSpec);
  }
  return {
    generatedAt: result.generatedAt,
    source: "review-pack",
    changedCases,
    notes: [
      "이 파일은 원본 cases.json을 보존한 채 자동 적용 가능한 보강안만 반영한 후보입니다.",
      "단일 보좌기관의 @소관 후보와 hard/polish layout 문제의 보수적 레이아웃 재시도만 자동 반영합니다.",
      "별표 확보, 복수 보좌기관 소관 대조, 소관법령 지도 충돌은 worklist.md에서 별도 확인하세요.",
    ],
    cases,
  };
}

export function buildAcceptedCasesDocument(result) {
  const baseCases = result.exportedCases || (result.audit?.cases || []).map((item) => item.case || {});
  const suggestedCases = result.suggestedCases?.cases || baseCases;
  const beforeCases = result.audit?.cases || [];
  const afterCases = result.rerun?.audit?.cases || [];
  const evaluated = Boolean(result.rerun && !result.rerun.skipped);
  const decisions = [];
  const cases = [];
  for (let index = 0; index < baseCases.length; index += 1) {
    const decision = decideAcceptedCase({
      original: baseCases[index] || {},
      suggested: suggestedCases[index] || baseCases[index] || {},
      beforeCase: beforeCases[index],
      afterCase: afterCases[index],
      evaluated,
    });
    decisions.push(decision);
    cases.push(decision.caseSpec);
  }
  return {
    generatedAt: result.generatedAt,
    source: "review-pack",
    evaluated,
    acceptedCases: decisions.filter((item) => item.decision === "accepted").length,
    rejectedCases: decisions.filter((item) => item.decision === "rejected").length,
    unchangedCases: decisions.filter((item) => item.decision === "unchanged").length,
    notEvaluatedCases: decisions.filter((item) => item.decision === "not-evaluated").length,
    notes: [
      "이 파일은 2차 자동 보강 결과가 원본보다 나빠지지 않은 케이스만 suggested-cases.json에서 채택합니다.",
      "높은/중간 확인, hard layout issue, 별표 누락, 소관법령 미매칭·중복 후보가 증가하면 자동 거절합니다.",
      "그 밖의 항목은 가중 위험점수가 1차 이하일 때만 채택합니다.",
    ],
    decisions: decisions.map(({ caseSpec, ...rest }) => rest),
    cases,
  };
}

function decideAcceptedCase({ original = {}, suggested = {}, beforeCase, afterCase, evaluated }) {
  const originalCase = clonePlain(original);
  const suggestedCase = clonePlain(suggested);
  const caseId = original.id || suggested.id || beforeCase?.summary?.id || afterCase?.summary?.id || "case";
  const institution = beforeCase?.summary?.institution || afterCase?.summary?.institution || original.institution || suggested.institution || caseId;
  const changes = suggestedCase.suggested?.changes || [];
  if (!changes.length) {
    return {
      id: caseId,
      institution,
      decision: "unchanged",
      selected: "original",
      reason: "자동 보강 변경사항이 없습니다.",
      caseSpec: markAcceptedCase(originalCase, "unchanged"),
    };
  }
  const before = caseMetrics(beforeCase?.summary);
  const after = caseMetrics(afterCase?.summary);
  const score = {
    before: scoreMetrics(before),
    after: scoreMetrics(after),
  };
  score.delta = score.after - score.before;
  if (!evaluated || !afterCase) {
    return {
      id: caseId,
      institution,
      decision: "not-evaluated",
      selected: "original",
      reason: "2차 자동 보강 결과가 없어 원본을 유지합니다.",
      metrics: { before, after: null },
      score: { before: score.before, after: null, delta: null },
      changes,
      caseSpec: markAcceptedCase(originalCase, "not-evaluated"),
    };
  }
  const regressions = criticalRegressions(before, after);
  if (afterCase.summary?.status === "error") {
    regressions.push({ key: "status", before: beforeCase?.summary?.status || "", after: "error" });
  }
  if (regressions.length) {
    return {
      id: caseId,
      institution,
      decision: "rejected",
      selected: "original",
      reason: `핵심 지표가 악화되어 원본을 유지합니다: ${regressions.map((item) => item.key).join(", ")}`,
      metrics: { before, after, delta: deltaMetrics(before, after) },
      score,
      regressions,
      changes,
      caseSpec: markAcceptedCase(originalCase, "rejected"),
    };
  }
  if (score.after > score.before) {
    return {
      id: caseId,
      institution,
      decision: "rejected",
      selected: "original",
      reason: `가중 위험점수가 증가했습니다(${score.before} → ${score.after}).`,
      metrics: { before, after, delta: deltaMetrics(before, after) },
      score,
      regressions: [],
      changes,
      caseSpec: markAcceptedCase(originalCase, "rejected"),
    };
  }
  return {
    id: caseId,
    institution,
    decision: "accepted",
    selected: "suggested",
    reason: score.after < score.before ? `가중 위험점수가 감소했습니다(${score.before} → ${score.after}).` : "핵심 지표 악화 없이 자동 보강을 적용할 수 있습니다.",
    metrics: { before, after, delta: deltaMetrics(before, after) },
    score,
    regressions: [],
    changes,
    caseSpec: markAcceptedCase(suggestedCase, "accepted", score.delta),
  };
}

function markAcceptedCase(caseSpec, decision, scoreDelta) {
  const { suggested: _suggested, ...stableCaseSpec } = caseSpec;
  return {
    ...stableCaseSpec,
    accepted: {
      source: "review-pack",
      decision,
      ...(scoreDelta == null ? {} : { scoreDelta }),
    },
  };
}

function caseMetrics(summary = {}) {
  return {
    high: summary.reviewActions?.high || 0,
    medium: summary.reviewActions?.medium || 0,
    low: summary.reviewActions?.low || 0,
    layoutIssues: summary.layoutDiagnostics?.totalIssues || 0,
    qualityIssues: summary.layoutDiagnostics?.qualityIssues || 0,
    jurisdictionCandidates: summary.jurisdiction?.candidateDepartments || 0,
    missingAnnexes: summary.annex?.missing || 0,
    lawMapUnmatched: summary.lawMap?.unmatchedDepartments || 0,
    lawMapAmbiguous: summary.lawMap?.ambiguousDepartments || 0,
  };
}

function scoreMetrics(metrics = {}) {
  return (
    (metrics.high || 0) * 1000 +
    (metrics.layoutIssues || 0) * 700 +
    (metrics.missingAnnexes || 0) * 600 +
    (metrics.medium || 0) * 300 +
    (metrics.lawMapUnmatched || 0) * 180 +
    (metrics.lawMapAmbiguous || 0) * 180 +
    (metrics.jurisdictionCandidates || 0) * 60 +
    (metrics.qualityIssues || 0) * 5 +
    (metrics.low || 0)
  );
}

function criticalRegressions(before = {}, after = {}) {
  return [
    "high",
    "medium",
    "layoutIssues",
    "missingAnnexes",
    "lawMapUnmatched",
    "lawMapAmbiguous",
  ]
    .filter((key) => (after[key] || 0) > (before[key] || 0))
    .map((key) => ({ key, before: before[key] || 0, after: after[key] || 0 }));
}

function deltaMetrics(before = {}, after = {}) {
  const delta = {};
  for (const key of Object.keys(before)) delta[key] = (after[key] || 0) - (before[key] || 0);
  return delta;
}

function suggestCaseSpec(baseCase = {}, auditCase = {}) {
  const next = clonePlain(baseCase);
  const changes = [];
  const directives = suggestedDirectives(auditCase);
  if (directives.length) {
    const existing = uniqueStrings(asArray(next.directives).map(String));
    const merged = uniqueStrings([...existing, ...directives]);
    const added = merged.filter((directive) => !existing.includes(directive));
    if (added.length) {
      next.directives = merged;
      changes.push({ type: "directives", count: added.length });
    }
  }

  const layoutPatch = suggestedLayoutPatchObject(auditCase.summary || {});
  const materialPatch = materialLayoutPatch(next, layoutPatch);
  if (Object.keys(materialPatch).length) {
    if (materialPatch.layout) delete next.layouts;
    Object.assign(next, materialPatch);
    changes.push({ type: "layout", patch: materialPatch });
  }

  if (changes.length) {
    next.suggested = {
      source: "review-pack",
      sourceCaseId: baseCase.id || auditCase.summary?.id || null,
      changes,
    };
  }
  return { caseSpec: next, changes };
}

function materialLayoutPatch(caseSpec, patch = {}) {
  const material = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "layout" && caseSpec.layouts) {
      material[key] = value;
      continue;
    }
    if (caseSpec[key] !== value) material[key] = value;
  }
  return material;
}

function suggestedDirectives(auditCase = {}) {
  return uniqueStrings(
    (auditCase.report?.jurisdictionCandidates || [])
      .filter((candidate) => candidate.confidence === "single-advisor-container")
      .map((candidate) => candidate.directive)
      .filter(Boolean),
  );
}

async function resolveReviewContext(args) {
  if (args.caseSpecs) {
    const expansion = args.caseSpecsExpanded
      ? { cases: args.caseSpecs }
      : expandCaseSpecsByLayouts(args.caseSpecs, args["expand-layouts"]);
    return {
      caseSpecs: expansion.cases,
      casesBaseDir: args.casesBaseDir
        ? path.resolve(String(args.casesBaseDir))
        : stringArg(args, "cases")
          ? path.dirname(path.resolve(stringArg(args, "cases")))
          : process.cwd(),
    };
  }
  if (stringArg(args, "cases")) {
    const context = await loadBatchContext(args);
    return {
      caseSpecs: context.caseSpecs,
      casesBaseDir: context.casesBaseDir,
    };
  }
  const inputInstitutions = args.input?.length ? await readInputs(args.input) : [];
  const institutions = [stringArg(args, "institutions"), stringArg(args, "institution"), ...inputInstitutions];
  return {
    caseSpecs: buildAuditCaseSpecs({
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
    }).cases,
    casesBaseDir: process.cwd(),
  };
}

function exportCaseSpecs(caseSpecs, { fromDir, outDir }) {
  return (caseSpecs || []).map((caseSpec) => rebaseCaseSpecPaths(caseSpec, fromDir || process.cwd(), outDir));
}

function rebaseCaseSpecPaths(caseSpec, fromDir, outDir) {
  const next = clonePlain(caseSpec);
  rebasePathField(next, "input", fromDir, outDir);
  rebasePathField(next, "inputs", fromDir, outDir);
  rebasePathField(next, "graph", fromDir, outDir);
  rebasePathField(next, "graphFile", fromDir, outDir);
  rebasePathField(next, "jsonFile", fromDir, outDir);
  rebasePathField(next, "annexFile", fromDir, outDir);
  rebasePathField(next, "annexFiles", fromDir, outDir);
  rebasePathField(next, "lawMap", fromDir, outDir);
  rebasePathField(next, "sourceDir", fromDir, outDir);
  return next;
}

function rebasePathField(object, key, fromDir, outDir) {
  if (object[key] == null) return;
  object[key] = Array.isArray(object[key])
    ? object[key].map((value) => rebasePathValue(value, fromDir, outDir))
    : rebasePathValue(object[key], fromDir, outDir);
}

function rebasePathValue(value, fromDir, outDir) {
  if (typeof value !== "string" || !value.trim() || value === "-") return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  const absolute = path.isAbsolute(value) ? value : path.resolve(fromDir, value);
  return path.relative(outDir, absolute).split(path.sep).join("/") || ".";
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
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

function collectDirectiveDrafts(cases) {
  const groups = [];
  for (const item of cases) {
    const directives = (item.report?.jurisdictionCandidates || [])
      .map((candidate) => candidate.directive)
      .filter(Boolean);
    if (!directives.length) continue;
    groups.push({
      caseLabel: caseLabel(item),
      directives,
    });
  }
  return groups;
}

function collectUnresolvedJurisdictions(cases) {
  const items = [];
  for (const item of cases) {
    const label = caseLabel(item);
    for (const candidate of item.report?.jurisdictionCandidates || []) {
      if (candidate.directive) continue;
      items.push({
        caseLabel: label,
        message: `${candidate.parent} > ${candidate.advisor}: ${candidate.departments?.length || 0}개 과·팀. 복수 보좌기관이므로 직제 호 번호 범위와 과 분장사무를 대조해야 합니다.`,
      });
    }
    for (const unresolved of item.report?.jurisdictionCrosswalks?.unresolved || []) {
      const advisors = unresolved.advisors?.length ? unresolved.advisors.join("ㆍ") : "일치 범위 없음";
      items.push({
        caseLabel: label,
        message: `${unresolved.department}: ${unresolved.reference || "참조 없음"} · ${advisors}`,
      });
    }
  }
  return items;
}

function collectMissingAnnexes(cases) {
  const items = [];
  for (const item of cases) {
    const label = caseLabel(item);
    for (const annex of item.report?.annexRequirements || []) {
      if (annex.matchedAnnex) continue;
      items.push({
        caseLabel: label,
        annex: annex.annex,
        description: annex.description,
        source: annex.source,
      });
    }
  }
  return items;
}

function collectLayoutRetries(cases) {
  const items = [];
  for (const item of cases) {
    const summary = item.summary || {};
    const diagnostics = summary.layoutDiagnostics || {};
    if (!(diagnostics.totalIssues || diagnostics.qualityIssues)) continue;
    const hard = diagnostics.totalIssues || 0;
    const quality = diagnostics.qualityIssues || 0;
    const patch = suggestedLayoutPatch(summary);
    const severity = hard ? `배치 문제 ${hard}건` : `polish ${quality}건`;
    items.push({
      caseLabel: caseLabel(item),
      message: `${severity}. ${layoutRetryMessage(summary, diagnostics)}`,
      casePatch: patch,
    });
  }
  return items;
}

function collectLawMapIssues(cases) {
  const items = [];
  for (const item of cases) {
    const lawMap = item.summary?.lawMap;
    if (!lawMap) continue;
    if (lawMap.unmatchedDepartments) {
      items.push({
        caseLabel: caseLabel(item),
        message: `소관법령 부서 미매칭 ${lawMap.unmatchedDepartments}개. 부서명 변경·약칭·하위기관 scoped 노드 여부를 확인하세요.`,
      });
    }
    if (lawMap.ambiguousDepartments) {
      items.push({
        caseLabel: caseLabel(item),
        message: `소관법령 부서 중복 후보 ${lawMap.ambiguousDepartments}개. 같은 이름의 여러 조직 후보와 충돌했습니다. cases 입력에 @유형 또는 정확한 소관 지시문을 보강하세요.`,
      });
    }
  }
  return items;
}

function caseLabel(item) {
  const summary = item.summary || {};
  return [summary.institution || summary.id || item.case?.id || "케이스", summary.asOf, summary.focus || summary.layout]
    .filter(Boolean)
    .join(" · ");
}

function suggestedLayoutPatch(summary = {}) {
  const patch = suggestedLayoutPatchObject(summary);
  return Object.keys(patch).length ? JSON.stringify(patch) : "";
}

function suggestedLayoutPatchObject(summary = {}) {
  const patch = {};
  if ((summary.layoutDiagnostics?.totalIssues || 0) > 0) {
    patch.layout = "catalog";
    patch.maxNodes = summary.paper === "a4-half" ? 14 : 24;
  } else if ((summary.layoutDiagnostics?.qualityIssues || 0) > 0) {
    patch.layout = "best";
    patch.maxNodes = summary.paper === "a4-half" ? 16 : 28;
  }
  if (summary.paper === "a4-half" && (summary.layoutDiagnostics?.totalIssues || 0) > 0) patch.paper = "a4-portrait";
  return patch;
}

function layoutRetryMessage(summary = {}, diagnostics = {}) {
  if (diagnostics.totalIssues) {
    if (summary.paper === "a4-half") return "`a4-half` 면이 빽빽합니다. `catalog` 또는 `a4-portrait`로 재시도하고, 실·국별 `focus` 분할을 우선 검토하세요.";
    return "`catalog` 또는 더 작은 `maxNodes`로 재시도하세요.";
  }
  return "현재 산출물은 사용 가능하지만 간격·정렬·선교차·선-상자 관통·과도한 선 우회·균형·세로글자 폭을 줄이려면 `layout=best`와 더 작은 `maxNodes`로 재시도하세요.";
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

function relativeFilePath(baseDir, filePath) {
  if (!filePath) return "";
  return path.relative(baseDir, filePath).split(path.sep).join("/") || path.basename(filePath);
}

function hrefPath(baseDir, filePath) {
  const relative = path.relative(baseDir, filePath).split(path.sep).join("/");
  return encodeURI(relative || path.basename(filePath));
}

function htmlAttr(value) {
  return htmlEscape(value).replaceAll('"', "&quot;");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
