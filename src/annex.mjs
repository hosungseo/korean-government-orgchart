import { normalizeWhitespace } from "./utils.mjs";

export function extractAnnexesFromLawJson(json, { source } = {}) {
  const law = json?.["법령"];
  if (!law) return [];
  const units = flattenAnnexUnits(law["별표"]);
  return units.map((unit, index) => {
    const text = annexText(unit);
    const rows = parseBoxTable(text);
    const title = normalizeWhitespace(
      unit["별표제목"] ||
        unit["별표제목문자열"] ||
        unit["별표명"] ||
        `별표 ${index + 1}`,
    );
    const annexNumber = normalizeAnnexNumber(unit["별표번호"] || title.match(/\[별표\s*([^\]]+)\]/)?.[1] || index + 1);
    return {
      annex: `별표 ${annexNumber}`,
      number: annexNumber,
      title,
      key: unit["별표키"] || null,
      effectiveDate: unit["별표시행일자"] || null,
      type: classifyAnnex(title, text),
      source: source || null,
      links: {
        hwp: unit["별표서식파일링크"] || null,
        pdf: unit["별표서식PDF파일링크"] || null,
        image: unit["별표서식이미지파일링크"] || null,
      },
      files: {
        hwp: unit["별표HWP파일명"] || null,
        pdf: unit["별표PDF파일명"] || null,
      },
      rowCount: rows.length,
      rows,
      textPreview: text.slice(0, 1200),
    };
  });
}

export function attachAnnexes(graph, annexes) {
  if (!annexes?.length) return graph;
  const existing = graph.meta.annexes || [];
  const byKey = new Map(existing.map((annex) => [`${annex.source || ""}|${annex.annex}|${annex.title}`, annex]));
  for (const annex of annexes) {
    const key = `${annex.source || ""}|${annex.annex}|${annex.title}`;
    byKey.set(key, annex);
  }
  graph.meta.annexes = [...byKey.values()];
  return graph;
}

export function findAnnex(graph, annexLabel) {
  const target = normalizeAnnexLabel(annexLabel);
  return (graph.meta.annexes || []).find((annex) => normalizeAnnexLabel(annex.annex) === target) || null;
}

export function parseBoxTable(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!/[┃│]/.test(line)) continue;
    if (/[┏┓┗┛┠┨┯┷┼━─]/.test(line)) continue;
    const normalized = line.replace(/^[^┃]*/, "").replace(/[^┃]*$/, "");
    if (!normalized.includes("┃")) continue;
    const cells = normalized
      .replace(/^┃/, "")
      .replace(/┃$/, "")
      .split(/[│┃]/)
      .map(cleanCell);
    if (!cells.some(Boolean)) continue;
    const hasLeadingCell = Boolean(cells[0]);
    if (!hasLeadingCell && rows.length) {
      const previous = rows.at(-1);
      cells.forEach((cell, index) => {
        if (!cell) return;
        previous[index] = previous[index] ? `${previous[index]} ${cell}` : cell;
      });
    } else {
      rows.push(cells);
    }
  }
  return stripHeaderRows(rows);
}

function flattenAnnexUnits(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const units = [];
  for (const item of list) {
    if (Array.isArray(item?.["별표단위"])) units.push(...item["별표단위"]);
    else if (item?.["별표단위"]) units.push(item["별표단위"]);
    else units.push(item);
  }
  return units.filter(Boolean);
}

function annexText(unit) {
  const raw = unit?.["별표내용"] || unit?.["별표내용문자열"] || "";
  if (Array.isArray(raw)) return raw.flat(Infinity).map((line) => String(line ?? "")).join("\n");
  return String(raw || "");
}

function cleanCell(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/[┃│]/g, " ")
      .replace(/\s+/g, " "),
  );
}

function stripHeaderRows(rows) {
  if (!rows.length) return rows;
  const first = rows[0].join(" ");
  if (/(?:명칭|기관|직급|계|위치|관할|소속)/.test(first)) return rows.slice(1);
  return rows;
}

function classifyAnnex(title, text) {
  const haystack = `${title}\n${text}`;
  if (/^\s*삭제\b|삭제\s*&lt;|삭제\s*</.test(haystack)) return "deleted";
  if (/평가대상/.test(haystack)) return "evaluation";
  if (/한시조직|한시정원/.test(haystack)) return "temporary-headcount";
  if (/정원표|직급별\s*정원|공무원\s*정원/.test(haystack)) return "headcount";
  if (/관할구역|위치|등급구분/.test(haystack)) return "jurisdiction";
  if (/소속(?:세무서|기관|관서)|두는\s+(?:과|부서|담당관)/.test(haystack)) return "organization-matrix";
  return "other";
}

function normalizeAnnexNumber(value) {
  const raw = String(value ?? "").replace(/^0+/, "").trim();
  if (!raw) return "1";
  const match = raw.match(/(\d+)(?:의(\d+))?/);
  if (!match) return raw;
  return match[2] ? `${Number(match[1])}의${Number(match[2])}` : String(Number(match[1]));
}

function normalizeAnnexLabel(value) {
  const match = String(value || "").match(/별표\s*(\d+(?:의\d+)?)/);
  return match ? `별표 ${normalizeAnnexNumber(match[1])}` : String(value || "").trim();
}
