export const NATIVE_MANIFEST_SCHEMA = "kr.go.mois.orgchart.hwp-native/v1";

const OBJECT_TYPES = new Set(["line", "rectangle", "textbox"]);
const ALIGNMENTS = new Set(["left", "center", "right"]);
const VERTICAL_ALIGNMENTS = new Set(["top", "center", "bottom"]);
const DASH_STYLES = new Set(["solid", "dash"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_OBJECTS = 5000;
const PAGE_TOLERANCE_MM = 0.02;
const CONNECTION_TOLERANCE_MM = 1.05;

function diagnostic(code, message, objectId = null) {
  return { code, message, ...(objectId ? { objectId } : {}) };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validColor(value, allowNone = true) {
  return (allowNone && value === "none") || (typeof value === "string" && HEX_COLOR.test(value));
}

function pointNearRectangle(point, geometry, tolerance = CONNECTION_TOLERANCE_MM) {
  if (!geometry || !finite(point?.x) || !finite(point?.y)) return false;
  const left = geometry.x;
  const right = geometry.x + geometry.width;
  const top = geometry.y;
  const bottom = geometry.y + geometry.height;
  const withinX = point.x >= left - tolerance && point.x <= right + tolerance;
  const withinY = point.y >= top - tolerance && point.y <= bottom + tolerance;
  return (withinY && Math.min(Math.abs(point.x - left), Math.abs(point.x - right)) <= tolerance)
    || (withinX && Math.min(Math.abs(point.y - top), Math.abs(point.y - bottom)) <= tolerance);
}

function analyzeStyle(object, errors, warnings) {
  const style = object.style;
  if (!isRecord(style)) {
    errors.push(diagnostic("missing-style", "서식(style) 정보가 없습니다.", object.id));
    return;
  }
  if (!validColor(style.stroke)) {
    errors.push(diagnostic("invalid-stroke", "선 색상은 #RRGGBB 또는 none이어야 합니다.", object.id));
  }
  if (!finite(style.strokeWidthMm) || style.strokeWidthMm < 0 || style.strokeWidthMm > 10) {
    errors.push(diagnostic("invalid-stroke-width", "선 굵기는 0~10mm의 숫자여야 합니다.", object.id));
  }
  if (!DASH_STYLES.has(style.dash)) {
    errors.push(diagnostic("invalid-dash", "선 종류는 solid 또는 dash여야 합니다.", object.id));
  }

  if (object.type === "line") {
    if (style.stroke === "none" || style.strokeWidthMm === 0) {
      errors.push(diagnostic("invisible-line", "선 객체가 보이지 않는 서식입니다.", object.id));
    }
    return;
  }

  if (!validColor(style.fill)) {
    errors.push(diagnostic("invalid-fill", "채우기 색상은 #RRGGBB 또는 none이어야 합니다.", object.id));
  }
  if (object.type === "rectangle" && style.fill === "none" && style.stroke === "none") {
    warnings.push(diagnostic("invisible-rectangle", "채우기와 테두리가 모두 없어 보이지 않는 사각형입니다.", object.id));
  }
  if (object.type !== "textbox") return;

  if (!validColor(style.textColor, false)) {
    errors.push(diagnostic("invalid-text-color", "문자 색상은 #RRGGBB 형식이어야 합니다.", object.id));
  }
  if (!finite(style.fontSizePt) || style.fontSizePt < 2 || style.fontSizePt > 72) {
    errors.push(diagnostic("invalid-font-size", "글자 크기는 2~72pt의 숫자여야 합니다.", object.id));
  }
  if (!ALIGNMENTS.has(style.align)) {
    errors.push(diagnostic("invalid-align", "문단 정렬은 left, center, right 중 하나여야 합니다.", object.id));
  }
  if (!VERTICAL_ALIGNMENTS.has(style.verticalAlign)) {
    errors.push(diagnostic("invalid-vertical-align", "세로 정렬은 top, center, bottom 중 하나여야 합니다.", object.id));
  }
  if (!finite(style.paddingMm) || style.paddingMm < 0) {
    errors.push(diagnostic("invalid-padding", "글상자 안쪽 여백은 0 이상의 숫자여야 합니다.", object.id));
  }
}

function analyzeGeometry(object, page, errors, warnings) {
  const geometry = object.geometry;
  if (!isRecord(geometry)) {
    errors.push(diagnostic("missing-geometry", "좌표(geometry) 정보가 없습니다.", object.id));
    return;
  }
  const widthMm = finite(page?.widthMm) ? page.widthMm : 210;
  const heightMm = finite(page?.heightMm) ? page.heightMm : 297;

  if (object.type === "line") {
    const keys = ["x1", "y1", "x2", "y2"];
    if (keys.some((key) => !finite(geometry[key]))) {
      errors.push(diagnostic("invalid-line-geometry", "선 좌표는 모두 유한한 숫자여야 합니다.", object.id));
      return;
    }
    const points = [[geometry.x1, geometry.y1], [geometry.x2, geometry.y2]];
    if (points.some(([x, y]) => x < 0 || y < 0 || x > widthMm + PAGE_TOLERANCE_MM || y > heightMm + PAGE_TOLERANCE_MM)) {
      errors.push(diagnostic("line-out-of-page", "선이 용지 경계를 벗어납니다.", object.id));
    }
    const dx = Math.abs(geometry.x2 - geometry.x1);
    const dy = Math.abs(geometry.y2 - geometry.y1);
    if (Math.hypot(dx, dy) < 0.01) {
      errors.push(diagnostic("zero-length-line", "길이가 0인 선입니다.", object.id));
    } else if (dx > 0.01 && dy > 0.01) {
      warnings.push(diagnostic("diagonal-line", "직각 계선이 아닌 대각선입니다.", object.id));
    }
    return;
  }

  const keys = ["x", "y", "width", "height"];
  if (keys.some((key) => !finite(geometry[key]))) {
    errors.push(diagnostic("invalid-box-geometry", "상자 좌표와 크기는 모두 유한한 숫자여야 합니다.", object.id));
    return;
  }
  if (geometry.width <= 0 || geometry.height <= 0) {
    errors.push(diagnostic("non-positive-box", "상자 너비와 높이는 0보다 커야 합니다.", object.id));
  }
  if (geometry.x < 0 || geometry.y < 0
      || geometry.x + geometry.width > widthMm + PAGE_TOLERANCE_MM
      || geometry.y + geometry.height > heightMm + PAGE_TOLERANCE_MM) {
    errors.push(diagnostic("box-out-of-page", "상자가 용지 경계를 벗어납니다.", object.id));
  }
}

export function analyzeNativeManifest(manifest) {
  const errors = [];
  const warnings = [];
  const emptySummary = {
    title: "명세 없음",
    objectCount: 0,
    lineCount: 0,
    rectangleCount: 0,
    textBoxCount: 0,
    connectionChecks: 0,
    connectionWarnings: 0,
  };

  if (!isRecord(manifest)) {
    errors.push(diagnostic("invalid-document", "네이티브 작도 명세가 JSON 객체가 아닙니다."));
    return { valid: false, errors, warnings, summary: emptySummary };
  }
  if (manifest.schema !== NATIVE_MANIFEST_SCHEMA) {
    errors.push(diagnostic("unsupported-schema", `지원하지 않는 명세입니다: ${manifest.schema || "없음"}`));
  }

  const page = manifest.page;
  if (!isRecord(page)) {
    errors.push(diagnostic("missing-page", "용지(page) 정보가 없습니다."));
  } else {
    const a4Portrait = page.paper === "A4" && page.orientation === "portrait"
      && Math.abs(page.widthMm - 210) <= PAGE_TOLERANCE_MM
      && Math.abs(page.heightMm - 297) <= PAGE_TOLERANCE_MM;
    const a3Landscape = page.paper === "A3" && page.orientation === "landscape"
      && Math.abs(page.widthMm - 420) <= PAGE_TOLERANCE_MM
      && Math.abs(page.heightMm - 297) <= PAGE_TOLERANCE_MM;
    if (!a4Portrait && !a3Landscape) {
      errors.push(diagnostic("unsupported-page", "현재 앱은 A4 세로 또는 A3 가로 명세를 지원합니다."));
    }
    const margin = page.marginMm;
    if (!isRecord(margin) || ["left", "right", "top", "bottom"].some((key) => !finite(margin[key]) || margin[key] < 0)) {
      errors.push(diagnostic("invalid-margin", "용지 여백은 0 이상의 숫자로 지정해야 합니다."));
    } else if (margin.left + margin.right >= page.widthMm || margin.top + margin.bottom >= page.heightMm) {
      errors.push(diagnostic("margin-overflow", "용지 여백이 본문 영역을 모두 차지합니다."));
    }
  }

  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  if (!objects.length) errors.push(diagnostic("empty-objects", "네이티브 작도 객체가 없습니다."));
  if (objects.length > MAX_OBJECTS) errors.push(diagnostic("too-many-objects", `객체는 최대 ${MAX_OBJECTS}개까지 지원합니다.`));

  const ids = new Set();
  const byId = new Map();
  for (const [index, object] of objects.entries()) {
    if (!isRecord(object)) {
      errors.push(diagnostic("invalid-object", `${index + 1}번째 객체가 JSON 객체가 아닙니다.`));
      continue;
    }
    if (typeof object.id !== "string" || !object.id.trim()) {
      errors.push(diagnostic("missing-id", `${index + 1}번째 객체에 ID가 없습니다.`));
    } else if (ids.has(object.id)) {
      errors.push(diagnostic("duplicate-id", `중복 객체 ID입니다: ${object.id}`, object.id));
    } else {
      ids.add(object.id);
      byId.set(object.id, object);
    }
    if (!OBJECT_TYPES.has(object.type)) {
      errors.push(diagnostic("unsupported-type", `지원하지 않는 객체 유형입니다: ${object.type || "없음"}`, object.id));
      continue;
    }
    analyzeGeometry(object, page, errors, warnings);
    analyzeStyle(object, errors, warnings);
    if (object.type === "textbox" && typeof object.text !== "string") {
      errors.push(diagnostic("invalid-text", "글상자의 text 값이 문자열이 아닙니다.", object.id));
    }
  }

  let connectionChecks = 0;
  let connectionWarnings = 0;
  for (const object of objects) {
    if (!isRecord(object?.metadata)) continue;
    for (const key of ["parentId", "childId", "targetId"]) {
      const reference = object.metadata[key];
      if (reference && !byId.has(reference)) {
        warnings.push(diagnostic("missing-reference", `${key}가 존재하지 않는 객체를 가리킵니다: ${reference}`, object.id));
      }
    }
    if (object.type !== "line" || !object.metadata.childId) continue;
    const child = byId.get(object.metadata.childId);
    if (!child || child.type === "line" || !isRecord(child.geometry) || !isRecord(object.geometry)) continue;
    connectionChecks += 1;
    const first = { x: object.geometry.x1, y: object.geometry.y1 };
    const second = { x: object.geometry.x2, y: object.geometry.y2 };
    if (!pointNearRectangle(first, child.geometry) && !pointNearRectangle(second, child.geometry)) {
      connectionWarnings += 1;
      warnings.push(diagnostic("unsnapped-child", `계선이 자식 상자(${child.id}) 경계에 맞물리지 않습니다.`, object.id));
    }
  }

  const lineCount = objects.filter((object) => object?.type === "line").length;
  const rectangleCount = objects.filter((object) => object?.type === "rectangle").length;
  const textBoxCount = objects.filter((object) => object?.type === "textbox").length;
  const expected = {
    expectedPageCount: 1,
    expectedNativeObjectCount: objects.length,
    expectedLineObjectCount: lineCount,
    expectedRectangleObjectCount: rectangleCount,
    expectedTextBoxObjectCount: textBoxCount,
    expectedEditableTextObjectCount: textBoxCount,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest.verification?.[key] !== value) {
      errors.push(diagnostic("verification-mismatch", `검증 예상값 ${key}가 실제값 ${value}와 다릅니다.`));
    }
  }

  const summary = {
    title: typeof manifest.title === "string" && manifest.title.trim() ? manifest.title.trim() : "제목 없는 조직도",
    fileName: typeof manifest.fileName === "string" ? manifest.fileName : "",
    paper: page?.paper || "—",
    orientation: page?.orientation || "—",
    widthMm: page?.widthMm,
    heightMm: page?.heightMm,
    objectCount: objects.length,
    lineCount,
    rectangleCount,
    textBoxCount,
    connectionChecks,
    connectionWarnings,
  };
  return { valid: errors.length === 0, errors, warnings, summary };
}

export function assertNativeManifest(manifest) {
  const report = analyzeNativeManifest(manifest);
  if (!report.valid) throw new Error(report.errors[0]?.message || "작도 명세 검증에 실패했습니다.");
  return report;
}
