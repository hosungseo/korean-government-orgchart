import { stableId } from "./utils-core.mjs";

export const LEGAL_DUTY_FACT_SCHEMA = "kr.go.mois.orgchart.legal-duty-fact/v1";

const DUTY_STOPWORDS = new Set([
  "관한",
  "사항",
  "업무",
  "관련",
  "위한",
  "대한",
  "따른",
  "통한",
  "등의",
  "등에",
  "그밖에",
  "그밖의",
  "다른",
  "주관에",
  "속하지",
  "아니하는",
  "않는",
]);

const HANGUL_ITEM_MARKERS = "가나다라마바사아자차카타파하";

export function extractLegalDutyItems(text, context = {}) {
  const source = prepareDutyText(text);
  const pattern = /(?:^|\n)\s*(?:제\s*)?(\d+(?:\s*의\s*\d+)?)\s*[.)．]\s*([\s\S]*?)(?=(?:\n\s*(?:제\s*)?\d+(?:\s*의\s*\d+)?\s*[.)．]\s*)|$)/g;
  const items = [];
  for (const match of source.matchAll(pattern)) {
    const subparagraph = normalizeDutyNumber(match[1]);
    const rawText = String(match[2] || "").trim();
    const deleted = /^삭제(?:\s*<[^>]+>)?\s*$/u.test(rawText);
    const cleaned = cleanDutyText(rawText);
    if (!subparagraph || (!cleaned && !deleted)) continue;
    const number = /^\d+$/.test(subparagraph) ? Number(subparagraph) : subparagraph;
    const citation = formatLegalDutyCitation({
      article: context.article,
      paragraph: context.paragraph,
      subparagraph,
    });
    const subitems = extractDutySubitems(rawText, {
      ...context,
      subparagraph,
    });
    const residual = isResidualDuty(cleaned);
    const normalizedText = normalizeDutyFunctionText(cleaned);
    items.push({
      number,
      subparagraph,
      text: cleaned,
      rawText,
      normalizedText,
      fingerprint: normalizedText ? stableId(normalizedText) : null,
      citation,
      article: context.article || null,
      paragraph: normalizeOptionalNumber(context.paragraph),
      source: context.source || "",
      role: context.role || "",
      residual,
      deleted,
      ...(subitems.length ? { items: subitems } : {}),
    });
  }
  return items;
}

export function createLegalDutyFact(item, context = {}) {
  const owner = String(context.owner || "").trim();
  const source = context.source || item?.source || "";
  const role = context.role || item?.role || "";
  const citation = item?.citation || formatLegalDutyCitation(item || {});
  const text = cleanDutyText(item?.text || item?.rawText || "");
  const normalizedText = item?.normalizedText || normalizeDutyFunctionText(text);
  return {
    schema: LEGAL_DUTY_FACT_SCHEMA,
    id: stableId([source, role, owner, citation, normalizedText].join("|")),
    owner,
    ownerKind: context.ownerKind || "organization",
    source,
    role,
    article: item?.article || context.article || null,
    paragraph: item?.paragraph ?? normalizeOptionalNumber(context.paragraph),
    subparagraph: item?.subparagraph || normalizeDutyNumber(item?.number),
    citation,
    text,
    rawText: item?.rawText || text,
    normalizedText,
    fingerprint: item?.fingerprint || (normalizedText ? stableId(normalizedText) : null),
    residual: Boolean(item?.residual || isResidualDuty(text)),
    deleted: Boolean(item?.deleted),
    items: Array.isArray(item?.items) ? item.items : [],
  };
}

export function formatLegalDutyCitation({ article, paragraph, subparagraph, item } = {}) {
  const parts = [];
  if (article) parts.push(String(article).trim());
  if (paragraph != null && paragraph !== "") parts.push(`제${normalizeDutyNumber(paragraph)}항`);
  if (subparagraph != null && subparagraph !== "") parts.push(`제${normalizeDutyNumber(subparagraph)}호`);
  if (item) parts.push(`${String(item).trim()}목`);
  return parts.join("");
}

export function normalizeDutyNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/^제/, "")
    .replace(/(?:항|호)$/, "");
  return /^\d+(?:의\d+)?$/.test(normalized) ? normalized : "";
}

export function isValidDutyNumber(value) {
  return Boolean(normalizeDutyNumber(value));
}

