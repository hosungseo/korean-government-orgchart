import { xmlEscape } from "./utils.mjs";

export const ORIGINAL_TWO_BRANCHES_SIZE = Object.freeze({ width: 510.24, height: 756.84 });

const COLORS = Object.freeze({
  ink: "#202020",
  muted: "#555F68",
  quiet: "#777777",
  hierarchy: "#666666",
  yellow: "#FFF20A",
  yellowLine: "#555555",
  green: "#BDF4C7",
  greenLine: "#30934B",
  purple: "#DED8F2",
  purpleLine: "#4D61C7",
  red: "#D8423A",
  rule: "#AAAAAA",
});

/**
 * Render two independent three-level ministry branches using the supplied
 * original chart's grammar: yellow office, green bureau, white division,
 * square grey hierarchy lines and restrained evaluation outlines.
 */
export function renderOriginalTwoBranchesSvg(spec = {}) {
  const { width, height } = ORIGINAL_TWO_BRANCHES_SIZE;
  const branches = Array.isArray(spec.branches) ? spec.branches.slice(0, 2) : [];
  if (branches.length !== 2) throw new Error("원형복원 2계선 조직도에는 정확히 두 개의 실이 필요합니다.");

  const columns = [
    { x: 0, width: 247, trunkX: 18, rootX: 37, bureauX: 48, itemX: 72, contentRight: 242 },
    { x: 263.24, width: 247, trunkX: 281.24, rootX: 300.24, bureauX: 311.24, itemX: 335.24, contentRight: 505.24 },
  ];

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">`,
    `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    renderPageHeader(spec, width),
    `<line x1="255.12" y1="22" x2="255.12" y2="727" stroke="#E1E1E1" stroke-width="0.65"/>`,
  ];

  branches.forEach((branch, index) => parts.push(renderBranch(branch, columns[index], index)));
  parts.push(`<line x1="10" y1="733.5" x2="500.24" y2="733.5" stroke="#D6D6D6" stroke-width="0.6"/>`);
  parts.push(`<text x="10" y="743" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.85" fill="${COLORS.quiet}">${xmlEscape(spec.footer || "행정안전부 직제·시행규칙 [시행 2026. 7. 21.] · 법정 설치계선 기준")}</text>`);
  parts.push(`<text x="500.24" y="743" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.85" font-weight="700" fill="#555555">A4 세로 · 1쪽</text>`);
  parts.push(`<text x="10" y="751.1" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.55" fill="#8A8A8A">점선: 평가대상 조직(2028. 12. 31.까지) · 운영상 소관선 제외</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

function renderPageHeader(spec, width) {
  const title = spec.title || "행정안전부 주요 실 조직도";
  const asOf = spec.asOf || "2026. 7. 21.";
  return [
    `<text x="10" y="11.5" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.1" font-weight="700" fill="#333333">${xmlEscape(title)}</text>`,
    `<text x="${round(width - 10)}" y="11.5" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.4" font-weight="600" fill="${COLORS.muted}">직제 기준 ${xmlEscape(asOf)}</text>`,
    `<line x1="10" y1="17.5" x2="${round(width - 10)}" y2="17.5" stroke="${COLORS.rule}" stroke-width="0.75"/>`,
  ].join("");
}

function renderBranch(branch, column, branchIndex) {
  const rootY = Number(branch.rootY || 31);
  const rootHeight = 25;
  const rootWidth = 190;
  const rootCenterY = rootY + rootHeight / 2;
  const bureaus = Array.isArray(branch.bureaus) ? branch.bureaus : [];
  if (!bureaus.length) throw new Error(`${branch.name || "실"}에 한 개 이상의 국이 필요합니다.`);
  const lastBureau = bureaus.at(-1);
  const lastBureauCenterY = Number(lastBureau.y) + 10;
  const pieces = [`<g data-original-branch="${branchIndex + 1}">`];

  pieces.push(`<path data-branch-trunk="${branchIndex + 1}" d="M ${round(column.trunkX)} ${round(rootCenterY)} V ${round(lastBureauCenterY)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.95" stroke-linecap="square"/>`);
  pieces.push(`<path d="M ${round(column.trunkX)} ${round(rootCenterY)} H ${round(column.rootX + 0.7)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.95" stroke-linecap="square"/>`);
  pieces.push(`<circle cx="${round(column.trunkX)}" cy="${round(rootCenterY)}" r="1.2" fill="#FFFFFF" stroke="${COLORS.hierarchy}" stroke-width="0.75"/>`);
  pieces.push(renderBox({
    x: column.rootX,
    y: rootY,
    width: rootWidth,
    height: rootHeight,
    name: branch.name,
    grade: branch.grade || "고위 가",
    tone: "root",
    evaluation: Boolean(branch.evaluation),
    evaluationColor: COLORS.red,
    fontSize: 8.65,
  }));

  const count = bureaus.reduce((sum, bureau) => sum + (bureau.items?.length || 0), 0);
  pieces.push(`<text x="${round(column.rootX + rootWidth)}" y="${round(rootY + rootHeight + 8.4)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.9" font-weight="600" fill="${COLORS.muted}">${bureaus.length}국 ${count}과</text>`);

  bureaus.forEach((bureau, bureauIndex) => {
    pieces.push(renderBureau(bureau, column, branchIndex, bureauIndex));
  });
  pieces.push(`</g>`);
  return pieces.join("");
}

