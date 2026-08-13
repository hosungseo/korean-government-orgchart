import { xmlEscape } from "./utils.mjs";

export const ORGANIZATION_COMPARISON_SHEET_SIZE = Object.freeze({
  width: 510.24,
  height: 756.84,
});

const COLORS = Object.freeze({
  ink: "#172A3A",
  muted: "#5E6F80",
  quiet: "#8795A5",
  divider: "#DCE3EA",
  panelLine: "#C7D1DC",
  panelFill: "#FFFFFF",
  beforeLine: "#8D9AA8",
  beforeHeader: "#F1F4F7",
  beforeHeaderLine: "#A8B4C0",
  afterLine: "#557B99",
  afterHeader: "#EAF2F8",
  afterHeaderLine: "#789AB5",
  dutyFill: "#F7F9FB",
});

/**
 * Render two complete organization hierarchies without reorganization arrows.
 *
 * Rows stay aligned for quick before/after scanning, but each side owns an
 * independent vertical backbone and exact parent-to-child connectors. No line
 * crosses the center gutter and no color is used as the sole carrier of meaning.
 */
export function renderOrganizationComparisonSheetSvg(spec = {}) {
  const { width, height } = ORGANIZATION_COMPARISON_SHEET_SIZE;
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  if (!rows.length) throw new Error("조직체계 비교도에는 한 개 이상의 조직 행이 필요합니다.");

  const gutter = 14;
  const columnWidth = (width - gutter) / 2;
  const columns = {
    before: { x: 0, width: columnWidth, side: "before" },
    after: { x: columnWidth + gutter, width: columnWidth, side: "after" },
  };
  const columnHeaderY = 65;
  const rowTop = 98;
  const rowGap = 6.5;
  const footerLineY = height - 13;
  const footerTextY = height - 4.7;
  const availableHeight = footerLineY - rowTop - 3;
  const requested = rows.map((row) => Math.max(34, Number(row.cleanHeight ?? row.height) || 78));
  const totalGaps = rowGap * Math.max(0, rows.length - 1);
  const scale = Math.min(1, (availableHeight - totalGaps) / Math.max(1, requested.reduce((sum, value) => sum + value, 0)));
  const heights = requested.map((value) => value * scale);
  const placements = [];
  let cursorY = rowTop;
  rows.forEach((row, index) => {
    placements.push({ row, y: cursorY, height: heights[index] });
    cursorY += heights[index] + rowGap;
  });

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">`,
    `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    renderHeader(spec, width),
    renderColumnHeader(columns.before, columnHeaderY, "개편 전", "기존 조직체계"),
    renderColumnHeader(columns.after, columnHeaderY, "개편 후", "개편 조직체계"),
    `<line x1="${round(width / 2)}" y1="${columnHeaderY}" x2="${round(width / 2)}" y2="${round(footerLineY - 5)}" stroke="${COLORS.divider}" stroke-width="0.75"/>`,
  ];

  for (const column of Object.values(columns)) {
    const first = placements[0];
    const last = placements.at(-1);
    const trunkX = column.x + 8;
    const firstY = groupHeaderCenterY(first.y);
    const lastY = groupHeaderCenterY(last.y);
    parts.push(`<path data-backbone="${column.side}" d="M ${round(trunkX)} ${round(firstY)} V ${round(lastY)}" fill="none" stroke="${sideLine(column.side)}" stroke-width="1.05" stroke-linecap="square"/>`);
  }

  placements.forEach(({ row, y, height: rowHeight }, index) => {
    parts.push(`<g data-comparison-row="${index + 1}" data-row-key="${xmlEscape(row.key || String(index + 1))}">`);
    parts.push(renderGroupPanel(row.before || {}, columns.before, y, rowHeight));
    parts.push(renderGroupPanel(row.after || {}, columns.after, y, rowHeight));
    parts.push(`</g>`);
  });

  parts.push(`<line x1="0" y1="${round(footerLineY)}" x2="${width}" y2="${round(footerLineY)}" stroke="#D2DAE4" stroke-width="0.7"/>`);
  parts.push(`<text x="0" y="${round(footerTextY)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.2" fill="${COLORS.muted}">${xmlEscape(spec.footer || "제공 이미지 기반 재작도 · 변경선·변경주석 제외 · 공식 원문 대조 전 검토용")}</text>`);
  parts.push(`<text x="${width}" y="${round(footerTextY)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.2" font-weight="700" fill="${COLORS.ink}">A4 세로 · 1쪽</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

function renderHeader(spec, width) {
  const title = spec.title || "조직체계 전후 비교";
  const subtitle = spec.subtitle || "변경선을 제외하고 개편 전·후 설치관계와 하부조직만 정렬";
  return [
    `<text x="0" y="9" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.9" font-weight="700" letter-spacing="0.95" fill="#617286">ORGANIZATION STRUCTURE · 제공자료 재구성</text>`,
    `<text x="0" y="29" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="17.2" font-weight="700" letter-spacing="-0.48" fill="${COLORS.ink}">${xmlEscape(title)}</text>`,
    `<text x="0" y="45.5" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.4" font-weight="500" fill="${COLORS.muted}">${xmlEscape(subtitle)}</text>`,
    `<text x="${width}" y="10" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.3" font-weight="700" letter-spacing="0.45" fill="${COLORS.quiet}">BEFORE / AFTER</text>`,
    `<line x1="0" y1="55.5" x2="${width}" y2="55.5" stroke="#9DAEBF" stroke-width="0.8"/>`,
  ].join("");
}

function renderColumnHeader(column, y, title, subtitle) {
  const after = column.side === "after";
  return [
    `<rect x="${round(column.x)}" y="${y}" width="${round(column.width)}" height="24" rx="4" fill="${after ? "#E7F0F7" : "#F1F4F7"}" stroke="${after ? "#A7BBCB" : "#CED6DE"}" stroke-width="0.75"/>`,
    `<rect x="${round(column.x)}" y="${y}" width="4" height="24" rx="2" fill="${sideLine(column.side)}"/>`,
    `<text x="${round(column.x + 12)}" y="${round(y + 15.5)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="8.3" font-weight="700" fill="${COLORS.ink}">${title}</text>`,
    `<text x="${round(column.x + column.width - 9)}" y="${round(y + 15.2)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.7" font-weight="600" fill="${COLORS.muted}">${subtitle}</text>`,
  ].join("");
}

function renderGroupPanel(panel, column, y, height) {
  if (panel.compact) return renderCompactPanel(panel, column, y, height);
  const panelX = column.x + 18;
  const panelWidth = column.width - 18;
  const headerX = panelX + 6;
  const headerY = y + 5;
  const headerWidth = panelWidth - 12;
  const headerHeight = 23;
  const trunkX = column.x + 8;
  const connectorColor = sideLine(column.side);
  const headerFill = column.side === "after" ? COLORS.afterHeader : COLORS.beforeHeader;
  const headerLine = column.side === "after" ? COLORS.afterHeaderLine : COLORS.beforeHeaderLine;
  const gradeWidth = panel.grade ? 37 : 0;
  const nameX = headerX + (gradeWidth ? gradeWidth + 10 : 10);
  const nameMaxWidth = headerWidth - (nameX - headerX) - 8;
  const units = Array.isArray(panel.units) ? panel.units : [];
  const contentX = panelX + 8;
  const contentWidth = panelWidth - 16;
  const unitColumns = units.length <= 1 ? 1 : 2;
  const unitGapX = 4;
  const unitGapY = 4.2;
  const unitHeight = 13.4;
  const unitWidth = (contentWidth - unitGapX * (unitColumns - 1)) / unitColumns;
  const unitRows = units.length ? Math.ceil(units.length / unitColumns) : 0;
  const unitsY = headerY + headerHeight + 10;
  const gridHeight = unitRows ? unitRows * unitHeight + (unitRows - 1) * unitGapY : 0;
  const dutyY = unitsY + gridHeight + (units.length ? 6.5 : 1.5);
  const panelBottom = y + height;
  const pieces = [
    `<rect x="${round(panelX)}" y="${round(y)}" width="${round(panelWidth)}" height="${round(height)}" rx="4" fill="${COLORS.panelFill}" stroke="${COLORS.panelLine}" stroke-width="0.78"/>`,
    `<path data-group-branch="${column.side}" d="M ${round(trunkX)} ${round(headerY + headerHeight / 2)} H ${round(headerX + 0.8)}" fill="none" stroke="${connectorColor}" stroke-width="1.05" stroke-linecap="square"/>`,
    `<circle cx="${round(trunkX)}" cy="${round(headerY + headerHeight / 2)}" r="1.35" fill="#FFFFFF" stroke="${connectorColor}" stroke-width="0.9"/>`,
  ];

  if (units.length) {
    const headerCenterX = headerX + headerWidth / 2;
    const busYs = [];
    for (let row = 0; row < unitRows; row += 1) busYs.push(unitsY + row * (unitHeight + unitGapY) - 3.5);
    pieces.push(`<path data-unit-stem="${column.side}" d="M ${round(headerCenterX)} ${round(headerY + headerHeight - 0.7)} V ${round(busYs.at(-1))}" fill="none" stroke="${connectorColor}" stroke-width="0.85" stroke-linecap="square"/>`);
    for (let row = 0; row < unitRows; row += 1) {
      const rowStart = row * unitColumns;
      const rowItems = units.slice(rowStart, rowStart + unitColumns);
      const centers = rowItems.map((_unit, col) => {
        if (rowItems.length === 1 && unitColumns === 2) return contentX + contentWidth / 2;
        return contentX + col * (unitWidth + unitGapX) + unitWidth / 2;
      });
      const busY = busYs[row];
      if (centers.length > 1) pieces.push(`<path d="M ${round(centers[0])} ${round(busY)} H ${round(centers.at(-1))}" fill="none" stroke="${connectorColor}" stroke-width="0.85" stroke-linecap="square"/>`);
      centers.forEach((center) => pieces.push(`<path d="M ${round(center)} ${round(busY)} V ${round(unitsY + row * (unitHeight + unitGapY) + 0.75)}" fill="none" stroke="${connectorColor}" stroke-width="0.85" stroke-linecap="square"/>`));
    }
  }

  pieces.push(`<rect x="${round(headerX)}" y="${round(headerY)}" width="${round(headerWidth)}" height="${headerHeight}" rx="3" fill="${headerFill}" stroke="${headerLine}" stroke-width="0.85"/>`);
  pieces.push(`<line x1="${round(headerX + 4)}" y1="${round(headerY + 2.4)}" x2="${round(headerX + headerWidth - 4)}" y2="${round(headerY + 2.4)}" stroke="${connectorColor}" stroke-width="1.15" stroke-linecap="round"/>`);
  if (panel.grade) {
    pieces.push(`<rect x="${round(headerX + 5)}" y="${round(headerY + 5.4)}" width="${gradeWidth}" height="10.5" rx="5.25" fill="#FFFFFF" stroke="${headerLine}" stroke-width="0.65"/>`);
    pieces.push(`<text x="${round(headerX + 5 + gradeWidth / 2)}" y="${round(headerY + 12.85)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.15" font-weight="700" fill="${COLORS.muted}">${xmlEscape(panel.grade)}</text>`);
  }
  pieces.push(`<text x="${round(nameX)}" y="${round(headerY + 14.55)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(panel.title || "", nameMaxWidth, 8.7, 6.8)}" font-weight="700" fill="${COLORS.ink}">${xmlEscape(panel.title || "")}</text>`);

  units.forEach((unit, index) => {
    const item = typeof unit === "string" ? { name: unit } : unit;
    const row = Math.floor(index / unitColumns);
    const rowItems = units.slice(row * unitColumns, row * unitColumns + unitColumns);
    const col = index % unitColumns;
    const unitX = rowItems.length === 1 && unitColumns === 2
      ? contentX + (contentWidth - unitWidth) / 2
      : contentX + col * (unitWidth + unitGapX);
    const unitY = unitsY + row * (unitHeight + unitGapY);
    pieces.push(`<rect x="${round(unitX)}" y="${round(unitY)}" width="${round(unitWidth)}" height="${unitHeight}" rx="2.1" fill="#FFFFFF" stroke="#B5C1CD" stroke-width="0.72"/>`);
    pieces.push(`<text x="${round(unitX + unitWidth / 2)}" y="${round(unitY + 8.95)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(item.name, unitWidth - 7, 6.05, 4.7)}" font-weight="600" fill="${COLORS.ink}">${xmlEscape(item.name)}</text>`);
  });

  if (panel.duties && panelBottom - dutyY >= 15) {
    const dutyHeight = panelBottom - dutyY - 5;
    const labelWidth = 31;
    const dutyFont = 5.55;
    const lineHeight = 7;
    const maxLines = Math.max(1, Math.floor((dutyHeight - 7) / lineHeight));
    const lines = wrapText(panel.duties, Math.max(15, Math.floor((contentWidth - 12) / (dutyFont * 0.92))), maxLines);
    pieces.push(`<rect x="${round(contentX)}" y="${round(dutyY)}" width="${round(contentWidth)}" height="${round(dutyHeight)}" rx="2.5" fill="${COLORS.dutyFill}"/>`);
    pieces.push(`<text x="${round(contentX + 6)}" y="${round(dutyY + 8)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.15" font-weight="700" fill="${connectorColor}">주요 업무</text>`);
    pieces.push(`<text x="${round(contentX + labelWidth)}" y="${round(dutyY + 8)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${dutyFont}" font-weight="500" fill="${COLORS.muted}">${lines.map((line, index) => `<tspan x="${round(contentX + labelWidth)}" dy="${index ? lineHeight : 0}">${xmlEscape(line)}</tspan>`).join("")}</text>`);
  }
  return pieces.join("");
}

function renderCompactPanel(panel, column, y, height) {
  const panelX = column.x + 18;
  const panelWidth = column.width - 18;
  const headerX = panelX + 6;
  const headerY = y + 5;
  const headerWidth = panelWidth - 12;
  const headerHeight = Math.max(22, height - 10);
  const trunkX = column.x + 8;
  const connectorColor = sideLine(column.side);
  const after = column.side === "after";
  return [
    `<rect x="${round(panelX)}" y="${round(y)}" width="${round(panelWidth)}" height="${round(height)}" rx="4" fill="#FFFFFF" stroke="${COLORS.panelLine}" stroke-width="0.78"/>`,
    `<path d="M ${round(trunkX)} ${round(headerY + headerHeight / 2)} H ${round(headerX + 0.8)}" fill="none" stroke="${connectorColor}" stroke-width="1.05" stroke-linecap="square"/>`,
    `<circle cx="${round(trunkX)}" cy="${round(headerY + headerHeight / 2)}" r="1.35" fill="#FFFFFF" stroke="${connectorColor}" stroke-width="0.9"/>`,
    `<rect x="${round(headerX)}" y="${round(headerY)}" width="${round(headerWidth)}" height="${round(headerHeight)}" rx="3" fill="${after ? COLORS.afterHeader : COLORS.beforeHeader}" stroke="${after ? COLORS.afterHeaderLine : COLORS.beforeHeaderLine}" stroke-width="0.85"/>`,
    `<line x1="${round(headerX + 4)}" y1="${round(headerY + 2.4)}" x2="${round(headerX + headerWidth - 4)}" y2="${round(headerY + 2.4)}" stroke="${connectorColor}" stroke-width="1.15"/>`,
    `<text x="${round(headerX + 10)}" y="${round(headerY + headerHeight / 2 + 3)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.9" font-weight="700" fill="${COLORS.ink}">${xmlEscape(panel.title || "")}</text>`,
  ].join("");
}

function groupHeaderCenterY(y) {
  return y + 5 + 23 / 2;
}

function sideLine(side) {
  return side === "after" ? COLORS.afterLine : COLORS.beforeLine;
}

function fitFont(value, availableWidth, maximum, minimum) {
  const length = Math.max(1, [...String(value || "")].length);
  const estimated = availableWidth / (length * 0.91);
  return round(Math.max(minimum, Math.min(maximum, estimated)));
}

function wrapText(value, maxChars, maxLines) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || maxLines <= 0) return [];
  const tokens = text.split(/(?= · )|(?<= · )|\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current ? `${current}${token.startsWith(" · ") ? "" : " "}${token}` : token;
    if ([...candidate].length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current.trim());
    current = token.trim();
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current.trim());
  if (lines.length === maxLines && [...lines.at(-1)].length > maxChars) {
    lines[lines.length - 1] = `${[...lines.at(-1)].slice(0, Math.max(1, maxChars - 1)).join("")}…`;
  }
  return lines;
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}
