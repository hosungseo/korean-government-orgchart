import { xmlEscape } from "./utils.mjs";

export const ORIGINAL_LEFT_STACK_SIZE = Object.freeze({ width: 510.24, height: 756.84 });

export const ORIGINAL_LEFT_STACK_LAYOUT = Object.freeze({
  pageTrunkX: 18,
  officeX: 37,
  officeWidth: 190,
  officeHeight: 24,
  officeTrunkX: 48,
  bureauX: 61,
  bureauWidth: 165,
  bureauHeight: 18,
  bureauTrunkX: 72,
  divisionX: 84,
  divisionWidth: 140,
  divisionHeight: 13.5,
  divisionGap: 3.3,
});

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
});

/**
 * Render multiple offices on the left half of an A4 portrait page.
 *
 * The page-level trunk links sibling offices. Each office owns a second-level
 * trunk for bureaus, and each bureau owns a third-level trunk for divisions.
 * The right half deliberately remains blank for later composition.
 */
export function renderOriginalLeftStackSvg(spec = {}) {
  const { width, height } = ORIGINAL_LEFT_STACK_SIZE;
  const offices = Array.isArray(spec.offices) ? spec.offices : [];
  if (!offices.length) throw new Error("왼쪽면 조직도에는 한 개 이상의 실이 필요합니다.");

  const layout = ORIGINAL_LEFT_STACK_LAYOUT;

  const firstOfficeCenterY = Number(offices[0].y) + layout.officeHeight / 2;
  const lastOfficeCenterY = Number(offices.at(-1).y) + layout.officeHeight / 2;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">`,
    `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    renderHeader(spec, width),
    `<line x1="255.12" y1="22" x2="255.12" y2="727" stroke="#E5E5E5" stroke-width="0.65"/>`,
    `<path data-page-trunk="left" d="M ${layout.pageTrunkX} ${round(firstOfficeCenterY)} V ${round(lastOfficeCenterY)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.95" stroke-linecap="square"/>`,
  ];

  offices.forEach((office, index) => parts.push(renderOffice(office, layout, index)));
  parts.push(`<line x1="10" y1="733.5" x2="500.24" y2="733.5" stroke="#D6D6D6" stroke-width="0.6"/>`);
  parts.push(`<text x="10" y="743" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.85" fill="${COLORS.quiet}">${xmlEscape(spec.footer || "행정안전부 직제·시행규칙 [시행 2026. 7. 21.] · 실→국→과 법정 설치계선")}</text>`);
  parts.push(`<text x="500.24" y="743" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.85" font-weight="700" fill="#555555">A4 세로 · 왼쪽면</text>`);
  parts.push(`<text x="10" y="751.1" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.55" fill="#8A8A8A">점선: 평가대상 조직(2028. 12. 31.까지) · 오른쪽면 배치 여백</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

function renderHeader(spec, width) {
  return [
    `<text x="10" y="11.5" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.1" font-weight="700" fill="#333333">${xmlEscape(spec.title || "행정안전부 주요 실 조직도")}</text>`,
    `<text x="${round(width - 10)}" y="11.5" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.4" font-weight="600" fill="${COLORS.muted}">직제 기준 ${xmlEscape(spec.asOf || "2026. 7. 21.")}</text>`,
    `<line x1="10" y1="17.5" x2="${round(width - 10)}" y2="17.5" stroke="#AAAAAA" stroke-width="0.75"/>`,
  ].join("");
}

function renderOffice(office, layout, officeIndex) {
  const officeY = Number(office.y);
  const officeCenterY = officeY + layout.officeHeight / 2;
  const bureaus = Array.isArray(office.bureaus) ? office.bureaus : [];
  if (!bureaus.length) throw new Error(`${office.name || "실"}에 한 개 이상의 국이 필요합니다.`);
  const lastBureauCenterY = Number(bureaus.at(-1).y) + layout.bureauHeight / 2;
  const pieces = [`<g data-left-office="${officeIndex + 1}">`];

  pieces.push(`<path data-office-link="${officeIndex + 1}" d="M ${layout.pageTrunkX} ${round(officeCenterY)} H ${round(layout.officeX + 0.7)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.95" stroke-linecap="square"/>`);
  pieces.push(`<circle cx="${layout.pageTrunkX}" cy="${round(officeCenterY)}" r="1.2" fill="#FFFFFF" stroke="${COLORS.hierarchy}" stroke-width="0.75"/>`);
  pieces.push(`<path data-office-trunk="${officeIndex + 1}" d="M ${layout.officeTrunkX} ${round(officeY + layout.officeHeight - 0.7)} V ${round(lastBureauCenterY)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.88" stroke-linecap="square"/>`);
  pieces.push(renderBox({
    x: layout.officeX,
    y: officeY,
    width: layout.officeWidth,
    height: layout.officeHeight,
    name: office.name,
    grade: office.grade || "고위 가",
    kind: "office",
    evaluation: Boolean(office.evaluation),
    evaluationColor: COLORS.red,
    fontSize: 8.2,
  }));

  const divisionCount = bureaus.reduce((sum, bureau) => sum + (bureau.divisions?.length || 0), 0);
  pieces.push(`<text x="${round(layout.officeX + layout.officeWidth)}" y="${round(officeY + layout.officeHeight + 7.5)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.6" font-weight="600" fill="${COLORS.muted}">${bureaus.length}국 ${divisionCount}과</text>`);
  bureaus.forEach((bureau, bureauIndex) => pieces.push(renderBureau(bureau, layout, officeIndex, bureauIndex)));
  pieces.push(`</g>`);
  return pieces.join("");
}

