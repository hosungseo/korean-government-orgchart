import { MOIS_AI_PARTICIPATION_LEFT_SPEC } from "./mois-ai-participation-left-spec.mjs";
import {
  ORIGINAL_LEFT_STACK_LAYOUT,
  ORIGINAL_LEFT_STACK_SIZE,
} from "./render-original-left-stack.mjs";

export const HWP_NATIVE_MANIFEST_SCHEMA = "kr.go.mois.orgchart.hwp-native/v1";

const PT_TO_MM = 25.4 / 72;
const PAGE = Object.freeze({
  paper: "A4",
  orientation: "portrait",
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ left: 15, right: 15, top: 15, bottom: 15 }),
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
  white: "#FFFFFF",
});

export function buildMoisAiParticipationNativeManifest() {
  return buildOriginalLeftStackNativeManifest(MOIS_AI_PARTICIPATION_LEFT_SPEC, {
    title: "행정안전부 인공지능정부실·참여혁신조직실 편집형 조직도",
    fileName: "행정안전부-인공지능정부실-참여혁신조직실-편집형.hwpx",
    institution: "행정안전부",
    asOf: "2026-07-21",
    laws: ["행정안전부와 그 소속기관 직제", "행정안전부와 그 소속기관 직제 시행규칙"],
  });
}

