import { xmlEscape } from "./utils.mjs";

export const REORGANIZATION_SHEET_SIZES = Object.freeze({
  landscape: Object.freeze({ width: 756.84, height: 510.24 }),
  portrait: Object.freeze({ width: 510.24, height: 756.84 }),
});
export const REORGANIZATION_SHEET_SIZE = REORGANIZATION_SHEET_SIZES.landscape;

const COLORS = Object.freeze({
  ink: "#172A3A",
  muted: "#647487",
  quiet: "#8795A5",
  line: "#9BAABC",
  panelLine: "#CBD5E1",
  panelFill: "#FFFFFF",
  softFill: "#F7F9FC",
  headerFill: "#EDF3F8",
  headerLine: "#9FB0C2",
  move: "#245E8B",
  moveFill: "#E8F1F8",
  new: "#347A55",
  newFill: "#E8F4EC",
  grade: "#A9550A",
  gradeFill: "#FFF0DF",
  close: "#687586",
  closeFill: "#EEF1F4",
});

const TYPE_STYLE = Object.freeze({
  move: { line: COLORS.move, fill: COLORS.moveFill, label: "이관" },
  merge: { line: COLORS.move, fill: COLORS.moveFill, label: "통합" },
  new: { line: COLORS.new, fill: COLORS.newFill, label: "신설" },
  grade: { line: COLORS.grade, fill: COLORS.gradeFill, label: "상향" },
  close: { line: COLORS.close, fill: COLORS.closeFill, label: "폐지" },
});

/**
 * Render a dense A4 before/change/after organization sheet.
 *
 * The legal hierarchy remains in the two side panels.  Cross-organization
 * moves are written in the middle lane, so the only drawn connectors are five
 * short, exact, row-level arrows with no crossings or ambiguous endpoints.
 */