export function normalizeDutyFunctionText(text) {
  return cleanDutyText(text)
    .normalize("NFKC")
    .replace(/재외\s*문화원/g, "재외공관문화원")
    .replace(/외국\s*언론/g, "해외언론")
    .replace(/외신/g, "해외언론")
    .replace(/언론\s*매체/g, "언론")
    .replace(/\s+/g, "")
    .replace(/[·ㆍᆞ.,;:()[\]{}<>"'“”‘’\-–—/]/g, "")
    .replace(/(?:에관한사항|에관한업무|에관한지원|관련업무|관련사항|의사항)$/g, "")
    .replace(/(?:등에대한|에대한|에관한|및)/g, "")
    .replace(/보도활동/g, "보도")
    .replace(/의(?=(?:수집|분석|지원|운영|관리|계획|정책|보도|제작|배포|수립|시행))/g, "")
    .replace(/(?:수립및시행|수립시행)$/g, "수립시행")
    .trim();
}

export function dutyFunctionTokens(text) {
  const prepared = cleanDutyText(text)
    .normalize("NFKC")
    .replace(/재외\s*문화원/g, "재외공관 문화원")
    .replace(/외국\s*언론|외신/g, "해외 언론")
    .replace(/[·ㆍ,;:()[\]{}<>"'“”‘’\-–—/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...new Set(prepared
    .split(" ")
    .map((token) => token.replace(/(?:으로|에서|에게|부터|까지|이나|이며|하고|하며|및)$/g, ""))
    .filter((token) => token.length >= 2 && !DUTY_STOPWORDS.has(token)))];
}

export function dutyFunctionSimilarity(left, right) {
  const a = normalizeDutyFunctionText(left);
  const b = normalizeDutyFunctionText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const containment = a.includes(b) || b.includes(a)
    ? Math.min(a.length, b.length) / Math.max(a.length, b.length)
    : 0;
  const tokenScore = diceSet(new Set(dutyFunctionTokens(left)), new Set(dutyFunctionTokens(right)));
  const bigramScore = diceSet(characterNgrams(a, 2), characterNgrams(b, 2));
  const trigramScore = diceSet(characterNgrams(a, 3), characterNgrams(b, 3));
  return roundScore(Math.max(
    containment,
    tokenScore * 0.46 + bigramScore * 0.34 + trigramScore * 0.20,
  ));
}

export function isResidualDuty(text) {
  return /그\s*밖에|그\s*밖의|다른\s*(?:과|팀|부서).*주관에\s*속하지/u.test(String(text || ""));
}

export function auditLegalDutyFacts(graph) {
  const nodes = graph?.nodes instanceof Map ? [...graph.nodes.values()] : Object.values(graph?.nodes || {});
  const nodeNames = new Set(nodes.map((node) => node?.name).filter(Boolean));
  const departments = nodes.filter((node) => (
    node?.name
    && /(?:과|팀|담당관)$/.test(node.name)
    && !["institution", "head", "deputy"].includes(node.kind)
  ));
  const facts = Array.isArray(graph?.meta?.dutyFacts) ? graph.meta.dutyFacts : [];
  const activeFacts = facts.filter((fact) => !fact.deleted);
  const departmentFacts = activeFacts.filter((fact) => fact.ownerKind === "department");
  const covered = new Set(departmentFacts.map((fact) => fact.owner).filter(Boolean));
  const duplicateGroups = new Map();
  for (const fact of activeFacts) {
    const key = `${fact.source || ""}|${fact.owner || ""}|${fact.citation || ""}`;
    if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
    duplicateGroups.get(key).push(fact);
  }
  const conflictingCitations = [...duplicateGroups.entries()].flatMap(([key, entries]) => {
    const texts = [...new Set(entries.map((entry) => entry.normalizedText).filter(Boolean))];
    return texts.length > 1 ? [{ key, texts: texts.length }] : [];
  });
  const invalidCitations = activeFacts.filter((fact) => !/제\d+조/.test(fact.citation || ""));
  const orphanOwners = [...new Set(departmentFacts
    .map((fact) => fact.owner)
    .filter((owner) => owner && !nodeNames.has(owner)))];
  const missingDepartments = departments
    .map((node) => node.name)
    .filter((name) => !covered.has(name));
  const coverage = departments.length ? covered.size / departments.length : 0;
  const issues = [
    ...(conflictingCitations.length ? [`같은 조문 주소에 서로 다른 기능 ${conflictingCitations.length}건`] : []),
    ...(invalidCitations.length ? [`조문 주소가 불완전한 기능 ${invalidCitations.length}건`] : []),
    ...(orphanOwners.length ? [`조직 노드와 연결되지 않은 기능 소유자 ${orphanOwners.length}개`] : []),
  ];
  return {
    schema: "kr.go.mois.orgchart.legal-duty-audit/v1",
    status: issues.length ? "review" : "ok",
    facts: facts.length,
    activeFacts: activeFacts.length,
    deletedFacts: facts.length - activeFacts.length,
    residualFacts: activeFacts.filter((fact) => fact.residual).length,
    decreeFacts: activeFacts.filter((fact) => fact.role === "decree").length,
    ruleFacts: activeFacts.filter((fact) => fact.role === "rule").length,
    departments: departments.length,
    coveredDepartments: covered.size,
    coverage: Number(coverage.toFixed(3)),
    missingDepartments,
    conflictingCitations,
    invalidCitationCount: invalidCitations.length,
    orphanOwners,
    issues,
  };
}

function prepareDutyText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/([.;。])\s+(?=(?:제\s*)?\d+(?:\s*의\s*\d+)?\s*[.)．]\s*[가-힣])/g, "$1\n")
    .trim();
}

function cleanDutyText(value) {
  return String(value || "")
    .replace(/<개정\s*[^>]+>/g, "")
    .replace(/<삭제\s*[^>]+>/g, "")
    .replace(/\s*<\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?>\s*$/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.;。]\s*$/g, "")
    .trim();
}

function extractDutySubitems(text, context = {}) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*([${HANGUL_ITEM_MARKERS}])\\s*[.)]\\s*([\\s\\S]*?)(?=(?:\\n\\s*[${HANGUL_ITEM_MARKERS}]\\s*[.)]\\s*)|$)`,
    "g",
  );
  const items = [];
  for (const match of source.matchAll(pattern)) {
    const textValue = cleanDutyText(match[2]);
    if (!textValue) continue;
    items.push({
      item: match[1],
      text: textValue,
      citation: formatLegalDutyCitation({
        article: context.article,
        paragraph: context.paragraph,
        subparagraph: context.subparagraph,
        item: match[1],
      }),
      normalizedText: normalizeDutyFunctionText(textValue),
    });
  }
  return items;
}

function characterNgrams(value, size) {
  const result = new Set();
  if (value.length < size) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function diceSet(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function normalizeOptionalNumber(value) {
  const normalized = normalizeDutyNumber(value);
  if (!normalized) return null;
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

function roundScore(value) {
  return Number(Number(value || 0).toFixed(3));
}