export function buildOriginalLeftStackNativeManifest(spec = {}, options = {}) {
  const offices = Array.isArray(spec.offices) ? spec.offices : [];
  if (!offices.length) throw new Error("네이티브 왼쪽면 조직도에는 한 개 이상의 실이 필요합니다.");

  const layout = ORIGINAL_LEFT_STACK_LAYOUT;
  const lines = [];
  const frames = [];
  const boxes = [];
  const labels = [];
  const firstOfficeCenterY = Number(offices[0].y) + layout.officeHeight / 2;
  const lastOfficeCenterY = Number(offices.at(-1).y) + layout.officeHeight / 2;

  lines.push(lineObject("header-rule", 10, 17.5, ORIGINAL_LEFT_STACK_SIZE.width - 10, 17.5, {
    color: "#AAAAAA",
    widthPt: 0.75,
    role: "header-rule",
  }));
  lines.push(lineObject("page-divider", 255.12, 22, 255.12, 727, {
    color: "#E5E5E5",
    widthPt: 0.65,
    role: "page-divider",
  }));
  lines.push(lineObject("page-trunk", layout.pageTrunkX, firstOfficeCenterY, layout.pageTrunkX, lastOfficeCenterY, {
    color: COLORS.hierarchy,
    widthPt: 0.95,
    role: "page-trunk",
  }));

  labels.push(textObject("title", 10, 2.2, 260, 12.8, options.title || spec.title || "행정안전부 주요 실 조직도", {
    fontSizePt: 7.1,
    bold: true,
    align: "left",
    role: "title",
  }));
  labels.push(textObject(
    "as-of",
    ORIGINAL_LEFT_STACK_SIZE.width - 145,
    2.2,
    135,
    12.8,
    `직제 기준 ${spec.asOf || "2026. 7. 21."}`,
    { fontSizePt: 5.4, bold: true, align: "right", color: COLORS.muted, role: "as-of" },
  ));

  offices.forEach((office, officeIndex) => {
    const officeNo = officeIndex + 1;
    const officeY = Number(office.y);
    const officeCenterY = officeY + layout.officeHeight / 2;
    const bureaus = Array.isArray(office.bureaus) ? office.bureaus : [];
    if (!bureaus.length) throw new Error(`${office.name || "실"}에 한 개 이상의 국이 필요합니다.`);
    const lastBureauCenterY = Number(bureaus.at(-1).y) + layout.bureauHeight / 2;

    lines.push(lineObject(`office-${officeNo}-link`, layout.pageTrunkX, officeCenterY, layout.officeX + 0.7, officeCenterY, {
      role: "office-link",
      parentId: "page-trunk",
      childId: `office-${officeNo}`,
    }));
    lines.push(lineObject(`office-${officeNo}-trunk`, layout.officeTrunkX, officeY + layout.officeHeight - 0.7, layout.officeTrunkX, lastBureauCenterY, {
      widthPt: 0.88,
      role: "office-trunk",
      parentId: `office-${officeNo}`,
    }));

    if (office.evaluation) {
      frames.push(frameObject(`office-${officeNo}-evaluation`, layout.officeX - 3.2, officeY - 3.2, layout.officeWidth + 6.4, layout.officeHeight + 6.4, {
        color: COLORS.red,
        role: "evaluation-frame",
        targetId: `office-${officeNo}`,
      }));
    }
    boxes.push(orgBoxObject(`office-${officeNo}`, layout.officeX, officeY, layout.officeWidth, layout.officeHeight, office.name, {
      grade: office.grade || "고위 가",
      kind: "office",
      fontSizePt: 8.2,
      role: "office",
    }));

    const divisionCount = bureaus.reduce((sum, bureau) => sum + (bureau.divisions?.length || 0), 0);
    labels.push(textObject(`office-${officeNo}-count`, layout.officeX + layout.officeWidth - 56, officeY + layout.officeHeight + 1.6, 56, 8.4, `${bureaus.length}국 ${divisionCount}과`, {
      fontSizePt: 4.6,
      bold: true,
      align: "right",
      color: COLORS.muted,
      role: "count-label",
    }));

    bureaus.forEach((bureau, bureauIndex) => {
      const bureauNo = bureauIndex + 1;
      const bureauId = `office-${officeNo}-bureau-${bureauNo}`;
      const y = Number(bureau.y);
      const centerY = y + layout.bureauHeight / 2;
      const divisions = Array.isArray(bureau.divisions) ? bureau.divisions : [];
      const divisionsY = Number(bureau.divisionsY || y + layout.bureauHeight + 8);
      const lastDivisionCenterY = divisionsY
        + (divisions.length - 1) * (layout.divisionHeight + layout.divisionGap)
        + layout.divisionHeight / 2;

      lines.push(lineObject(`${bureauId}-link`, layout.officeTrunkX, centerY, layout.bureauX + 0.7, centerY, {
        widthPt: 0.84,
        role: "bureau-link",
        parentId: `office-${officeNo}`,
        childId: bureauId,
      }));
      if (divisions.length) {
        lines.push(lineObject(`${bureauId}-trunk`, layout.bureauTrunkX, y + layout.bureauHeight - 0.6, layout.bureauTrunkX, lastDivisionCenterY, {
          widthPt: 0.78,
          role: "division-trunk",
          parentId: bureauId,
        }));
      }

      boxes.push(orgBoxObject(bureauId, layout.bureauX, y, layout.bureauWidth, layout.bureauHeight, bureau.name, {
        grade: bureau.grade,
        kind: "bureau",
        fontSizePt: 6.75,
        role: "bureau",
        parentId: `office-${officeNo}`,
      }));
      labels.push(textObject(`${bureauId}-count`, layout.bureauX + layout.bureauWidth - 54, y + layout.bureauHeight + 1.2, 54, 8, `${divisions.length}개 과`, {
        fontSizePt: 4.35,
        bold: true,
        align: "right",
        color: COLORS.muted,
        role: "count-label",
      }));

      divisions.forEach((division, divisionIndex) => {
        const divisionNo = divisionIndex + 1;
        const divisionId = `${bureauId}-division-${divisionNo}`;
        const item = typeof division === "string" ? { name: division } : division;
        const divisionY = divisionsY + divisionIndex * (layout.divisionHeight + layout.divisionGap);
        const divisionCenterY = divisionY + layout.divisionHeight / 2;
        lines.push(lineObject(`${divisionId}-link`, layout.bureauTrunkX, divisionCenterY, layout.divisionX + 0.7, divisionCenterY, {
          widthPt: 0.78,
          role: "division-link",
          parentId: bureauId,
          childId: divisionId,
        }));
        if (item.evaluation) {
          frames.push(frameObject(`${divisionId}-evaluation`, layout.divisionX - 3.2, divisionY - 3.2, layout.divisionWidth + 6.4, layout.divisionHeight + 6.4, {
            color: COLORS.purpleLine,
            role: "evaluation-frame",
            targetId: divisionId,
          }));
        }
        boxes.push(orgBoxObject(divisionId, layout.divisionX, divisionY, layout.divisionWidth, layout.divisionHeight, item.name, {
          kind: item.evaluation ? "evaluation" : "division",
          fontSizePt: 5.45,
          role: "division",
          parentId: bureauId,
        }));
      });
    });
  });

  lines.push(lineObject("footer-rule", 10, 733.5, ORIGINAL_LEFT_STACK_SIZE.width - 10, 733.5, {
    color: "#D6D6D6",
    widthPt: 0.6,
    role: "footer-rule",
  }));
  labels.push(textObject("footer-source", 10, 735.8, 385, 10.2, spec.footer || "행정안전부 직제·시행규칙 · 실→국→과 법정 설치계선", {
    fontSizePt: 4.85,
    align: "left",
    color: COLORS.quiet,
    role: "footer",
  }));
  labels.push(textObject("footer-format", ORIGINAL_LEFT_STACK_SIZE.width - 96, 735.8, 86, 10.2, "A4 세로 · 왼쪽면", {
    fontSizePt: 4.85,
    bold: true,
    align: "right",
    color: COLORS.muted,
    role: "footer",
  }));
  labels.push(textObject("footer-legend", 10, 744, 300, 9.2, "점선: 평가대상 조직(2028. 12. 31.까지) · 오른쪽면 배치 여백", {
    fontSizePt: 4.55,
    align: "left",
    color: "#8A8A8A",
    role: "footer",
  }));

  const objects = [...lines, ...frames, ...boxes, ...labels];
  const manifest = {
    schema: HWP_NATIVE_MANIFEST_SCHEMA,
    version: 1,
    title: options.title || spec.title || "편집형 조직도",
    fileName: options.fileName || "편집형-조직도.hwpx",
    source: {
      institution: options.institution || "",
      asOf: options.asOf || "",
      laws: Array.isArray(options.laws) ? options.laws : [],
      note: "그림 삽입이 아닌 한글 네이티브 글상자·사각형·선 객체 생성용 명세",
    },
    page: PAGE,
    objects,
    verification: countExpectedObjects(objects),
  };
  validateNativeManifest(manifest);
  return manifest;
}