export function renderReorganizationSheetSvg(spec = {}) {
  const portrait = spec.paper === "a4-portrait" || spec.orientation === "portrait";
  const size = portrait ? REORGANIZATION_SHEET_SIZES.portrait : REORGANIZATION_SHEET_SIZES.landscape;
  const width = size.width;
  const height = size.height;
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  if (!rows.length) throw new Error("조직개편 비교도에는 한 개 이상의 변경 행이 필요합니다.");

  const columns = portrait
    ? {
        before: { x: 0, width: 155, portrait: true },
        change: { x: 163, width: 184.24, portrait: true },
        after: { x: 355.24, width: 155, portrait: true },
      }
    : {
        before: { x: 0, width: 207.5, portrait: false },
        change: { x: 219, width: 318.84, portrait: false },
        after: { x: 549.34, width: 207.5, portrait: false },
      };
  const columnHeaderY = portrait ? 76 : 64;
  const rowTop = portrait ? 99 : 87;
  const gap = portrait ? 6 : 5;
  const footerLineY = portrait ? height - 15 : height - 13.74;
  const footerTextY = portrait ? height - 5.6 : height - 5.24;
  const available = footerLineY - rowTop - 4;
  const requested = rows.map((row) => Number(row.height) || 72);
  const requestedTotal = requested.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, rows.length - 1);
  const scale = requestedTotal > available
    ? (available - gap * Math.max(0, rows.length - 1)) / Math.max(1, requestedTotal - gap * Math.max(0, rows.length - 1))
    : 1;
  const heights = requested.map((value) => value * scale);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">`);
  parts.push(`<defs><marker id="row-arrow" viewBox="0 0 8 8" refX="7.2" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="${COLORS.line}"/></marker></defs>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#FFFFFF"/>`);
  parts.push(renderHeader(spec, width, { portrait }));
  parts.push(renderColumnHeader(columns.before, columnHeaderY, "개편 전", "기존 설치·업무"));
  parts.push(renderColumnHeader(columns.change, columnHeaderY, "변경 레인", portrait ? "이동·신설·상향" : "기능 이동을 문자로 표시"));
  parts.push(renderColumnHeader(columns.after, columnHeaderY, "개편 후", "목표 설치·업무"));

  let y = rowTop;
  rows.forEach((row, index) => {
    const rowHeight = heights[index];
    const accent = row.accent || (index % 2 ? COLORS.new : COLORS.move);
    parts.push(`<g data-row="${index + 1}" data-row-key="${xmlEscape(row.key || String(index + 1))}">`);
    parts.push(`<rect x="${columns.change.x}" y="${round(y)}" width="${columns.change.width}" height="${round(rowHeight)}" rx="4" fill="${COLORS.softFill}" stroke="#E2E8F0" stroke-width="0.7"/>`);
    parts.push(renderRowConnector(columns, y, accent));
    parts.push(renderSidePanel(row.before || {}, columns.before, y, rowHeight, { side: "before", accent }));
    parts.push(renderSidePanel(row.after || {}, columns.after, y, rowHeight, { side: "after", accent }));
    parts.push(renderChangeLane(row.change || {}, columns.change, y, rowHeight, accent));
    parts.push(`</g>`);
    y += rowHeight + gap;
  });

  parts.push(`<line x1="0" y1="${round(footerLineY)}" x2="${width}" y2="${round(footerLineY)}" stroke="#D2DAE4" stroke-width="0.7"/>`);
  parts.push(`<text x="0" y="${round(footerTextY)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.4" fill="${COLORS.muted}">${xmlEscape(spec.footer || "제공자료 기반 재작도 · 조직·업무 문구는 원문 대조 전 검토용")}</text>`);
  parts.push(`<text x="${width}" y="${round(footerTextY)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.4" font-weight="700" fill="${COLORS.ink}">A4 ${portrait ? "세로" : "가로"} · 1쪽</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

function renderHeader(spec, width, { portrait = false } = {}) {
  const title = spec.title || "조직개편 전후 비교";
  const subtitle = spec.subtitle || "대응 중심 배열 · 선 교차 없는 변경 레인";
  if (portrait) {
    return [
      `<text x="0" y="9" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.9" font-weight="700" letter-spacing="0.95" fill="#617286">REORGANIZATION MAP · 제공자료 재구성</text>`,
      `<text x="0" y="29" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="17.2" font-weight="700" letter-spacing="-0.48" fill="${COLORS.ink}">${xmlEscape(title)}</text>`,
      `<text x="0" y="45" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.5" font-weight="500" fill="${COLORS.muted}">${xmlEscape(subtitle)}</text>`,
      renderLegend(width, { portrait: true }),
      `<line x1="0" y1="70.5" x2="${width}" y2="70.5" stroke="#9DAEBF" stroke-width="0.8"/>`,
    ].join("");
  }
  return [
    `<text x="0" y="9" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.1" font-weight="700" letter-spacing="1.05" fill="#617286">REORGANIZATION MAP · 제공자료 재구성</text>`,
    `<text x="0" y="31" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="19.2" font-weight="700" letter-spacing="-0.55" fill="${COLORS.ink}">${xmlEscape(title)}</text>`,
    `<text x="0" y="48" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.1" font-weight="500" fill="${COLORS.muted}">${xmlEscape(subtitle)}</text>`,
    renderLegend(width),
    `<line x1="0" y1="57.5" x2="${width}" y2="57.5" stroke="#9DAEBF" stroke-width="0.8"/>`,
  ].join("");
}

