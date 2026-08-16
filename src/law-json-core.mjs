import { normalizeWhitespace } from "./utils-core.mjs";

// 국가법령정보센터 JSON을 Node.js와 데스크톱 WebView 양쪽에서 동일하게
// 직제 파서용 문언으로 바꾸는 브라우저 안전 모듈이다.
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

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