export function validateNativeManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("네이티브 작도 명세가 객체가 아닙니다.");
  if (manifest.schema !== HWP_NATIVE_MANIFEST_SCHEMA) throw new Error(`지원하지 않는 네이티브 작도 명세입니다: ${manifest.schema || "없음"}`);
  if (manifest.page?.paper !== "A4" || manifest.page?.orientation !== "portrait") {
    throw new Error("시제품은 A4 세로 명세만 지원합니다.");
  }
  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  if (!objects.length) throw new Error("네이티브 작도 객체가 없습니다.");
  const ids = new Set();
  for (const object of objects) {
    if (!object?.id || ids.has(object.id)) throw new Error(`네이티브 객체 ID가 없거나 중복됩니다: ${object?.id || "없음"}`);
    ids.add(object.id);
    if (!new Set(["line", "rectangle", "textbox"]).has(object.type)) {
      throw new Error(`지원하지 않는 네이티브 객체 유형입니다: ${object.type}`);
    }
    validateGeometry(object, manifest.page);
    if (object.type === "textbox" && typeof object.text !== "string") {
      throw new Error(`${object.id} 글상자의 text 값이 문자열이 아닙니다.`);
    }
  }
  const expected = countExpectedObjects(objects);
  for (const [key, value] of Object.entries(expected)) {
    if (manifest.verification?.[key] !== value) {
      throw new Error(`검증 예상값 ${key}가 실제 객체 수와 다릅니다.`);
    }
  }
  return manifest;
}

function lineObject(id, x1, y1, x2, y2, options = {}) {
  return {
    id,
    type: "line",
    geometry: { x1: paperX(x1), y1: paperY(y1), x2: paperX(x2), y2: paperY(y2) },
    style: {
      stroke: options.color || COLORS.hierarchy,
      strokeWidthMm: ptLength(options.widthPt || 0.82),
      dash: options.dash || "solid",
    },
    metadata: compactMetadata(options),
  };
}