function renderLegend(width, { portrait = false } = {}) {
  const items = [
    ["move", "이관·통합"],
    ["new", "신설"],
    ["grade", "직급·위상"],
    ["close", "폐지·축소"],
  ];
  const itemWidth = portrait ? 65 : 61;
  const startX = width - items.length * itemWidth;
  const boxY = portrait ? 54 : 20;
  const textY = portrait ? 60.3 : 26.4;
  const pieces = [portrait
    ? `<text x="0" y="60.3" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.4" font-weight="700" letter-spacing="0.4" fill="${COLORS.quiet}">변경 유형</text>`
    : `<text x="${width}" y="9" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.7" font-weight="700" letter-spacing="0.65" fill="${COLORS.quiet}">CHANGE LEGEND</text>`];
  items.forEach(([type, label], index) => {
    const style = TYPE_STYLE[type];
    const x = startX + index * itemWidth;
    pieces.push(`<rect x="${round(x)}" y="${boxY}" width="8" height="8" rx="2" fill="${style.fill}" stroke="${style.line}" stroke-width="0.7"/>`);
    pieces.push(`<text x="${round(x + 12)}" y="${textY}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${portrait ? 5.45 : 5.8}" font-weight="600" fill="${COLORS.muted}">${label}</text>`);
  });
  if (!portrait) pieces.push(`<text x="${width}" y="46.5" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.5" fill="${COLORS.quiet}">※ 법정 순서가 아닌 전후 대응 중심 배열</text>`);
  return pieces.join("");
}

function renderColumnHeader(column, y, title, subtitle) {
  return `<g><rect x="${column.x}" y="${y}" width="${column.width}" height="18" rx="4" fill="#F1F4F8" stroke="#D6DEE8" stroke-width="0.65"/><text x="${round(column.x + 8)}" y="${round(y + 11.8)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.4" font-weight="700" fill="${COLORS.ink}">${title}</text><text x="${round(column.x + column.width - 8)}" y="${round(y + 11.7)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.5" fill="${COLORS.muted}">${subtitle}</text></g>`;
}

function renderRowConnector(columns, y, accent) {
  const centerY = y + 14.5;
  const leftStart = columns.before.x + columns.before.width - 5.4;
  const leftEnd = columns.change.x + 8;
  const rightStart = columns.change.x + columns.change.width - 8;
  const rightEnd = columns.after.x + 6.2;
  return [
    `<path d="M ${round(leftStart)} ${round(centerY)} H ${round(leftEnd)}" fill="none" stroke="${accent}" stroke-width="1.05" stroke-linecap="square"/>`,
    `<circle cx="${round(leftStart)}" cy="${round(centerY)}" r="1.25" fill="#FFFFFF" stroke="${accent}" stroke-width="0.85"/>`,
    `<path d="M ${round(rightStart)} ${round(centerY)} H ${round(rightEnd)}" fill="none" stroke="${COLORS.line}" stroke-width="1.05" stroke-linecap="square" marker-end="url(#row-arrow)"/>`,
  ].join("");
}

