import { displayDate, xmlEscape } from "./utils.mjs";
import { displayNodeName, layoutPage, nodeStyle, SLIDE_SIZE } from "./layout.mjs";

export function renderSvg(graph, pages, { showLawCounts = false } = {}) {
  const gap = 24;
  const totalHeight = pages.length * SLIDE_SIZE.height + Math.max(0, pages.length - 1) * gap;
  const groups = pages.map((page, index) => renderPage(graph, page, index * (SLIDE_SIZE.height + gap), { showLawCounts }));
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_SIZE.width}" height="${totalHeight}" viewBox="0 0 ${SLIDE_SIZE.width} ${totalHeight}">`,
    `<rect width="100%" height="100%" fill="#E5E7EB"/>`,
    ...groups,
    `</svg>`,
  ].join("\n");
}

function renderPage(graph, page, offsetY, { showLawCounts }) {
  const pageGroup = [];
  pageGroup.push(`<g transform="translate(0 ${offsetY})">`);
  pageGroup.push(`<rect width="${SLIDE_SIZE.width}" height="${SLIDE_SIZE.height}" fill="#FFFFFF"/>`);
  pageGroup.push(`<text x="42" y="48" font-family="Malgun Gothic, sans-serif" font-size="28" font-weight="700" fill="#111827">${xmlEscape(page.title)}</text>`);
  pageGroup.push(`<text x="42" y="76" font-family="Malgun Gothic, sans-serif" font-size="15" fill="#4B5563">${xmlEscape(page.subtitle)}</text>`);
  if (graph.meta.asOf) {
    pageGroup.push(`<text x="${SLIDE_SIZE.width - 42}" y="48" text-anchor="end" font-family="Malgun Gothic, sans-serif" font-size="13" fill="#6B7280">&lt; ${xmlEscape(displayDate(graph.meta.asOf))} 기준 &gt;</text>`);
  }
  pageGroup.push(`<line x1="42" y1="92" x2="${SLIDE_SIZE.width - 42}" y2="92" stroke="#9CA3AF" stroke-width="1"/>`);

  if (page.kind === "law-index") {
    pageGroup.push(svgLawIndex(page));
    pageGroup.push(`<text x="${SLIDE_SIZE.width - 38}" y="704" text-anchor="end" font-family="Malgun Gothic, sans-serif" font-size="10" fill="#6B7280">${page.pageNumber} / ${page.pageCount}</text>`);
    pageGroup.push(`</g>`);
    return pageGroup.join("\n");
  }

  const layout = layoutPage(graph, page);

  for (const edge of layout.edges) {
    pageGroup.push(...svgEdge(edge));
  }
  for (const entry of layout.nodes) {
    pageGroup.push(svgNode(entry.node, entry.position, { showLawCounts }));
  }
  pageGroup.push(svgLegend({ showLawCounts, operational: graph.meta.renderView === "operational" }));
  pageGroup.push(`<text x="${SLIDE_SIZE.width - 38}" y="704" text-anchor="end" font-family="Malgun Gothic, sans-serif" font-size="10" fill="#6B7280">${page.pageNumber} / ${page.pageCount}</text>`);
  pageGroup.push(`</g>`);
  return pageGroup.join("\n");
}

function svgEdge(edge) {
  const color =
    edge.type === "affiliated" || edge.type === "temporary" ? "#3D8B3D" : edge.type === "jurisdiction" ? "#4F7EA8" : edge.type === "advisor" ? "#8B8B8B" : "#6B7280";
  const dash = edge.type === "advisor" || edge.type === "temporary" || edge.type === "jurisdiction" ? ` stroke-dasharray="5 4"` : "";
  const startX = edge.from.centerX;
  const startY = edge.from.bottom;
  const endX = edge.to.centerX;
  const endY = edge.to.top;
  const midY = startY + Math.max(10, (endY - startY) * 0.48);
  const common = `stroke="${color}" stroke-width="1.1" fill="none"${dash}`;
  return [
    `<line x1="${startX}" y1="${startY}" x2="${startX}" y2="${midY}" ${common}/>`,
    Math.abs(startX - endX) > 0.5
      ? `<line x1="${startX}" y1="${midY}" x2="${endX}" y2="${midY}" ${common}/>`
      : "",
    `<line x1="${endX}" y1="${midY}" x2="${endX}" y2="${endY}" ${common}/>`,
  ].filter(Boolean);
}