function frameObject(id, x, y, width, height, options = {}) {
  return {
    id,
    type: "rectangle",
    geometry: rectGeometry(x, y, width, height),
    style: {
      fill: "none",
      stroke: options.color || COLORS.red,
      strokeWidthMm: ptLength(1.05),
      dash: "dash",
    },
    metadata: compactMetadata(options),
  };
}

function orgBoxObject(id, x, y, width, height, name, options = {}) {
  const box = boxStyle(options.kind);
  return {
    id,
    type: "textbox",
    text: options.grade ? `(${options.grade})  ${name}` : String(name || ""),
    geometry: rectGeometry(x, y, width, height),
    style: {
      fill: box.fill,
      stroke: box.stroke,
      strokeWidthMm: ptLength(0.82),
      dash: "solid",
      textColor: COLORS.ink,
      fontFamily: "맑은 고딕",
      fontSizePt: options.fontSizePt || 6,
      bold: true,
      align: "center",
      verticalAlign: "center",
      paddingMm: 0.8,
    },
    metadata: compactMetadata(options),
  };
}

function textObject(id, x, y, width, height, text, options = {}) {
  return {
    id,
    type: "textbox",
    text: String(text || ""),
    geometry: rectGeometry(x, y, width, height),
    style: {
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      dash: "solid",
      textColor: options.color || COLORS.ink,
      fontFamily: "맑은 고딕",
      fontSizePt: options.fontSizePt || 6,
      bold: Boolean(options.bold),
      align: options.align || "left",
      verticalAlign: "center",
      paddingMm: 0,
    },
    metadata: compactMetadata(options),
  };
}

function boxStyle(kind) {
  if (kind === "office") return { fill: COLORS.yellow, stroke: COLORS.yellowLine };
  if (kind === "bureau") return { fill: COLORS.green, stroke: COLORS.greenLine };
  if (kind === "evaluation") return { fill: COLORS.purple, stroke: COLORS.purpleLine };
  return { fill: COLORS.white, stroke: "#777777" };
}

function compactMetadata(options) {
  return Object.fromEntries(
    ["role", "parentId", "childId", "targetId"].map((key) => [key, options[key]]).filter(([, value]) => value),
  );
}

function rectGeometry(x, y, width, height) {
  return { x: paperX(x), y: paperY(y), width: ptLength(width), height: ptLength(height) };
}

function countExpectedObjects(objects) {
  const lineObjects = objects.filter((object) => object.type === "line").length;
  const rectangleObjects = objects.filter((object) => object.type === "rectangle").length;
  const textBoxObjects = objects.filter((object) => object.type === "textbox").length;
  return {
    expectedPageCount: 1,
    expectedNativeObjectCount: objects.length,
    expectedLineObjectCount: lineObjects,
    expectedRectangleObjectCount: rectangleObjects,
    expectedTextBoxObjectCount: textBoxObjects,
    expectedEditableTextObjectCount: textBoxObjects,
  };
}

function validateGeometry(object, page) {
  const values = Object.values(object.geometry || {});
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${object.id} 객체의 좌표가 유효하지 않습니다.`);
  }
  if (object.type === "line") {
    for (const point of [[object.geometry.x1, object.geometry.y1], [object.geometry.x2, object.geometry.y2]]) {
      if (point[0] < 0 || point[0] > page.widthMm || point[1] < 0 || point[1] > page.heightMm) {
        throw new Error(`${object.id} 선이 A4 용지 밖으로 나갑니다.`);
      }
    }
    return;
  }
  const { x, y, width, height } = object.geometry;
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > page.widthMm + 0.01 || y + height > page.heightMm + 0.01) {
    throw new Error(`${object.id} 객체가 A4 용지 밖으로 나갑니다.`);
  }
}

function paperX(valuePt) {
  return round(PAGE.marginMm.left + Number(valuePt) * PT_TO_MM);
}

function paperY(valuePt) {
  return round(PAGE.marginMm.top + Number(valuePt) * PT_TO_MM);
}

function ptLength(valuePt) {
  return round(Number(valuePt) * PT_TO_MM);
}

function round(value) {
  return Number(Number(value || 0).toFixed(3));
}
