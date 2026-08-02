import { buildComparisonReportPages } from "./graph-diff.mjs";
import { renderSvg } from "./render-svg.mjs";
import { displayDate } from "./utils.mjs";

export function renderReviewHtml(graph, pages, { showLawCounts = false, sourceGraph = graph } = {}) {
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

    ${summarySection(graph, sourceGraph, pages)}
    ${warningsSection(sourceGraph)}
    ${comparisonSection(comparisonRows)}
  </main>
</body>
</html>
`;
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
