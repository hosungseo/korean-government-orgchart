import { extractAnnexesFromLawJson } from "./annex.mjs";
import { flattenLawJson } from "./law-json-core.mjs";
import { compactDate } from "./utils.mjs";

export { flattenLawJson } from "./law-json-core.mjs";

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