function svgNode(node, position, { showLawCounts }) {
  const style = nodeStyle(node);
  const dash = style.lineStyle === "dashed" ? ` stroke-dasharray="4 3"` : "";
  const fontSize = position.vertical ? 10.8 : node.name.length > 13 ? 10.5 : 12.5;
  const lines = position.vertical
    ? displayNodeName(node, true, { showLawCounts }).split("\n")
    : [displayNodeName(node, false, { showLawCounts })];
  const lineHeight = position.vertical ? 10.5 : 14;
  const totalTextHeight = lines.length * lineHeight;
  const startY = position.top + (position.height - totalTextHeight) / 2 + lineHeight * 0.8;
  const text = lines
    .map(
      (line, index) =>
        `<tspan x="${position.centerX}" y="${startY + index * lineHeight}">${xmlEscape(line)}</tspan>`,
    )
    .join("");
  const verticalLawCount = showLawCounts && position.vertical && node.metadata?.lawResponsibility?.lawCount
    ? svgVerticalLawCount(node.metadata.lawResponsibility.lawCount, position)
    : "";
  return [
    `<g>`,
    `<rect x="${position.left}" y="${position.top}" width="${position.width}" height="${position.height}" rx="${position.vertical ? 1 : 4}" fill="${style.fill}" stroke="${style.line}" stroke-width="1.2"${dash}/>`,
    `<text text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="${fontSize}" font-weight="${style.bold ? 700 : 400}" fill="${style.text}">${text}</text>`,
    verticalLawCount,
    `</g>`,
  ].join("");
}

function svgVerticalLawCount(lawCount, position) {
  const width = 26;
  const left = Math.max(0, position.centerX - width / 2);
  const top = Math.min(676, position.bottom + 2);
  return `<g><rect x="${left}" y="${top}" width="${width}" height="12" rx="2" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="0.6"/><text x="${position.centerX}" y="${top + 8.6}" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="7.5" font-weight="700" fill="#374151">${lawCount}</text></g>`;
}

function svgLegend({ showLawCounts, operational }) {
  const affiliateX = operational ? 257 : 171;
  const affiliateLabelX = affiliateX + 19;
  const markerX = operational ? 346 : 260;
  const jurisdiction = operational
    ? `<line x1="159" y1="-3" x2="179" y2="-3" stroke="#4F7EA8" stroke-dasharray="4 3"/><text x="184" y="0">소관 묶음</text>`
    : "";
  return [
    `<g transform="translate(42 696)" font-family="Malgun Gothic, sans-serif" font-size="9.5" fill="#4B5563">`,
    `<line x1="0" y1="-3" x2="20" y2="-3" stroke="#6B7280"/><text x="25" y="0">보조·지휘</text>`,
    `<line x1="92" y1="-3" x2="112" y2="-3" stroke="#8B8B8B" stroke-dasharray="4 3"/><text x="117" y="0">보좌</text>`,
    jurisdiction,
    `<rect x="${affiliateX}" y="-11" width="14" height="10" fill="#55B947"/><text x="${affiliateLabelX}" y="0">소속기관</text>`,
    `<text x="${markerX}" y="0">${showLawCounts ? "법령수: (법 n)·회색 숫자 · " : ""}(가/나) 직무등급 · (연) 연구직 · (지) 지도직 · (전) 전문직·전문경력관 · (임) 임기제 · (별) 별정직 · (특) 특정직 · (책) 책임운영 · (총) 총액 · (자) 자율 · (평) 평가 · (한) 한시</text>`,
    `</g>`,
  ].join("");
}

function svgLawIndex(page) {
  const parts = [
    `<text x="42" y="128" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="700" fill="#374151">부서별 소관법령 수와 대표 법령</text>`,
  ];
  const columns = 2;
  const rows = 5;
  const columnWidth = 500;
  const columnGap = 38;
  const rowHeight = 105;
  for (const [index, entry] of page.lawEntries.entries()) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const left = 42 + column * (columnWidth + columnGap);
    const top = 146 + row * rowHeight;
    parts.push(`<line x1="${left}" y1="${top}" x2="${left + columnWidth}" y2="${top}" stroke="#D1D5DB" stroke-width="0.8"/>`);
    parts.push(`<text x="${left}" y="${top + 26}" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="700" fill="#111827">${xmlEscape(entry.name)}</text>`);
    parts.push(`<text x="${left + columnWidth}" y="${top + 26}" text-anchor="end" font-family="Malgun Gothic, sans-serif" font-size="12" font-weight="700" fill="#4B5563">법령 ${entry.lawCount}건</text>`);
    entry.laws.forEach((law, lawIndex) => {
      parts.push(`<text x="${left}" y="${top + 54 + lawIndex * 20}" font-family="Malgun Gothic, sans-serif" font-size="11.5" fill="#4B5563">· ${xmlEscape(law.법령명)}</text>`);
    });
  }
  parts.push(`<line x1="42" y1="675" x2="${SLIDE_SIZE.width - 42}" y2="675" stroke="#D1D5DB" stroke-width="0.8"/>`);
  parts.push(`<text x="42" y="691" font-family="Malgun Gothic, sans-serif" font-size="10" fill="#6B7280">공동소관 법령은 담당 부서별로 중복 표기될 수 있습니다.</text>`);
  return parts.join("\n");
}