function renderBureau(bureau, layout, officeIndex, bureauIndex) {
  const y = Number(bureau.y);
  const centerY = y + layout.bureauHeight / 2;
  const divisions = Array.isArray(bureau.divisions) ? bureau.divisions : [];
  const divisionsY = Number(bureau.divisionsY || y + layout.bureauHeight + 8);
  const lastDivisionCenterY = divisionsY
    + (divisions.length - 1) * (layout.divisionHeight + layout.divisionGap)
    + layout.divisionHeight / 2;
  const pieces = [`<g data-left-bureau="${officeIndex + 1}-${bureauIndex + 1}">`];

  pieces.push(`<path data-bureau-link="${officeIndex + 1}-${bureauIndex + 1}" d="M ${layout.officeTrunkX} ${round(centerY)} H ${round(layout.bureauX + 0.7)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.84" stroke-linecap="square"/>`);
  if (divisions.length) {
    pieces.push(`<path data-division-trunk="${officeIndex + 1}-${bureauIndex + 1}" d="M ${layout.bureauTrunkX} ${round(y + layout.bureauHeight - 0.6)} V ${round(lastDivisionCenterY)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.78" stroke-linecap="square"/>`);
    divisions.forEach((_division, divisionIndex) => {
      const divisionY = divisionsY + divisionIndex * (layout.divisionHeight + layout.divisionGap);
      const divisionCenterY = divisionY + layout.divisionHeight / 2;
      pieces.push(`<path d="M ${layout.bureauTrunkX} ${round(divisionCenterY)} H ${round(layout.divisionX + 0.7)}" fill="none" stroke="${COLORS.hierarchy}" stroke-width="0.78" stroke-linecap="square"/>`);
    });
  }
  pieces.push(renderBox({
    x: layout.bureauX,
    y,
    width: layout.bureauWidth,
    height: layout.bureauHeight,
    name: bureau.name,
    grade: bureau.grade,
    kind: "bureau",
    fontSize: 6.75,
  }));
  pieces.push(`<text x="${round(layout.bureauX + layout.bureauWidth)}" y="${round(y + layout.bureauHeight + 6)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.35" font-weight="600" fill="${COLORS.muted}">${divisions.length}개 과</text>`);

  divisions.forEach((division, divisionIndex) => {
    const item = typeof division === "string" ? { name: division } : division;
    const divisionY = divisionsY + divisionIndex * (layout.divisionHeight + layout.divisionGap);
    pieces.push(renderBox({
      x: layout.divisionX,
      y: divisionY,
      width: layout.divisionWidth,
      height: layout.divisionHeight,
      name: item.name,
      kind: item.evaluation ? "evaluation" : "division",
      evaluation: Boolean(item.evaluation),
      evaluationColor: COLORS.purpleLine,
      fontSize: 5.45,
    }));
  });
  pieces.push(`</g>`);
  return pieces.join("");
}

function renderBox({ x, y, width, height, name, grade, kind, evaluation, evaluationColor, fontSize }) {
  const style = boxStyle(kind);
  const gradeWidth = grade ? Math.min(43, Math.max(34, 21 + [...String(grade)].length * 3)) : 0;
  const nameX = x + (grade ? gradeWidth + 4 : width / 2);
  const nameWidth = grade ? width - gradeWidth - 9 : width - 8;
  const pieces = [];
  if (evaluation) {
    pieces.push(`<rect data-evaluation="true" x="${round(x - 3.2)}" y="${round(y - 3.2)}" width="${round(width + 6.4)}" height="${round(height + 6.4)}" fill="none" stroke="${evaluationColor}" stroke-width="1.05" stroke-dasharray="2.4 2.8"/>`);
  }
  pieces.push(`<rect x="${x}" y="${round(y)}" width="${width}" height="${height}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.82"/>`);
  if (grade) {
    pieces.push(`<text x="${round(x + gradeWidth / 2)}" y="${round(y + height / 2 + 2.25)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="4.75" font-weight="700" fill="${style.text}">(${xmlEscape(grade)})</text>`);
  }
  pieces.push(`<text x="${round(nameX)}" y="${round(y + height / 2 + 2.45)}" text-anchor="${grade ? "start" : "middle"}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fitFont(name, nameWidth, fontSize, Math.max(4.25, fontSize - 1.1))}" font-weight="700" fill="${style.text}">${xmlEscape(name)}</text>`);
  return pieces.join("");
}

function boxStyle(kind) {
  if (kind === "office") return { fill: COLORS.yellow, stroke: COLORS.yellowLine, text: COLORS.ink };
  if (kind === "bureau") return { fill: COLORS.green, stroke: COLORS.greenLine, text: COLORS.ink };
  if (kind === "evaluation") return { fill: COLORS.purple, stroke: COLORS.purpleLine, text: COLORS.ink };
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
