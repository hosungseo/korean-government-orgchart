import { xmlEscape } from "./utils.mjs";

export const ORIGINAL_COMPARISON_SIZE = Object.freeze({ width: 510.24, height: 756.84 });

const THEME = Object.freeze({
  ink: "#202020",
  muted: "#46505A",
  hierarchy: "#666666",
  defaultFill: "#FFFFFF",
  defaultLine: "#777777",
  yellow: "#FFF20A",
  green: "#BDF4C7",
  greenLine: "#2C9B4D",
  purple: "#DED8F2",
  purpleLine: "#6357B4",
  orange: "#F36B14",
  redLine: "#D53D35",
  magentaLine: "#D94CC8",
  blueLine: "#3156C7",
});

/**
 * Faithful technical redraft of the supplied two-column organization chart.
 * The original box hierarchy, dense notes and change highlighting are kept;
 * only the cross-column change arrows are omitted.
 */
export function renderOriginalOrganizationComparisonSvg(spec = {}) {
  const { width, height } = ORIGINAL_COMPARISON_SIZE;
  const left = normalizeColumn(spec.before, {
    key: "before",
    label: "개편 전",
    x: 17,
    headerX: 34,
    childX: 47,
    textRight: 244,
  });
  const right = normalizeColumn(spec.after, {
    key: "after",
    label: "개편 후",
    x: 270,
    headerX: 287,
    childX: 300,
    textRight: 507,
  });

  const pieces = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">`,
    `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    renderColumnCaption(left),
    renderColumnCaption(right),
    `<line x1="255.12" y1="10" x2="255.12" y2="744" stroke="#E1E1E1" stroke-width="0.65"/>`,
    renderColumn(left),
    renderColumn(right),
    `<text x="17" y="750.5" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.9" fill="#777777">제공 이미지 기반 원형 복원 · 좌우 변경선만 제외 · 공식 원문 대조 전 검토용</text>`,
    `<text x="507" y="750.5" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.9" font-weight="700" fill="#555555">A4 세로 · 1쪽</text>`,
    `</svg>`,
  ];
  return pieces.join("\n");
}

function normalizeColumn(source = {}, defaults) {
  return {
    ...defaults,
    ...source,
    groups: Array.isArray(source.groups) ? source.groups : [],
  };
}

function renderColumnCaption(column) {
  return [
    `<text x="${column.x}" y="13.5" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.1" font-weight="700" fill="#343434">${xmlEscape(column.label)}</text>`,
    `<line x1="${column.x}" y1="19.2" x2="${column.textRight}" y2="19.2" stroke="#A8A8A8" stroke-width="0.75"/>`,
  ].join("");
}

function renderColumn(column) {
  if (!column.groups.length) return "";
  const first = column.groups[0];
  const last = column.groups.at(-1);
  const trunkTop = first.y + mainBoxHeight(first) / 2;
  const trunkBottom = last.y + mainBoxHeight(last) / 2;
  const connectors = [
    `<path data-column-trunk="${column.key}" d="M ${column.x} ${round(trunkTop)} V ${round(trunkBottom)}" fill="none" stroke="${THEME.hierarchy}" stroke-width="0.9" stroke-linecap="square"/>`,
  ];
  const content = [];
  column.groups.forEach((group, index) => {
    connectors.push(renderGroupConnectors(group, column, index));
    content.push(renderGroupContent(group, column, index));
  });
  return `<g data-original-column="${column.key}">${connectors.join("")}${content.join("")}</g>`;
}