function renderSidePanel(panel, column, y, height, { side, accent }) {
  if (panel.compact) return renderCompactPanel(panel, column, y, height, { side, accent });
  const portrait = Boolean(column.portrait);
  const x = column.x;
  const width = column.width;
  const headerX = x + 5;
  const headerY = y + 4;
  const headerWidth = width - 10;
  const headerHeight = portrait ? 22.5 : 21;
  const gradeWidth = panel.grade ? 35 : 0;
  const gradeTone = panel.gradeTone === "grade" ? TYPE_STYLE.grade : null;
  const status = panel.status ? String(panel.status) : "";
  const statusWidth = status ? Math.min(48, 12 + status.length * 5.1) : 0;
  const nameX = headerX + (gradeWidth ? gradeWidth + 8 : 9);
  const nameMaxWidth = headerWidth - (nameX - headerX) - statusWidth - 10;
  const units = panel.units || [];
  const unitColumns = panel.unitColumns || unitColumnCount(units.length);
  const unitGap = portrait ? 3 : 2.4;
  const unitHeight = portrait ? 13.2 : 11.2;
  const unitsX = x + 7;
  const unitsY = y + (portrait ? 30 : 28);
  const unitsWidth = width - 14;
  const unitWidth = unitColumns > 0 ? (unitsWidth - unitGap * (unitColumns - 1)) / unitColumns : unitsWidth;
  const unitRows = units.length ? Math.ceil(units.length / unitColumns) : 0;
  const gridHeight = unitRows ? unitRows * unitHeight + (unitRows - 1) * unitGap : 0;
  const dutiesY = unitsY + gridHeight + (units.length ? 3.5 : 0);
  const dutyFont = portrait ? 5.75 : 5.55;
  const dutyLineHeight = portrait ? 7.05 : 6.55;
  const dutyLines = Math.max(0, Math.floor((y + height - 3.5 - dutiesY) / dutyLineHeight) + 1);
  const fill = side === "after" ? "#FEFFFF" : COLORS.panelFill;
  const pieces = [
    `<rect x="${x}" y="${round(y)}" width="${width}" height="${round(height)}" rx="4" fill="${fill}" stroke="${COLORS.panelLine}" stroke-width="0.8"/>`,
    `<rect x="${round(headerX)}" y="${round(headerY)}" width="${round(headerWidth)}" height="${headerHeight}" rx="3" fill="${gradeTone?.fill || COLORS.headerFill}" stroke="${gradeTone?.line || COLORS.headerLine}" stroke-width="0.8"/>`,
    `<line x1="${round(headerX + 4)}" y1="${round(headerY + 2.2)}" x2="${round(headerX + headerWidth - 4)}" y2="${round(headerY + 2.2)}" stroke="${gradeTone?.line || accent}" stroke-width="1.15" stroke-linecap="round"/>`,
  ];
  if (panel.grade) {
    pieces.push(`<rect x="${round(headerX + 5)}" y="${round(headerY + 5.1)}" width="${gradeWidth}" height="10.2" rx="5.1" fill="#FFFFFF" stroke="${gradeTone?.line || COLORS.headerLine}" stroke-width="0.65"/>`);
    pieces.push(`<text x="${round(headerX + 5 + gradeWidth / 2)}" y="${round(headerY + 12.35)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.25" font-weight="700" fill="${gradeTone?.line || COLORS.muted}">${xmlEscape(panel.grade)}</text>`);
  }
  pieces.push(`<text x="${round(nameX)}" y="${round(headerY + 14.15)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(panel.title || "", nameMaxWidth, 8.55, 6.7)}" font-weight="700" fill="${COLORS.ink}">${xmlEscape(panel.title || "")}</text>`);
  if (status) {
    pieces.push(`<rect x="${round(headerX + headerWidth - statusWidth - 5)}" y="${round(headerY + 5.1)}" width="${round(statusWidth)}" height="10.2" rx="5.1" fill="${TYPE_STYLE.grade.fill}" stroke="${TYPE_STYLE.grade.line}" stroke-width="0.65"/>`);
    pieces.push(`<text x="${round(headerX + headerWidth - 5 - statusWidth / 2)}" y="${round(headerY + 12.35)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.05" font-weight="700" fill="${TYPE_STYLE.grade.line}">${xmlEscape(status)}</text>`);
  }
  units.forEach((unit, index) => {
    const item = typeof unit === "string" ? { name: unit } : unit;
    const col = index % unitColumns;
    const row = Math.floor(index / unitColumns);
    const unitX = unitsX + col * (unitWidth + unitGap);
    const unitY = unitsY + row * (unitHeight + unitGap);
    const tone = item.tone ? TYPE_STYLE[item.tone] : null;
    pieces.push(`<rect x="${round(unitX)}" y="${round(unitY)}" width="${round(unitWidth)}" height="${unitHeight}" rx="2.3" fill="${tone?.fill || "#FFFFFF"}" stroke="${tone?.line || "#B8C4D1"}" stroke-width="0.7"/>`);
    pieces.push(`<text x="${round(unitX + unitWidth / 2)}" y="${round(unitY + (portrait ? 8.85 : 7.55))}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(item.name, unitWidth - 7, portrait ? 6.05 : 5.75, 4.55)}" font-weight="${tone ? 700 : 600}" fill="${tone?.line || COLORS.ink}">${xmlEscape(item.name)}</text>`);
  });
  if (panel.duties && dutyLines > 0) {
    const lines = wrapText(panel.duties, Math.floor((width - 14) / (dutyFont * 0.82)), dutyLines);
    pieces.push(`<text x="${round(x + 7)}" y="${round(dutiesY + dutyFont)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${dutyFont}" font-weight="500" fill="${COLORS.muted}">${lines.map((line, index) => `<tspan x="${round(x + 7)}" dy="${index ? dutyLineHeight : 0}">${xmlEscape(line)}</tspan>`).join("")}</text>`);
  }
  return pieces.join("");
}