function renderBureau(bureau, column, branchIndex, bureauIndex) {
  const y = Number(bureau.y);
  const headerHeight = 20;
  const headerWidth = 174;
  const headerCenterY = y + headerHeight / 2;
  const items = Array.isArray(bureau.items) ? bureau.items : [];
  const itemHeight = 17;
  const itemGap = 5.6;
  const itemsY = Number(bureau.itemsY || y + 31);
  const itemWidth = 145;
  const spineX = column.bureauX + 11;
  const pieces = [`<g data-bureau="${branchIndex + 1}-${bureauIndex + 1}">`];

  pieces.push(`<path data-bureau-link="${branchIndex + 1}-${bureauIndex + 1}" d="M ${round(column.trunkX)} ${round(headerCenterY)} H ${round(column.bureauX + 0.7)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.9" stroke-linecap="square"/>`);
  pieces.push(`<circle cx="${round(column.trunkX)}" cy="${round(headerCenterY)}" r="1.12" fill="#FFFFFF" stroke="${COLORS.hierarchy}" stroke-width="0.72"/>`);

  if (items.length) {
    const lastItemCenterY = itemsY + (items.length - 1) * (itemHeight + itemGap) + itemHeight / 2;
    pieces.push(`<path data-division-spine="${branchIndex + 1}-${bureauIndex + 1}" d="M ${round(spineX)} ${round(y + headerHeight - 0.6)} V ${round(lastItemCenterY)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.82" stroke-linecap="square"/>`);
    items.forEach((_item, itemIndex) => {
      const itemY = itemsY + itemIndex * (itemHeight + itemGap);
      const itemCenterY = itemY + itemHeight / 2;
      pieces.push(`<path d="M ${round(spineX)} ${round(itemCenterY)} H ${round(column.itemX + 0.7)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.82" stroke-linecap="square"/>`);
    });
  }

  pieces.push(renderBox({
    x: column.bureauX,
    y,
    width: headerWidth,
    height: headerHeight,
    name: bureau.name,
    grade: bureau.grade,
    tone: "bureau",
    evaluation: Boolean(bureau.evaluation),
    evaluationColor: COLORS.red,
    fontSize: 7.15,
  }));
  pieces.push(`<text x="${round(column.bureauX + headerWidth)}" y="${round(y + headerHeight + 7.2)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.7" font-weight="600" fill="${COLORS.muted}">${items.length}개 과</text>`);

  items.forEach((item, itemIndex) => {
    const normalized = typeof item === "string" ? { name: item } : item;
    const itemY = itemsY + itemIndex * (itemHeight + itemGap);
    pieces.push(renderBox({
      x: column.itemX,
      y: itemY,
      width: itemWidth,
      height: itemHeight,
      name: normalized.name,
      tone: normalized.evaluation ? "evaluation" : "division",
      evaluation: Boolean(normalized.evaluation),
      evaluationColor: COLORS.purpleLine,
      fontSize: 6.25,
    }));
  });
  pieces.push(`</g>`);
  return pieces.join("");
}

function renderBox({ x, y, width, height, name, grade, tone, evaluation, evaluationColor, fontSize }) {
  const style = boxStyle(tone);
  const gradeWidth = grade ? Math.min(46, Math.max(35, 21 + [...String(grade)].length * 3.1)) : 0;
  const nameX = x + (grade ? gradeWidth + 4 : width / 2);
  const nameAnchor = grade ? "start" : "middle";
  const nameWidth = grade ? width - gradeWidth - 10 : width - 9;
  const pieces = [];
  if (evaluation) {
    pieces.push(`<rect data-evaluation="true" x="${round(x - 4)}" y="${round(y - 4)}" width="${round(width + 8)}" height="${round(height + 8)}" fill="none" stroke="${evaluationColor}" stroke-width="1.15" stroke-dasharray="2.5 3"/>`);
  }
  pieces.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.88"/>`);
  if (grade) {
    pieces.push(`<text x="${round(x + gradeWidth / 2)}" y="${round(y + height / 2 + 2.55)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.2" font-weight="700" fill="${style.text}">(${xmlEscape(grade)})</text>`);
  }
  pieces.push(`<text x="${round(nameX)}" y="${round(y + height / 2 + 2.85)}" text-anchor="${nameAnchor}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(name, nameWidth, fontSize, Math.max(4.9, fontSize - 1.35))}" font-weight="700" fill="${style.text}">${xmlEscape(name)}</text>`);
  return pieces.join("");
}

function boxStyle(tone) {
  if (tone === "root") return { fill: COLORS.yellow, stroke: COLORS.yellowLine, text: COLORS.ink };
  if (tone === "bureau") return { fill: COLORS.green, stroke: COLORS.greenLine, text: COLORS.ink };
  if (tone === "evaluation") return { fill: COLORS.purple, stroke: COLORS.purpleLine, text: COLORS.ink };
  return { fill: "#FFFFFF", stroke: "#777777", text: COLORS.ink };
}

function fitFont(value, availableWidth, maximum, minimum) {
  const length = Math.max(1, [...String(value || "")].length);
  const estimated = availableWidth / (length * 0.91);
  return round(Math.max(minimum, Math.min(maximum, estimated)));
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}
