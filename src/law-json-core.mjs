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
    const clauses = collectStructuredArticleContents(article);
    if (clauses.length) lines.push(...clauses);
  }
  for (const appendix of asArray(law["별표"])) {
    const contents = collectLegalContents(appendix);
    if (contents.length) lines.push(...contents);
  }
  return normalizeWhitespace(lines.join("\n"));
}

function collectStructuredArticleContents(article) {
  const result = [];
  const paragraphs = asArray(article?.["항"]);
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex] || {};
    const paragraphMarker = legalMarker(
      paragraph["항번호"] || paragraph["항가지번호"] || paragraphIndex + 1,
      "paragraph",
    );
    pushMarkedContent(result, paragraph["항내용"], paragraphMarker);
    const subparagraphs = asArray(paragraph["호"]);
    for (let subparagraphIndex = 0; subparagraphIndex < subparagraphs.length; subparagraphIndex += 1) {
      const subparagraph = subparagraphs[subparagraphIndex] || {};
      const subparagraphMarker = legalMarker(
        subparagraph["호번호"] || subparagraph["호가지번호"] || subparagraphIndex + 1,
        "subparagraph",
      );
      pushMarkedContent(result, subparagraph["호내용"], subparagraphMarker);
      const items = asArray(subparagraph["목"]);
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex] || {};
        const itemMarker = legalMarker(item["목번호"] || itemIndex, "item");
        pushMarkedContent(result, item["목내용"], itemMarker);
      }
    }
  }
  if (result.length) return uniqueInOrder(result);

  const remainder = { ...article };
  delete remainder["조문내용"];
  delete remainder["조문제목"];
  return collectLegalContents(remainder);
}

function pushMarkedContent(result, value, marker) {
  const content = normalizeWhitespace(value || "");
  if (!content) return;
  if (!marker || content.startsWith(marker) || hasEquivalentLeadingMarker(content, marker)) {
    result.push(content);
    return;
  }
  result.push(`${marker} ${content}`);
}

function legalMarker(value, kind) {
  const raw = normalizeWhitespace(value || "").replace(/\s+/g, "");
  if (kind === "paragraph") {
    if (/^[①-⑳㉑]$/.test(raw)) return raw;
    const number = Number(raw.replace(/\D/g, ""));
    return circleNumber(number) || (Number.isFinite(number) && number > 0 ? `<${number}>` : raw);
  }
  if (kind === "subparagraph") {
    const number = raw.replace(/^제/, "").replace(/호$/, "").replace(/\.$/, "");
    return /^\d+(?:의\d+)?$/.test(number) ? `${number}.` : raw;
  }
  const itemLetters = "가나다라마바사아자차카타파하";
  if (/^[가-하]\.?$/.test(raw)) return raw.endsWith(".") ? raw : `${raw}.`;
  const numeric = Number(raw);
  const letter = itemLetters[numeric] || "";
  return letter ? `${letter}.` : raw;
}

function hasEquivalentLeadingMarker(content, marker) {
  if (/^[①-⑳㉑]/.test(content) && /^[①-⑳㉑]/.test(marker)) return true;
  if (/^<\d+>/.test(content) && (/^<\d+>/.test(marker) || /^[①-⑳㉑]/.test(marker))) return true;
  if (/^\d+(?:의\d+)?\./.test(content) && /^\d+(?:의\d+)?\./.test(marker)) return true;
  if (/^[가-하]\./.test(content) && /^[가-하]\./.test(marker)) return true;
  return false;
}

function circleNumber(number) {
  const circles = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑";
  return Number.isInteger(number) && number >= 1 && number <= circles.length
    ? circles[number - 1]
    : "";
}

function collectLegalContents(value) {
  const result = [];
  walk(value, "", result);
  return result.filter((item, index) => item && result.indexOf(item) === index);
}

function uniqueInOrder(values) {
  return values.filter((item, index) => item && values.indexOf(item) === index);
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