function renderCompactPanel(panel, column, y, height, { accent }) {
  const x = column.x;
  const width = column.width;
  const grade = panel.grade ? `<text x="${round(x + 10)}" y="${round(y + height / 2 + 2.3)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.5" font-weight="700" fill="${COLORS.muted}">${xmlEscape(panel.grade)}</text>` : "";
  const titleX = x + (panel.grade ? 53 : 10);
  return `<g><rect x="${x}" y="${round(y)}" width="${width}" height="${round(height)}" rx="4" fill="#FFFFFF" stroke="${COLORS.panelLine}" stroke-width="0.8"/><line x1="${round(x + 4)}" y1="${round(y + 3)}" x2="${round(x + width - 4)}" y2="${round(y + 3)}" stroke="${accent}" stroke-width="1.2"/><text x="${round(titleX)}" y="${round(y + height / 2 + 3.1)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="8.1" font-weight="700" fill="${COLORS.ink}">${xmlEscape(panel.title || "")}</text>${grade}</g>`;
}

function renderChangeLane(change, column, y, height, accent) {
  const portrait = Boolean(column.portrait);
  const x = column.x;
  const width = column.width;
  const title = change.title || "변경";
  const titleWidth = Math.max(70, Math.min(126, 35 + title.length * 7.2));
  const titleX = x + (width - titleWidth) / 2;
  const items = change.items || [];
  const availableHeight = Math.max(0, height - 29);
  const itemStep = items.length
    ? Math.min(portrait ? 27 : 16.3, Math.max(portrait ? 15 : 11.9, availableHeight / items.length))
    : 0;
  const itemBlockHeight = items.length ? (items.length - 1) * itemStep + 10.4 : 0;
  const itemStartY = portrait
    ? y + 28 + Math.max(0, (availableHeight - itemBlockHeight) / 2)
    : y + 28;
  const pieces = [
    `<rect x="${round(titleX)}" y="${round(y + 4)}" width="${round(titleWidth)}" height="21" rx="10.5" fill="#FFFFFF" stroke="${accent}" stroke-width="0.9"/>`,
    `<text x="${round(x + width / 2)}" y="${round(y + 17.7)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.7" font-weight="700" fill="${accent}">${xmlEscape(title)}</text>`,
  ];
  items.forEach((item, index) => {
    const style = TYPE_STYLE[item.type] || TYPE_STYLE.move;
    const itemY = itemStartY + index * itemStep;
    const badgeWidth = 27;
    const textX = x + 43;
    const textWidth = width - 52;
    const fontSize = fitFont(item.text || "", textWidth, 5.9, 4.9);
    pieces.push(`<rect x="${round(x + 9)}" y="${round(itemY)}" width="${badgeWidth}" height="10.4" rx="5.2" fill="${style.fill}" stroke="${style.line}" stroke-width="0.65"/>`);
    pieces.push(`<text x="${round(x + 9 + badgeWidth / 2)}" y="${round(itemY + 7.15)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.9" font-weight="700" fill="${style.line}">${xmlEscape(item.label || style.label)}</text>`);
    pieces.push(`<text x="${round(textX)}" y="${round(itemY + 7.25)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" font-weight="600" fill="${COLORS.ink}">${xmlEscape(item.text || "")}</text>`);
  });
  return pieces.join("");
}

function unitColumnCount(count) {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  if (count === 4) return 2;
  return 3;
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
  const consumed = lines.join(" ").replace(/\s+/g, " ");
  if (consumed.length < text.length && lines.length) {
    const last = [...lines.at(-1)];
    lines[lines.length - 1] = `${last.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
  }
  return lines.slice(0, maxLines);
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}