function renderGroupConnectors(group, column, index) {
  const headerHeight = mainBoxHeight(group);
  const headerCenterY = group.y + headerHeight / 2;
  const headerX = Number(group.headerX ?? column.headerX);
  const headerWidth = Number(group.headerWidth || 132);
  const items = Array.isArray(group.items) ? group.items : [];
  const pieces = [
    `<path data-group-link="${column.key}-${index + 1}" d="M ${column.x} ${round(headerCenterY)} H ${round(headerX + 0.6)}" fill="none" stroke="${THEME.hierarchy}" stroke-width="0.9" stroke-linecap="square"/>`,
  ];
  if (!items.length) return pieces.join("");

  const positions = layoutItems(group, column);
  const spineX = headerX + 11;
  const firstCenter = positions[0].y + positions[0].height / 2;
  const lastCenter = positions.at(-1).y + positions.at(-1).height / 2;
  pieces.push(`<path data-child-spine="${column.key}-${index + 1}" d="M ${round(spineX)} ${round(group.y + headerHeight - 0.6)} V ${round(lastCenter)}" fill="none" stroke="${THEME.hierarchy}" stroke-width="0.85" stroke-linecap="square"/>`);
  positions.forEach((position) => {
    pieces.push(`<path d="M ${round(spineX)} ${round(position.y + position.height / 2)} H ${round(position.x + 0.6)}" fill="none" stroke="${THEME.hierarchy}" stroke-width="0.85" stroke-linecap="square"/>`);
  });
  pieces.push(`<circle cx="${column.x}" cy="${round(headerCenterY)}" r="1.2" fill="#FFFFFF" stroke="${THEME.hierarchy}" stroke-width="0.75"/>`);
  return pieces.join("");
}

function renderGroupContent(group, column, index) {
  const headerX = Number(group.headerX ?? column.headerX);
  const headerWidth = Number(group.headerWidth || 132);
  const headerHeight = mainBoxHeight(group);
  const headerTone = toneStyle(group.tone || "yellow", { header: true });
  const outline = outlineStyle(group.outlineTone);
  const grade = String(group.grade || "").trim();
  const title = String(group.title || "");
  const gradeWidth = grade ? Math.min(43, Math.max(32, 20 + [...grade].length * 3.25)) : 0;
  const titleX = headerX + (grade ? gradeWidth + 3 : headerWidth / 2);
  const titleAnchor = grade ? "start" : "middle";
  const pieces = [`<g data-original-group="${column.key}-${index + 1}">`];

  if (outline) {
    pieces.push(`<rect x="${round(headerX - 4)}" y="${round(group.y - 4)}" width="${round(headerWidth + 8)}" height="${round(headerHeight + 8)}" fill="none" stroke="${outline.stroke}" stroke-width="1.25" stroke-dasharray="2.5 3"/>`);
  }
  pieces.push(`<rect x="${headerX}" y="${round(group.y)}" width="${headerWidth}" height="${headerHeight}" fill="${headerTone.fill}" stroke="${headerTone.stroke}" stroke-width="0.9"/>`);
  if (grade) {
    pieces.push(`<text x="${round(headerX + gradeWidth / 2)}" y="${round(group.y + headerHeight / 2 + 2.7)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.65" font-weight="700" fill="${headerTone.text}">(${xmlEscape(grade)})</text>`);
  }
  pieces.push(`<text x="${round(titleX)}" y="${round(group.y + headerHeight / 2 + 3.25)}" text-anchor="${titleAnchor}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(title, grade ? headerWidth - gradeWidth - 8 : headerWidth - 10, 8.65, 6.5)}" font-weight="700" fill="${headerTone.text}">${xmlEscape(title)}</text>`);

  const positions = layoutItems(group, column);
  positions.forEach((position) => {
    const itemTone = toneStyle(position.item.tone || "default");
    const itemOutline = outlineStyle(position.item.outlineTone);
    if (itemOutline) {
      pieces.push(`<rect x="${round(position.x - 2.2)}" y="${round(position.y - 2.2)}" width="${round(position.width + 4.4)}" height="${round(position.height + 4.4)}" fill="none" stroke="${itemOutline.stroke}" stroke-width="1.05" stroke-dasharray="2.2 2.4"/>`);
    }
    pieces.push(`<rect x="${position.x}" y="${round(position.y)}" width="${position.width}" height="${position.height}" fill="${itemTone.fill}" stroke="${itemTone.stroke}" stroke-width="0.82"/>`);
    pieces.push(`<text x="${round(position.x + position.width / 2)}" y="${round(position.y + position.height / 2 + 2.45)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(position.item.name, position.width - 8, 7, 5.15)}" font-weight="${position.item.tone ? 700 : 600}" fill="${itemTone.text}">${xmlEscape(position.item.name)}</text>`);
    if (position.item.notes?.length) {
      pieces.push(renderNotes(position.item.notes, position.noteX, position.noteY, position.noteWidth));
    }
  });
  if (group.notes?.length) {
    const noteX = Number(group.noteX ?? column.childX + 4);
    const noteY = Number(group.noteY ?? group.y + headerHeight + 7);
    pieces.push(renderNotes(group.notes, noteX, noteY, column.textRight - noteX));
  }
  pieces.push(`</g>`);
  return pieces.join("");
}

