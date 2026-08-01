import { extractAnnexesFromLawJson } from "./annex.mjs";
import { compactDate, normalizeWhitespace } from "./utils.mjs";

const SEARCH_ENDPOINT = "https://www.law.go.kr/DRF/lawSearch.do";
const SERVICE_ENDPOINT = "https://www.law.go.kr/DRF/lawService.do";

export async function fetchLawAtDate(lawName, asOf, options = {}) {
  const oc = options.oc || process.env.LAW_API_OC || "test";
  const targetDate = compactDate(asOf);
  const searchUrl = new URL(SEARCH_ENDPOINT);
  searchUrl.search = new URLSearchParams({
    OC: oc,
    target: "eflaw",
    type: "JSON",
    query: lawName,
    display: "100",
    sort: "efdes",
  });
  const searchJson = await fetchJson(searchUrl);
  const rawEntries = searchJson?.LawSearch?.law;
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
  const candidates = entries
    .filter((entry) => entry["법령명한글"] === lawName)
    .map((entry) => ({
      ...entry,
      effectiveDate: String(entry["시행일자"] || ""),
      mst: String(entry["법령일련번호"] || ""),
    }))
    .filter((entry) => entry.effectiveDate && entry.effectiveDate <= targetDate)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  if (!candidates.length) {
    throw new Error(`${targetDate} 기준 '${lawName}' 연혁을 찾지 못했습니다.`);
  }
  const selected = candidates[0];
  const serviceUrl = new URL(SERVICE_ENDPOINT);
  serviceUrl.search = new URLSearchParams({
    OC: oc,
    target: "eflaw",
    type: "JSON",
    MST: selected.mst,
    efYd: selected.effectiveDate,
    BD: "on",
  });
  const json = await fetchJson(serviceUrl);
  return {
    lawName,
    requestedDate: targetDate,
    effectiveDate: selected.effectiveDate,
    mst: selected.mst,
    metadata: selected,
    json,
    annexes: extractAnnexesFromLawJson(json, {
      source: `${lawName} [시행 ${selected.effectiveDate}]`,
    }),
    text: flattenLawJson(json),
    sourceUrl: serviceUrl.toString(),
  };
}

export function flattenLawJson(json) {
  const law = json?.["법령"];
  if (!law) throw new Error("법령 API 응답에 '법령' 객체가 없습니다.");
  const info = law["기본정보"] || {};
  const title = info["법령명_한글"] || "법령";
  const lines = [title];
  const articleUnits = law?.["조문"]?.["조문단위"];
  for (const article of asArray(articleUnits)) {
    const articleLead = normalizeWhitespace(article?.["조문내용"] || "");
    if (articleLead) lines.push(articleLead);
    const remainder = { ...article };
    delete remainder["조문내용"];
    delete remainder["조문제목"];
    const clauses = collectLegalContents(remainder);
    if (clauses.length) lines.push(...clauses);
  }
  for (const appendix of asArray(law["별표"])) {
    const contents = collectLegalContents(appendix);
    if (contents.length) lines.push(...contents);
  }
  return normalizeWhitespace(lines.join("\n"));
}

function collectLegalContents(value) {
  const result = [];
  walk(value, "", result);
  return result.filter((item, index) => item && result.indexOf(item) === index);
}

function walk(value, key, result) {
  if (value == null) return;
  if (typeof value === "string") {
    if (/(?:내용|별표명)$/.test(key) && !/(?:번호|코드|키|여부|일자|구분)/.test(key)) {
      const clean = normalizeWhitespace(value);
      if (clean && !/^(?:조문|전문|일부개정|현행|연혁)$/.test(clean)) result.push(clean);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, key, result);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      walk(childValue, childKey, result);
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "korean-government-orgchart/0.1" },
  });
  if (!response.ok) {
    throw new Error(`법령 API 요청 실패 (${response.status}): ${url}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`법령 API JSON 파싱 실패: ${error.message}\n${text.slice(0, 300)}`);
  }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
