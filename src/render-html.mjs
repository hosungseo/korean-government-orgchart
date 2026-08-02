import { buildComparisonReportPages } from "./graph-diff.mjs";
import { layoutPage, resolvePageSize } from "./layout.mjs";
import { renderSvg } from "./render-svg.mjs";
import { displayDate } from "./utils.mjs";

export function renderReviewHtml(graph, pages, { showLawCounts = false, sourceGraph = graph, artifactLinks = {} } = {}) {
  const svg = stripXmlDeclaration(renderSvg(graph, pages, { showLawCounts }));
  const paper = pages[0]?.paper || "slide";
  const sheetWidth = htmlSheetWidth(paper);
  const title = sourceGraph.meta?.title || sourceGraph.meta?.institution || graph.meta?.title || graph.meta?.institution || "조직도";
  const comparisonRows = sourceGraph.meta?.comparison
    ? buildComparisonReportPages(sourceGraph, { paper, rowsPerPage: 1000 }).flatMap((page) => page.comparisonRows || [])
    : [];
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} 검토시트</title>
  <style>
    @page { size: A4; margin: 12mm; }
    :root { --ink:#111827; --muted:#6B7280; --rule:#D1D5DB; --soft:#F3F4F6; --paper:#FFFFFF; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #E5E7EB; color: var(--ink); font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; line-height: 1.45; }
    .sheet { width: min(${sheetWidth}, calc(100vw - 24px)); margin: 16px auto; padding: 18mm; background: var(--paper); box-shadow: 0 4px 18px rgba(15,23,42,.12); }
    h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
    h2 { margin: 28px 0 10px; font-size: 16px; border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
    .meta { margin-top: 8px; color: var(--muted); font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
    .hint { margin: 14px 0 0; padding: 10px 12px; background: #F8FAFC; border: 1px solid #E5E7EB; color: #475569; font-size: 12px; }
    .review-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 8px; margin-top: 8px; }
    .review-card { border: 1px solid var(--rule); background: #F8FAFC; padding: 8px 9px; min-height: 54px; }
    .review-card .label { display:block; color: var(--muted); font-size: 11px; margin-bottom: 3px; }
    .review-card strong { font-size: 14px; }
    .links { display:flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .links a { border: 1px solid var(--rule); border-radius: 999px; padding: 3px 8px; color: #1D4ED8; text-decoration: none; background: #fff; font-size: 12px; }
    .svg-box { margin-top: 16px; border: 1px solid var(--rule); overflow: auto; background: #F8FAFC; }
    .svg-box svg { display: block; max-width: 100%; height: auto; margin: 0 auto; background: white; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
    th, td { border: 1px solid var(--rule); padding: 6px 7px; vertical-align: top; text-align: left; }
    th { background: var(--soft); font-weight: 700; }
    .num { text-align: right; white-space: nowrap; }
    .muted { color: var(--muted); }
    .warnings { margin: 8px 0 0; padding-left: 18px; color: #92400E; font-size: 12px; }
    .badge { display: inline-block; border: 1px solid var(--rule); border-radius: 999px; padding: 2px 8px; margin-right: 4px; background: #fff; }
    @media print {
      body { background: white; }
      .sheet { width: auto; margin: 0; padding: 0; box-shadow: none; }
      .svg-box { overflow: visible; break-inside: avoid; }
      .review-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      h2 { break-after: avoid; }
      table { break-inside: auto; }
      tr { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <header>
      <h1>${htmlEscape(title)} 검토시트</h1>
      <div class="meta">
        <span>기관: ${htmlEscape(sourceGraph.meta?.institution || graph.meta?.institution || "-")}</span>
        <span>기준일: ${htmlEscape(sourceGraph.meta?.asOf ? displayDate(sourceGraph.meta.asOf) : "-")}</span>
        <span>페이지: ${pages.length}</span>
        <span>노드: ${graph.nodes.size}</span>
        <span>관계: ${graph.edges.size}</span>
      </div>
      <p class="hint">이 HTML은 한글/HWPX 검토서에 붙여넣기 쉽도록 조직도 SVG와 표를 한 파일에 묶은 산출물입니다. 브라우저에서 열어 필요한 영역을 복사하거나 PDF로 인쇄할 수 있습니다.</p>
    </header>

    <section>
      <h2>조직도</h2>
      <div class="svg-box">${svg}</div>
    </section>

    ${layoutReviewSection(graph, pages, artifactLinks)}
    ${summarySection(graph, sourceGraph, pages)}
    ${warningsSection(sourceGraph)}
    ${comparisonSection(comparisonRows)}
  </main>
</body>
</html>
`;
}

function layoutReviewSection(graph, pages, artifactLinks = {}) {
  const pageRows = pages.map((page) => {
    if (page.kind === "law-index" || page.kind === "comparison-report") {
      return {
        page,
        diagnostics: emptyDiagnostics(),
        nodes: page.entries?.length || page.comparisonRows?.length || 0,
        edges: 0,
        appendix: true,
      };
    }
    const layout = layoutPage(graph, page, { pageSize: resolvePageSize(page.paper) });
    const diagnostics = layout.diagnostics || {};
    return {
      page,
      diagnostics,
      nodes: layout.nodes?.length || 0,
      edges: layout.edges?.length || 0,
    };
  });
  const totals = pageRows.reduce((acc, row) => {
    acc.hard += (row.diagnostics.overflow?.length || 0) + (row.diagnostics.overlaps?.length || 0) + (row.diagnostics.edgeIssues?.length || 0);
    acc.quality += row.diagnostics.qualityIssues?.length || 0;
    acc.nodes += row.nodes;
    acc.edges += row.edges;
    return acc;
  }, { hard: 0, quality: 0, nodes: 0, edges: 0 });
  const selected = [...new Set(pages.map((page) => page.layoutStyle).filter(Boolean))].join(", ") || "-";
  const bestFit = pages.find((page) => page.bestFit)?.bestFit || null;
  const candidateRows = bestFit?.candidateScores?.slice(0, 4) || [];
  return `<section>
  <h2>작도 검토</h2>
  <div class="review-grid">
    <div class="review-card"><span class="label">선택 유형</span><strong>${htmlEscape(selected)}</strong></div>
    <div class="review-card"><span class="label">페이지</span><strong>${pages.length}</strong></div>
    <div class="review-card"><span class="label">배치 hard issue</span><strong>${totals.hard}</strong></div>
    <div class="review-card"><span class="label">작도 polish issue</span><strong>${totals.quality}</strong></div>
  </div>
  ${bestFit?.selectionReason ? `<p class="hint"><strong>best-fit 선택 사유:</strong> ${htmlEscape(bestFit.selectionReason)}</p>` : ""}
  ${artifactLinksHtml(artifactLinks)}
  <table>
    <thead><tr><th>쪽</th><th>유형</th><th>제목</th><th>노드</th><th>관계선</th><th>상태</th></tr></thead>
    <tbody>
      ${pageRows.map(({ page, diagnostics, nodes, edges }) => `<tr>
        <td class="num">${page.pageNumber || ""}/${page.pageCount || pages.length}</td>
        <td>${htmlEscape(page.layoutStyle || "-")}</td>
        <td>${htmlEscape(page.subtitle || "-")}</td>
        <td class="num">${nodes}</td>
        <td class="num">${edges}</td>
        <td>${htmlEscape(formatLayoutStatus(diagnostics))}</td>
      </tr>`).join("")}
    </tbody>
  </table>
  ${candidateRows.length ? `<table>
    <thead><tr><th>best-fit 후보</th><th>점수</th><th>페이지</th><th>문제</th><th>품질</th></tr></thead>
    <tbody>
      ${candidateRows.map((candidate) => {
        const diag = candidate.diagnostics || {};
        return `<tr>
          <td>${htmlEscape(candidate.style)}${candidate.maxNodes ? `/${htmlEscape(candidate.maxNodes)}` : ""}</td>
          <td class="num">${htmlEscape(candidate.score)}</td>
          <td class="num">${htmlEscape(diag.pages || 0)}</td>
          <td class="num">${htmlEscape(diag.totalIssues || 0)}</td>
          <td class="num">${htmlEscape(diag.qualityIssues || 0)}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>` : ""}
</section>`;
}

function artifactLinksHtml(artifactLinks = {}) {
  const entries = [
    ["json", "JSON 구조"],
    ["audit", "감사 리포트"],
    ["trace", "근거 trace"],
    ["pptx", "편집 PPTX"],
    ["svg", "SVG 원본"],
  ].filter(([key]) => artifactLinks[key]);
  if (!entries.length) return "";
  return `<p class="muted">근거 파일과 후가공 산출물</p><div class="links">${entries.map(([key, label]) => `<a href="${htmlAttr(artifactLinks[key])}">${htmlEscape(label)}</a>`).join("")}</div>`;
}

function formatLayoutStatus(diagnostics = {}) {
  const hard = (diagnostics.overflow?.length || 0) + (diagnostics.overlaps?.length || 0) + (diagnostics.edgeIssues?.length || 0);
  const quality = diagnostics.qualityIssues?.length || 0;
  if (!hard && !quality) return "정상";
  const parts = [];
  if (diagnostics.overflow?.length) parts.push(`넘침 ${diagnostics.overflow.length}`);
  if (diagnostics.overlaps?.length) parts.push(`겹침 ${diagnostics.overlaps.length}`);
  if (diagnostics.edgeIssues?.length) parts.push(`연결선 ${diagnostics.edgeIssues.length}`);
  if (quality) parts.push(`품질 ${quality}`);
  return parts.join(" · ");
}

function emptyDiagnostics() {
  return {
    ok: true,
    qualityOk: true,
    overflow: [],
    overlaps: [],
    edgeIssues: [],
    qualityIssues: [],
  };
}

function summarySection(graph, sourceGraph, pages) {
  const kindCounts = {};
  for (const node of graph.nodes.values()) kindCounts[node.kind] = (kindCounts[node.kind] || 0) + 1;
  const structure = sourceGraph.meta?.structure || {};
  return `<section>
  <h2>구조 요약</h2>
  <table>
    <tbody>
      <tr><th>출력 용지</th><td>${htmlEscape(pages[0]?.paper || "-")}</td><th>페이지 수</th><td class="num">${pages.length}</td></tr>
      <tr><th>보조기관</th><td class="num">${kindCounts.assistant || 0}</td><th>보좌기관</th><td class="num">${kindCounts.advisor || 0}</td></tr>
      <tr><th>소속기관</th><td class="num">${kindCounts.affiliated || 0}</td><th>한시조직</th><td class="num">${kindCounts.temporary || 0}</td></tr>
      <tr><th>소관법령 매칭</th><td class="num">${sourceGraph.meta?.lawMap?.matchedDepartments || 0}</td><th>별표 조직</th><td class="num">${sourceGraph.meta?.annexOrganizations?.length || 0}</td></tr>
    </tbody>
  </table>
  ${structure.countingRules?.note ? `<p class="muted">${htmlEscape(structure.countingRules.note)}</p>` : ""}
</section>`;
}

function warningsSection(graph) {
  const warnings = graph.meta?.warnings || [];
  const validation = graph.meta?.validation || [];
  if (!warnings.length && !validation.length) return "";
  return `<section>
  <h2>확인 필요</h2>
  <ul class="warnings">
    ${warnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join("")}
    ${validation.map((item) => `<li>${htmlEscape(item.message || item.rule || JSON.stringify(item))}</li>`).join("")}
  </ul>
</section>`;
}

function comparisonSection(rows) {
  if (!rows.length) return "";
  return `<section>
  <h2>변경목록</h2>
  <table>
    <thead>
      <tr><th>유형</th><th>변경 전</th><th>변경 후</th><th>전 상위</th><th>후 상위</th><th>비고</th></tr>
    </thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${htmlEscape(row.type)}</td>
        <td>${htmlEscape(row.before || "-")}</td>
        <td>${htmlEscape(row.after || "-")}</td>
        <td>${htmlEscape(row.beforeParent || "-")}</td>
        <td>${htmlEscape(row.afterParent || "-")}</td>
        <td>${htmlEscape([row.kind, row.score ? `점수 ${row.score}` : "", row.reason].filter(Boolean).join(" · ") || "-")}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</section>`;
}

function htmlSheetWidth(paper) {
  const value = String(paper || "");
  if (value.includes("landscape")) return "297mm";
  if (value.includes("half")) return "105mm";
  return "210mm";
}

function stripXmlDeclaration(svg) {
  return String(svg || "").replace(/^\s*<\?xml[^>]*>\s*/i, "");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlAttr(value) {
  return htmlEscape(value).replaceAll('"', "&quot;");
}