function layoutItems(group, column) {
  const items = Array.isArray(group.items) ? group.items : [];
  const headerHeight = mainBoxHeight(group);
  const defaultX = Number(group.childX ?? column.childX);
  const defaultWidth = Number(group.childWidth || 111);
  const defaultHeight = Number(group.childHeight || 17);
  const lineHeight = Number(group.noteLineHeight || 7.25);
  let y = Number(group.itemsY ?? group.y + headerHeight + 8);
  return items.map((item) => {
    const height = Number(item.height || defaultHeight);
    const x = Number(item.x ?? defaultX);
    const width = Number(item.width || defaultWidth);
    const noteX = Number(item.noteX ?? x + 3);
    const noteY = y + height + 5.2;
    const noteWidth = Number(item.noteWidth || column.textRight - noteX);
    const result = { item, x, y, width, height, noteX, noteY, noteWidth };
    const notesHeight = Array.isArray(item.notes) ? item.notes.length * lineHeight + 2 : 0;
    y += height + Number(item.gapAfter ?? 5) + notesHeight;
    return result;
  });
}

function renderNotes(lines, x, y, width) {
  const lineHeight = 7.25;
  const safeLines = lines.flatMap((line) => wrapLine(line, Math.max(12, Math.floor(width / 3.05))));
  return `<text x="${round(x)}" y="${round(y)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.55" font-weight="500" fill="${THEME.muted}">${safeLines.map((line, index) => `<tspan x="${round(x)}" dy="${index ? lineHeight : 0}">${xmlEscape(line)}</tspan>`).join("")}</text>`;
}

function wrapLine(value, maxChars) {
  const text = String(value || "").trim();
  if ([...text].length <= maxChars) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function mainBoxHeight(group) {
  return Number(group.headerHeight || (group.compact ? 21 : 20));
}

function toneStyle(tone, { header = false } = {}) {
  switch (tone) {
    case "green": return { fill: THEME.green, stroke: THEME.greenLine, text: THEME.ink };
    case "purple": return { fill: THEME.purple, stroke: THEME.purpleLine, text: THEME.ink };
    case "orange": return { fill: THEME.orange, stroke: THEME.redLine, text: "#FFFFFF" };
    case "yellow": return { fill: THEME.yellow, stroke: "#555555", text: THEME.ink };
    default: return { fill: header ? THEME.yellow : THEME.defaultFill, stroke: THEME.defaultLine, text: THEME.ink };
  }
}

function outlineStyle(tone) {
  switch (tone) {
    case "magenta": return { stroke: THEME.magentaLine };
    case "red": return { stroke: THEME.redLine };
    case "blue": return { stroke: THEME.blueLine };
    case "green": return { stroke: THEME.greenLine };
    default: return null;
  }
}

function fitFont(value, availableWidth, maximum, minimum) {
  const length = Math.max(1, [...String(value || "")].length);
  const estimated = availableWidth / (length * 0.91);
  return round(Math.max(minimum, Math.min(maximum, estimated)));
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}
