import {
  inferHeadTitle,
  inferKind,
  inferRank,
  normalizeNodeName,
  OrgGraph,
} from "./model.mjs";
import { normalizeWhitespace, uniq } from "./utils.mjs";

const STRUCTURAL_SUFFIX =
  /(?:부|처|청|위원회|실|국|본부|단|과|팀|관|원|소|센터|사무국|사무소|학교|박물관|미술관|도서관|극장|전당|세무서|소방서|연구원|기록원|관리원|교육원|개발원|분원|지소)$/;
const JURISDICTION_ADVISOR_SUFFIX =
  "(?:정책관|기획관|관리관|심의관|교섭관|법무관|지원관|소통관)";
const DUTY_PARAGRAPH_MARKER =
  "(?:[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑]|<\\d+>)";
const GENERIC_NAMES = new Set([
  "보조기관",
  "보좌기관",
  "하부조직",
  "정책관등",
  "각 과",
  "각 국",
  "소속기관",
  "공무원",
  "사무",
  "사무소",
  "정원",
  "한시정원",
  "고위공무원단",
  "전문위원",
  "부",
  "실",
  "국",
  "과",
  "팀",
  "관",
  "원",
  "소",
  "본부",
  "단",
  "센터",
  "분원",
  "지소",
  "위원",
  "부위원",
]);

export function parseOrganizationTexts(texts, options = {}) {
  const documents = texts.map((text, index) => ({
    text: normalizeWhitespace(text),
    source: options.sources?.[index] || `입력 ${index + 1}`,
  }));
  const directives = Object.assign({}, ...documents.map((document) => parseDirectives(document.text)));
  const institution =
    options.institution ||
    directives.institution ||
    documents.map((document) => inferInstitution(document.text)).find(Boolean) ||
    "행정기관";
  const graph = new OrgGraph({
    institution,
    asOf: options.asOf || directives.asOf,
    title: options.title || institution,
  });
  const aliasTargets = new Map();
  for (const document of documents) {
    for (const [alias, fullName] of extractAliases(document.text)) {
      if (!aliasTargets.has(alias)) aliasTargets.set(alias, new Set());
      aliasTargets.get(alias).add(fullName);
    }
  }
  for (const [alias, targets] of aliasTargets) {
    if (targets.size === 1) graph.aliases.set(alias, [...targets][0]);
  }
  for (const document of documents) {
    graph.addSource(document.source);
    parseDocumentIntoGraph(graph, document.text, document.source);
  }
  applyDirectives(graph, directives);
  graph.finalize({
    headName: options.headName || directives.head || inferHeadTitle(institution),
    deputyName: options.deputyName || directives.deputy,
  });
  for (const document of documents) {
    applyDocumentMetadata(graph, document.text, document.source);
  }
  graph.validateLegalStructure();
  return graph;
}

function extractAliases(text) {
  const aliases = [];
  const pattern =
    /([가-힣A-Za-z0-9]+)\s*\(이하(?:\s+이\s+(?:장|조|항)에서)?\s*["“]([^"”]+)["”](?:라|이라)\s*한다\)/g;
  for (const match of String(text).matchAll(pattern)) {
    aliases.push([normalizeNodeName(match[2]), normalizeNodeName(match[1])]);
  }
  return aliases;
}

export function splitArticles(text) {
  const prepared = String(text)
    .replace(/(?<!^)(?=제\d+조(?:의\d+)?\s*\()/g, "\n")
    .replace(/(?<!^)(?=\s*제\d+장\s)/g, "\n");
  const matches = [...prepared.matchAll(/(?:^|\n)\s*(제\d+조(?:의\d+)?\s*\(([^)]+)\)[^\n]*)/g)];
  if (!matches.length) return [{ heading: "", lead: "", body: prepared }];
  return matches.map((match, index) => {
    const start = match.index + match[0].indexOf(match[1]);
    const end = matches[index + 1]?.index ?? prepared.length;
    const chunk = prepared.slice(start, end).trim();
    const lineEnd = chunk.indexOf("\n");
    const lead = lineEnd >= 0 ? chunk.slice(0, lineEnd) : chunk;
    return {
      heading: match[2]?.trim() || "",
      lead,
      body: chunk,
    };
  });
}

function parseDocumentIntoGraph(graph, text, source) {
  for (const article of splitArticles(text)) {
    for (const [alias, fullName] of extractAliases(article.body)) {
      graph.aliases.set(alias, fullName);
    }
    const contextName = /[ㆍ·,]|\s및\s|\s밑에\s|\s보좌하는\s/.test(article.heading)
      ? ""
      : normalizeNodeName(article.heading);
    const context = isPlausibleNode(contextName)
      ? graph.nodeByName(contextName) ||
        graph.addNode(contextName, {
          kind: inferKind(contextName),
          rank: inferRank(contextName),
          source,
        })
      : null;
    const body = stripAmendmentNotes(article.body);
    const articleIsAffiliated = /소속기관/.test(article.heading);
    parseTemporaryRelations(graph, body, source, context);
    parseAffiliatedRelations(graph, body, source, context);
    parseDeputyJurisdictions(graph, body, source);
    parseBelowRelations(graph, body, source, context);
    parseAdministrativeRulePlacement(graph, body, source, context);
    parseInRelations(graph, body, source, context, { articleIsAffiliated });
    parseAdvisorDefinitions(graph, body, source, context);
    parseAdvisorySentences(graph, body, source, context);
    collectJurisdictionRelations(graph, body, source);
    markSpecialMetadata(graph, body, source);
  }
}

/**
 * Administrative rules for autonomous organizations use a different legal
 * form from a decree: "X는 A B에 둔다". The last unit is the immediate parent;
 * the preceding unit, when present, is retained as its structural ancestor.
 */
function parseAdministrativeRulePlacement(graph, body, source, context) {
  const pattern =
    /([가-힣A-Za-z0-9]+(?:과|팀|담당관|단|실|국|관))(?:은|는)\s+((?:[가-힣A-Za-z0-9]+(?:실|국|본부|단|관)\s+)?[가-힣A-Za-z0-9]+(?:국|실|본부|단|관|과|팀))에\s*둔다/g;
  for (const match of body.matchAll(pattern)) {
    const childName = normalizeNodeName(match[1]);
    const holders = match[2].trim().split(/\s+/).map(normalizeNodeName).filter(Boolean);
    const parentName = holders.at(-1) || context?.name || graph.meta.institution;
    const child = graph.addNode(childName, {
      kind: /(?:과|팀|담당관)$/.test(childName) ? "assistant" : "temporary",
      source,
      forceKind: true,
      metadata: {
        autonomous: true,
        countsTowardStructure: false,
        sourceKind: "administrative-rule",
        placementBasis: "훈령 제2조제2항",
      },
    });
    const parent = graph.addNode(parentName, { source });
    if (!child || !parent) continue;
    graph.addEdge(parent.id, child.id, {
      type: "structural",
      source,
      metadata: { autonomous: true, legalBasis: "행정규칙 소속 위치 지정" },
    });
    if (holders.length > 1) {
      const ancestor = graph.addNode(holders.at(-2), { source });
      if (ancestor) {
        graph.addEdge(ancestor.id, parent.id, {
          type: "structural",
          source,
          metadata: { autonomous: true, legalBasis: "행정규칙 소속 위치 지정" },
        });
      }
    }
  }
  const expiry = body.match(/제\s*6\s*조[^\n]*?(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일까지/);
  if (expiry) {
    const expires = `${expiry[1]}-${String(expiry[2]).padStart(2, "0")}-${String(expiry[3]).padStart(2, "0")}`;
    for (const node of graph.nodes.values()) {
      if (!node.metadata?.autonomous) continue;
      node.metadata.expires ||= expires;
      node.metadata.autonomous = true;
      node.metadata.countsTowardStructure = false;
    }
  }
}

/**
 * Records the operational jurisdiction of a department without changing the
 * legal installation tree.  A common 시행규칙 form installs every department
 * directly under a 실, while the department's duty clause states that it is
 * one of the departments "within ○○정책관".  The latter is useful for an
 * operational chart, but it is not a new "X에 과를 둔다" installation clause.
 */
function collectJurisdictionRelations(graph, body, source) {
  const paragraphs = extractDepartmentDutyParagraphs(body);
  for (const paragraph of paragraphs) {
    const departmentName = normalizeNodeName(paragraph.departmentName);
    const advisorName = extractJurisdictionAdvisorName(paragraph.text);
    if (!departmentName || !advisorName) continue;
    const department = graph.addNode(departmentName, { kind: "assistant", source });
    const advisor = graph.addNode(advisorName, { kind: "advisor", source });
    if (!department || !advisor) continue;
    setJurisdictionRelation(graph, advisor.name, department.name, {
      source,
      evidence: "explicit-duty-clause",
      legalBasis: "보좌기관 내 다른 과의 주관·소관",
    });
  }
  collectJurisdictionRangeRelations(graph, body, source, paragraphs);
}

function extractDepartmentDutyParagraphs(body) {
  const paragraphs = [];
  const paragraphPattern = new RegExp(
    `(?:^|\\n|\\s)${DUTY_PARAGRAPH_MARKER}\\s*([가-힣A-Za-z0-9]+(?:과|팀))장은([\\s\\S]*?)(?=(?:\\n|\\s)${DUTY_PARAGRAPH_MARKER}\\s*[가-힣A-Za-z0-9]+(?:과|팀)장은|\\n제\\d+조|$)`,
    "g",
  );
  for (const match of body.matchAll(paragraphPattern)) {
    paragraphs.push({
      departmentName: match[1],
      text: match[2] || "",
    });
  }
  return paragraphs;
}

function collectJurisdictionRangeRelations(graph, body, source, paragraphs) {
  const advisorHints = extractAdvisorDutyRangeHints(body, source);
  if (!advisorHints.length) return;
  graph.meta.jurisdictionRangeHints ||= [];
  for (const hint of advisorHints) upsertByKey(graph.meta.jurisdictionRangeHints, hint, ["advisor", "source", "reference"]);

  graph.meta.jurisdictionRangeCandidates ||= [];
  for (const paragraph of paragraphs) {
    const departmentName = normalizeNodeName(paragraph.departmentName);
    if (!departmentName) continue;
    const department = graph.addNode(departmentName, { kind: "assistant", source });
    if (!department || department.metadata.jurisdiction) continue;
    const refs = extractDecreeItemReferences(paragraph.text);
    if (!refs.length) continue;
    const matchingHints = advisorHints.filter((hint) => hintCoversAllReferences(hint, refs));
    const candidate = {
      department: department.name,
      reference: formatDutyReferences(refs),
      advisors: matchingHints.map((hint) => hint.advisor),
      source,
    };
    upsertByKey(graph.meta.jurisdictionRangeCandidates, candidate, ["department", "source", "reference"]);
    if (matchingHints.length !== 1) continue;
    const hint = matchingHints[0];
    setJurisdictionRelation(graph, hint.advisor, department.name, {
      source,
      evidence: "duty-item-range",
      legalBasis: "직제 호 번호 범위 대조",
      reference: candidate.reference,
    });
  }
}

function extractJurisdictionAdvisorName(text) {
  const advisorPattern = new RegExp(
    `([가-힣A-Za-z0-9]+${JURISDICTION_ADVISOR_SUFFIX})(?:\\s*내|\\s*이\\s*보좌하는\\s*사항\\s*중(?:에서)?)\\s*[^.。\\n]{0,100}?(?:다른\\s*(?:과|팀)(?:\\s*(?:및|ㆍ|·)\\s*(?:과|팀))?의\\s*(?:주관|소관)|주관에\\s*속하지|소관에\\s*해당하지)`,
  );
  return text.match(advisorPattern)?.[1] || null;
}

function extractAdvisorDutyRangeHints(body, source) {
  const hints = [];
  const pattern = new RegExp(
    `([가-힣A-Za-z0-9]+${JURISDICTION_ADVISOR_SUFFIX})(?:은|는)\\s+([^.。\\n]{0,360}?직제[^.。\\n]{0,260}?사항[^.。\\n]{0,160}?보좌한다)`,
    "g",
  );
  for (const match of body.matchAll(pattern)) {
    const advisor = normalizeNodeName(match[1]);
    const refs = extractDecreeItemReferences(match[2]);
    if (!advisor || !refs.length) continue;
    hints.push({
      advisor,
      refs,
      reference: formatDutyReferences(refs),
      source,
      legalBasis: "보좌기관 직제 호 번호 범위",
    });
  }
  return hints;
}

function extractDecreeItemReferences(text) {
  const refs = [];
  const lawRefPattern =
    /직제\s+(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*제\s*\d+\s*항)?)([^.。\n]{0,260})/g;
  for (const match of String(text ?? "").matchAll(lawRefPattern)) {
    const refKey = compactLawReference(match[1]);
    for (const range of extractItemRanges(match[2])) refs.push({ ...range, refKey });
  }
  return uniqReferences(refs);
}

function extractItemRanges(text) {
  const ranges = [];
  const source = String(text ?? "");
  const rangeSpans = [];
  const rangePattern = /제\s*(\d+)\s*호\s*부터\s*제\s*(\d+)\s*호\s*까지/g;
  for (const match of source.matchAll(rangePattern)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) ranges.push(normalizeItemRange(start, end));
    rangeSpans.push([match.index, match.index + match[0].length]);
  }
  const singlePattern = /제\s*(\d+)\s*호/g;
  for (const match of source.matchAll(singlePattern)) {
    if (rangeSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const item = Number(match[1]);
    if (Number.isFinite(item)) ranges.push({ start: item, end: item });
  }
  return uniqReferences(ranges);
}

function normalizeItemRange(start, end) {
  return start <= end ? { start, end } : { start: end, end: start };
}

function compactLawReference(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function uniqReferences(refs) {
  const seen = new Set();
  const result = [];
  for (const ref of refs) {
    if (!Number.isFinite(ref.start) || !Number.isFinite(ref.end)) continue;
    const key = `${ref.refKey || ""}:${ref.start}-${ref.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result.sort(
    (a, b) =>
      String(a.refKey || "").localeCompare(String(b.refKey || ""), "ko") ||
      a.start - b.start ||
      a.end - b.end,
  );
}

function hintCoversAllReferences(hint, refs) {
  return refs.every((ref) =>
    hint.refs.some((candidate) => {
      const sameReference = !candidate.refKey || !ref.refKey || candidate.refKey === ref.refKey;
      return sameReference && candidate.start <= ref.start && candidate.end >= ref.end;
    }),
  );
}

function formatDutyReferences(refs) {
  const grouped = new Map();
  for (const ref of refs) {
    const key = ref.refKey || "직제";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ref.start === ref.end ? `제${ref.start}호` : `제${ref.start}호부터 제${ref.end}호까지`);
  }
  return [...grouped.entries()].map(([key, items]) => `${key} ${uniq(items).join("ㆍ")}`).join(", ");
}

function upsertByKey(collection, entry, keys) {
  const existing = collection.find((item) => keys.every((key) => item[key] === entry[key]));
  if (existing) Object.assign(existing, entry);
  else collection.push(entry);
}

function setJurisdictionRelation(graph, parentName, childName, attrs) {
  const parent = graph.addNode(parentName, { kind: "advisor", source: attrs.source });
  const child = graph.addNode(childName, { kind: "assistant", source: attrs.source });
  if (!parent || !child) return;
  const relation = {
    parent: parent.name,
    child: child.name,
    source: attrs.source,
    evidence: attrs.evidence,
    legalBasis: attrs.legalBasis,
    ...(attrs.reference ? { reference: attrs.reference } : {}),
  };
  child.metadata.jurisdiction = {
    parent: parent.name,
    evidence: attrs.evidence,
    legalBasis: attrs.legalBasis,
    source: attrs.source,
    ...(attrs.reference ? { reference: attrs.reference } : {}),
  };
  graph.meta.jurisdictionRelations ||= [];
  const existing = graph.meta.jurisdictionRelations.find(
    (item) => item.parent === relation.parent && item.child === relation.child,
  );
  if (existing) Object.assign(existing, relation);
  else graph.meta.jurisdictionRelations.push(relation);
}

function parseBelowRelations(graph, body, source, context) {
  const patterns = [
    /([가-힣A-Za-z0-9]+)\s*밑에\s+([^.。\n]{1,260}?)\s*(?:을|를)\s*(?:둔다|두고|두며|두되)/g,
    /([가-힣A-Za-z0-9]+)\s*밑에\s+두는\s+(?:보조기관|보좌기관)은\s+([^.。\n]{1,220}?)\s*(?:으로|로)\s*(?:하며|한다)/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      if (/「|에\s*따른|보좌기관\s*중/.test(match[2])) continue;
      const parentName = resolveHolderName(match[1], context?.name);
      const parent = graph.addNode(parentName, { source });
      if (!parent) continue;
      for (const childName of parseNameList(match[2])) {
        const existing = graph.nodeByName(childName);
        const isAffiliated = existing?.metadata?.unitRole === "affiliated-institution";
        const inferredKind = inferKind(childName);
        const isSpine = inferredKind === "head" || inferredKind === "deputy";
        const child = graph.addNode(childName, {
          kind: isSpine ? inferredKind : isAffiliated ? "affiliated" : "advisor",
          source,
          forceKind: true,
          metadata: isAffiliated
            ? { unitRole: "affiliated-institution" }
            : undefined,
        });
        if (!child) continue;
        graph.addEdge(parent.id, child.id, {
          type: isSpine ? "structural" : isAffiliated ? "affiliated" : "advisor",
          source,
          metadata: { legalBasis: "밑에 둔다" },
        });
      }
    }
  }
}

function parseDeputyJurisdictions(graph, body, source) {
  const pattern =
    /((?:제\d+)?차관|차장|부위원장)(?:은|는)\s+([^.。\n]{1,420}?)의\s+소관업무에\s+관하여\s+(?:장관|청장|처장|위원장)(?:을|를)\s+보조한다/g;
  for (const match of body.matchAll(pattern)) {
    const deputy = graph.addNode(match[1], { kind: "deputy", source });
    if (!deputy) continue;
    for (const childName of parseNameList(match[2])) {
      const child = graph.addNode(childName, {
        kind: "assistant",
        source,
        forceKind: true,
      });
      if (!child) continue;
      graph.addEdge(deputy.id, child.id, {
        type: "assistant",
        source,
        metadata: { jurisdiction: true, legalBasis: "소관업무에 관하여 보조한다" },
      });
    }
  }
}

function parseInRelations(graph, body, source, context, { articleIsAffiliated = false } = {}) {
  const pattern =
    /([가-힣A-Za-z0-9ㆍ·]+(?:부|처|청|위원회|실|국|본부|단|관|원|소|센터|사무국|사무소|학교|박물관|미술관|도서관|극장|전당|세무서|소방서|연구원|기록원|관리원|교육원|개발원|분원|지소))에\s+([^.。\n]{1,280}?)\s*(?:을|를)\s*(?:둔다|두고|두며|두되|둔다고 한다)/g;
  for (const match of body.matchAll(pattern)) {
    const parentName = normalizeNodeName(match[1]);
    if (!isPlausibleNode(parentName) && parentName !== graph.meta.institution) continue;
    const parent =
      parentName === graph.meta.institution
        ? graph.nodes.get(graph.rootId)
        : graph.addNode(parentName, { source });
    if (!parent) continue;
    const sentence = sentenceAt(body, match.index);
    const isAdvisoryPurpose = /보좌하기\s+위하여/.test(sentence);
    const affiliationType = articleIsAffiliated
      ? /책임운영기관/.test(sentence)
        ? "responsible"
        : /소관\s*사무를\s*분장하기\s+위하여/.test(sentence)
          ? "special-local"
          : /관장\s*사무를\s+지원하기\s+위하여/.test(sentence)
            ? "subsidiary"
            : "affiliated"
      : null;
    for (const childName of parseNameList(match[2])) {
      const existing = graph.nodeByName(childName);
      const isAlreadyAffiliated = existing?.metadata?.unitRole === "affiliated-institution";
      const isAffiliated = articleIsAffiliated || isAlreadyAffiliated;
      const inferredKind = inferKind(childName);
      const child = graph.addNode(childName, {
        kind:
          inferredKind === "head" || inferredKind === "deputy"
            ? inferredKind
            : isAffiliated
              ? "affiliated"
              : isAdvisoryPurpose
                ? "advisor"
                : "assistant",
        source,
        forceKind: true,
        metadata: affiliationType || isAlreadyAffiliated
          ? {
              ...(affiliationType
                ? { affiliationType, responsible: affiliationType === "responsible" }
                : {}),
              unitRole: "affiliated-institution",
            }
          : /본부$/.test(childName)
            ? { unitRole: "headquarters" }
            : undefined,
      });
      if (!child) continue;
      graph.addEdge(parent.id, child.id, {
        type:
          inferredKind === "head" || inferredKind === "deputy"
            ? "structural"
            : isAffiliated
              ? "affiliated"
              : isAdvisoryPurpose
                ? "advisor"
                : "assistant",
        source,
        metadata: {
          legalBasis: isAdvisoryPurpose ? "보좌하기 위하여 에 둔다" : "에 둔다",
          ...(affiliationType || isAlreadyAffiliated
            ? {
                ...(affiliationType ? { affiliationType } : {}),
                unitRole: "affiliated-institution",
              }
            : /본부$/.test(childName)
              ? { unitRole: "headquarters" }
              : {}),
        },
      });
    }
  }

  if (context) {
    const genericPattern =
      /(?:해당\s+)?(?:기관|본부|실|국|원|소)에\s+([^.。\n]{1,220}?)\s*(?:을|를)\s*(?:둔다|두고|두며|두되)/g;
    for (const match of body.matchAll(genericPattern)) {
      for (const childName of parseNameList(match[1])) {
        const child = graph.addNode(childName, { kind: "assistant", source });
        if (child) {
          graph.addEdge(context.id, child.id, {
            type: "assistant",
            source,
            metadata: { legalBasis: "에 둔다" },
          });
        }
      }
    }
  }
}

function parseAffiliatedRelations(graph, body, source, context) {
  const patterns = [
    /([가-힣A-Za-z0-9]+)장\s+소속(?:으로|\s*하에)\s+([^.。\n]{1,260}?)\s*(?:을|를)\s*둔다/g,
    /([가-힣A-Za-z0-9]+)\s+소속(?:으로|\s*하에)\s+([^.。\n]{1,260}?)\s*(?:을|를)\s*둔다/g,
    /소속(?:의)?\s+(?:책임운영기관으로\s+)?([^.。\n]{1,260}?)\s*(?:을|를)\s*둔다/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const hasNamedParent = match.length >= 3;
      const parentToken = hasNamedParent ? match[1] : null;
      const listText = hasNamedParent ? match[2] : match[1];
      let parent = graph.nodes.get(graph.rootId);
      if (parentToken) {
        const resolved = resolveHolderName(parentToken, context?.name);
        if (resolved && resolved !== graph.meta.institution) {
          parent = graph.addNode(resolved, { source }) || parent;
        }
      }
      const sentence = sentenceAt(body, match.index);
      const affiliationType = /책임운영기관/.test(sentence)
        ? "responsible"
        : /소관\s+사무를\s+분장하기\s+위하여/.test(sentence)
          ? "special-local"
          : /관장\s*사무를\s+지원하기\s+위하여/.test(sentence)
            ? "subsidiary"
            : "affiliated";
      for (const childName of parseNameList(listText)) {
        const child = graph.addNode(childName, {
          kind: "affiliated",
          source,
          forceKind: true,
          metadata: {
            affiliationType,
            responsible: affiliationType === "responsible",
            unitRole: "affiliated-institution",
          },
        });
        if (child) {
          graph.addEdge(parent.id, child.id, {
            type: "affiliated",
            source,
            metadata: { affiliationType },
          });
        }
      }
    }
  }
}

function parseAdvisorDefinitions(graph, body, source, context) {
  const pattern =
    /([가-힣A-Za-z0-9]+)\s*밑에\s+두는\s+보좌기관은\s+([^.。\n]{1,220}?)\s*(?:으로|로)\s*(?:하며|한다)/g;
  for (const match of body.matchAll(pattern)) {
    const parentName = resolveHolderName(match[1], context?.name);
    const parent = graph.addNode(parentName, { source });
    for (const childName of parseNameList(match[2])) {
      const child = graph.addNode(childName, {
        kind: "advisor",
        source,
        forceKind: true,
      });
      if (parent && child) graph.addEdge(parent.id, child.id, { type: "advisor", source });
    }
  }
}

function parseAdvisorySentences(graph, body, source, context) {
  const multiTargetPattern =
    /([가-힣A-Za-z0-9]+)(?:은|는)\s+[^.。\n]{0,260}?\s+((?:(?:장관|청장|처장|위원장|부위원장|차장|(?:제\d+)?차관|[가-힣A-Za-z0-9]+(?:실장|국장|본부장|단장|처장|청장))(?:\s*(?:과|와|및|ㆍ|·|,)\s*)?)+)(?:을|를)\s+(?:직접\s+)?보좌한다/g;
  for (const match of body.matchAll(multiTargetPattern)) {
    const childName = normalizeNodeName(match[1]) || context?.name;
    if (!childName) continue;
    const child = graph.addNode(childName, {
      kind: "advisor",
      source,
      forceKind: true,
    });
    for (const parentName of parseHolderList(match[2], context?.name)) {
      const parent = graph.addNode(parentName, { source });
      if (parent && child) {
        graph.addEdge(parent.id, child.id, {
          type: "advisor",
          source,
          metadata: { legalBasis: "보좌한다", explicitTarget: true },
        });
      }
    }
  }

  const pattern =
    /([가-힣A-Za-z0-9]+)(?:은|는)\s+[^.。\n]{0,220}?\s+([가-힣A-Za-z0-9]+)(?:을|를)\s+(?:직접\s+)?보좌한다/g;
  for (const match of body.matchAll(pattern)) {
    const parsedChildName = normalizeNodeName(match[1]);
    const childName = isPlausibleNode(parsedChildName) ? parsedChildName : context?.name;
    const parentName = resolveHolderName(match[2], context?.name);
    if (!childName || !parentName) continue;
    const child = graph.addNode(childName, {
      kind: "advisor",
      source,
      forceKind: true,
    });
    const parent = graph.addNode(parentName, { source });
    if (parent && child) graph.addEdge(parent.id, child.id, { type: "advisor", source });
  }
}

function parseHolderList(value, contextName) {
  return uniq(
    String(value)
      .replace(/\s*(?:과|와|및|ㆍ|·|,)\s*/g, "ㆍ")
      .split("ㆍ")
      .map((holder) => resolveHolderName(holder, contextName))
      .filter(Boolean),
  );
}

function parseTemporaryRelations(graph, body, source, context) {
  const pattern =
    /(?:(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일까지\s+존속하는\s+)?한시조직으로\s+([^.。\n]{1,160}?)\s*(?:을|를)\s*둔다/g;
  for (const match of body.matchAll(pattern)) {
    const expiry = match[1]
      ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`
      : null;
    const parentMatch = body.slice(Math.max(0, match.index - 120), match.index).match(
      /([가-힣A-Za-z0-9]+(?:부|처|청|위원회|실|국|본부|단|관|원|소|센터))에[^.]*$/,
    );
    const parent =
      graph.addNode(parentMatch?.[1] || context?.name || graph.meta.institution, { source }) ||
      graph.nodes.get(graph.rootId);
    for (const childName of parseNameList(match[4])) {
      const child = graph.addNode(childName, {
        kind: "temporary",
        source,
        forceKind: true,
        metadata: { temporary: true, expires: expiry },
      });
      if (child) graph.addEdge(parent.id, child.id, { type: "temporary", source });
    }
  }
}

function markSpecialMetadata(graph, body, source) {
  const patterns = [
    {
      regex: /총액인건비제를\s+활용하여\s+(?:설치한|두는|신설한)?\s*(.{1,100}?)(?:을|를)\s*(?:둔다|운영한다)/g,
      key: "payroll",
    },
    {
      regex: /자율기구(?:로|로서)?\s+(.{1,100}?)(?:을|를)\s*(?:둔다|운영한다)/g,
      key: "autonomous",
    },
    {
      regex: /평가대상\s*조직(?:으로)?\s+(.{1,100}?)(?:을|를)\s*(?:둔다|신설한다)/g,
      key: "evaluation",
    },
  ];
  for (const { regex, key } of patterns) {
    for (const match of body.matchAll(regex)) {
      for (const name of parseNameList(match[1])) {
        const node = graph.addNode(name, { source });
        if (node) {
          node.metadata[key] = true;
          if (key === "autonomous") node.metadata.countsTowardStructure = false;
          if (key === "payroll" || key === "temporary") node.metadata.countsTowardStructure = true;
        }
      }
    }
  }

  // A standalone administrative-rule title often carries the only explicit
  // autonomous marker; the placement parser above supplies the node itself.
  if (/자율기구/.test(body)) {
    for (const node of graph.nodes.values()) {
      if (node.metadata?.sourceKind !== "administrative-rule") continue;
      node.metadata.autonomous = true;
      node.metadata.countsTowardStructure = false;
    }
  }
}

function applyDocumentMetadata(graph, text, source) {
  markAppointmentMetadata(graph, text, source);
  markConcurrentOffices(graph, text, source);
  markCommissionComposition(graph, text, source);
  markAnnexMetadata(graph, text, source);
  markDisplayCounts(graph, text, source);
  collectAnnexRequirements(graph, text, source);
  collectTemporaryHeadcounts(graph, text, source);
}

function markDisplayCounts(graph, text, source) {
  const escaped = [...graph.nodes.values()]
    .map((node) => node.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  if (!escaped) return;
  const headcountPattern = new RegExp(`(?:${escaped})\\s*<\\s*([\\d,]+)\\s*>`, "g");
  for (const match of text.matchAll(headcountPattern)) {
    const full = match[0].replace(/\s*<.*$/, "").trim();
    const node = graph.nodeByName(full);
    if (node) {
      node.metadata.headcount = Number(match[1].replaceAll(",", ""));
      node.sources = uniq([...node.sources, source]);
    }
  }
  const institutionCountPattern = new RegExp(`(?:${escaped})\\s*\\(\\s*(\\d+)\\s*(?:개|관|곳)?\\s*\\)`, "g");
  for (const match of text.matchAll(institutionCountPattern)) {
    const full = match[0].replace(/\s*\(.*$/, "").trim();
    const node = graph.nodeByName(full);
    if (node) {
      node.metadata.institutionCount = Number(match[1]);
      node.sources = uniq([...node.sources, source]);
    }
  }
}

function markAppointmentMetadata(graph, text, source) {
  for (const node of graph.nodes.values()) {
    if (node.kind === "institution") continue;
    const escapedNames = [node.name, `${node.name}장`]
      .filter((name, index, array) => name && array.indexOf(name) === index)
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|");
    const pattern = new RegExp(
      `(?:${escapedNames})(?:은|는)\\s+([^.。\\n]{0,260}?보(?:한다|하고|하되)[^.。\\n]*)`,
      "g",
    );
    for (const match of text.matchAll(pattern)) {
      const clause = match[1];
      const grade = clause.match(/직무등급은\s*([가-라])등급/)?.[1];
      if (grade) node.metadata.grade = grade;
      if (/고위공무원단에\s+속하는\s+임기제공무원/.test(clause)) {
        node.metadata.employmentType = "임기제";
      } else if (/별정직공무원/.test(clause)) {
        node.metadata.employmentType = "별정직";
      } else if (/정무직/.test(clause)) {
        node.metadata.employmentType = "정무직";
      }
      const specificRank = clause.match(/(?:은|는)?\s*(소방총감|치안총감|검사총장|소방정감|치안정감)(?:으로|로)\s+보/)?.[1];
      if (specificRank) node.metadata.specificRank = specificRank;
      if (specificRank) applyStaffCategories(node, clause);
      applyAppointmentRange(node, clause);
      if (/상호이체하여\s+배정[ㆍ·]?운영/.test(clause)) {
        node.metadata.crossTransfer = true;
      }
      if (grade || node.metadata.employmentType || specificRank || node.metadata.staffCategories?.length) {
        node.sources = uniq([...node.sources, source]);
      }
    }
    const categoryPattern = new RegExp(
      `(?:${escapedNames})(?:은|는)\\s+([^.。\\n,;]+)`,
      "g",
    );
    for (const match of text.matchAll(categoryPattern)) {
      applyStaffCategories(node, match[1]);
    }
  }

  if (/위원장과\s+부위원장은\s+정무직으로\s+보/.test(text)) {
    for (const name of ["위원장", "부위원장"]) {
      const node = graph.nodeByName(name);
      if (node) node.metadata.employmentType = "정무직";
    }
  }

  // "각 과장은 …으로 보한다"처럼 개별 과명이 반복되지 않는 보직 조문도 적용한다.
  for (const match of text.matchAll(/각\s*(과장|팀장|담당관|국장|실장)은?\s+([^.。\n]{0,260}?보(?:한다|하고|하되)[^.。\n]*)/g)) {
    const suffix = match[1].replace(/장$/, "");
    for (const node of graph.nodes.values()) {
      if (!node.name.endsWith(suffix)) continue;
      applyStaffCategories(node, match[2]);
      applyAppointmentRange(node, match[2]);
      if (/상호이체하여\s+배정[ㆍ·]?운영/.test(match[2])) node.metadata.crossTransfer = true;
      node.sources = uniq([...node.sources, source]);
    }
  }

  collectAppointmentExceptions(graph, text, source);
}

function applyStaffCategories(node, clause) {
  const categories = new Set(node.metadata.staffCategories || []);
  if (/일반직/.test(clause)) categories.add("일반직");
  if (/(?:연구직|연구관|연구사)/.test(clause)) categories.add("연구직");
  if (/(?:지도직|지도관|지도사)/.test(clause)) categories.add("지도직");
  if (/전문직(?:공무원|으로|인\s*경우|인\s*직위)/.test(clause)) categories.add("전문직");
  if (/전문경력관/.test(clause)) categories.add("전문경력관");
  if (/임기제/.test(clause)) categories.add("임기제");
  if (/별정직/.test(clause)) categories.add("별정직");
  if (/특정직/.test(clause) || node.metadata.specificRank) categories.add("특정직");
  if (categories.size) node.metadata.staffCategories = [...categories];
}

const APPOINTMENT_LEVELS = [
  ["부이사관", 3],
  ["서기관", 4],
  ["기술서기관", 4],
  ["과학기술서기관", 4],
  ["소방준감", 4],
  ["소방정", 4],
  ["치안감", 4],
  ["치안정감", 3],
  ["사무관", 5],
  ["소방령", 5],
  ["세무주사", 6],
  ["주사", 6],
];

function applyAppointmentRange(node, clause) {
  const levels = uniq(
    APPOINTMENT_LEVELS.filter(([term]) => clause.includes(term)).map(([, level]) => level),
  ).sort((a, b) => a - b);
  if (!levels.length) return;
  node.metadata.appointmentLevels = levels;
  node.metadata.gradeRange = levels.length === 1 ? `${levels[0]}급` : `${levels[0]}.${levels.at(-1)}급`;
  const hasSpecificService = /소방(?:준감|정|령)|치안(?:감|정감)/.test(clause);
  const hasGeneralService = /(?:부이사관|서기관|사무관|주사)/.test(clause);
  if (hasSpecificService && hasGeneralService) node.metadata.mixedAppointment = true;
}

function collectAppointmentExceptions(graph, text, source) {
  const proviso = /다만,?\s+([가-힣A-Za-z0-9ㆍ·\s]+?)의\s+(?:서장|장|과장)은?\s+([^.。\n]{1,220}?보(?:한다|할 수 있다|하고|하되))/g;
  for (const match of text.matchAll(proviso)) {
    const names = parseNameList(match[1]);
    if (!names.length) continue;
    const entry = { names, clause: match[2].trim(), source };
    graph.meta.appointmentExceptions ||= [];
    if (!graph.meta.appointmentExceptions.some((item) => item.names.join("|") === names.join("|") && item.clause === entry.clause)) {
      graph.meta.appointmentExceptions.push(entry);
    }
    for (const name of names) {
      const node = graph.nodeByName(name);
      if (!node) continue;
      node.metadata.appointmentException = true;
      applyAppointmentRange(node, match[2]);
      node.sources = uniq([...node.sources, source]);
    }
  }
}

function markConcurrentOffices(graph, text, source) {
  const pattern =
    /([가-힣A-Za-z0-9]+장)\s*1명을\s*두되,\s*([가-힣A-Za-z0-9]+)\s*1명이\s*겸직한다/g;
  for (const match of text.matchAll(pattern)) {
    const office = graph.addNode(match[1], { source });
    const concurrentWith = normalizeNodeName(match[2]) || match[2];
    if (!office) continue;
    office.metadata.concurrentWith = concurrentWith;
    office.metadata.concurrentOffice = true;
  }
}

function markCommissionComposition(graph, text, source) {
  const pattern =
    /위원회는\s+위원장\s*1명과\s+부위원장\s*1명을\s+포함한\s+(\d+)명의\s+위원으로\s+구성하며,\s*그\s+중\s+(\d+)명은\s+비상임위원으로\s+한다/g;
  for (const match of text.matchAll(pattern)) {
    const total = Number(match[1]);
    const nonStanding = Number(match[2]);
    const standing = Math.max(0, total - 2 - nonStanding);
    graph.meta.commissionComposition = {
      total,
      chair: 1,
      viceChair: 1,
      standing,
      nonStanding,
      source,
    };
    const standingNode = graph.addNode("상임위원", {
      kind: "advisor",
      source,
      metadata: { count: standing },
    });
    const nonStandingNode = graph.addNode("비상임위원", {
      kind: "advisor",
      source,
      metadata: { count: nonStanding },
    });
    const head = graph.findHead();
    if (head && standingNode) graph.addEdge(head.id, standingNode.id, { type: "advisor", source });
    if (head && nonStandingNode) graph.addEdge(head.id, nonStandingNode.id, { type: "advisor", source });
  }
}

function markAnnexMetadata(graph, text, source) {
  const evaluationIndex = text.lastIndexOf("평가대상 조직");
  if (evaluationIndex >= 0) {
    const evaluationSection = text.slice(evaluationIndex);
    for (const node of graph.nodes.values()) {
      if (node.kind === "institution" || node.name.length < 2) continue;
      if (evaluationSection.includes(node.name)) {
        node.metadata.evaluation = true;
        node.sources = uniq([...node.sources, source]);
      }
    }
  }
}

function collectAnnexRequirements(graph, text, source) {
  const requirements = [
    {
      type: "organization-matrix",
      regex: /각\s*(?:세무서|기관|관서)에\s+두는\s+(?:과|부서|담당관)[^.。\n]{0,180}?별표\s*(\d+(?:의\d+)?)/g,
      description: "기관별 실제 하부조직 편성은 별표 매트릭스를 읽어야 확정됩니다",
    },
    {
      type: "jurisdiction",
      regex: /(?:관할구역|위치|등급구분)[^.。\n]{0,180}?별표\s*(\d+(?:의\d+)?)/g,
      description: "관할·등급은 별표를 읽어야 확정됩니다",
    },
    {
      type: "headcount",
      regex: /직급별\s+정원[^.。\n]{0,180}?별표\s*(\d+(?:의\d+)?)/g,
      description: "직급별 정원 집계는 별표를 읽어야 확정됩니다",
    },
  ];
  for (const requirement of requirements) {
    for (const match of text.matchAll(requirement.regex)) {
      const entry = {
        type: requirement.type,
        annex: `별표 ${match[1]}`,
        description: requirement.description,
        source,
      };
      graph.meta.annexRequirements ||= [];
      if (!graph.meta.annexRequirements.some((item) => item.type === entry.type && item.annex === entry.annex && item.source === entry.source)) {
        graph.meta.annexRequirements.push(entry);
      }
    }
  }
}

function collectTemporaryHeadcounts(graph, text, source) {
  const pattern =
    /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일까지\s+[^.。\n]{0,260}?한시정원을\s+([가-힣A-Za-z0-9]+)에\s+둔다/g;
  for (const match of text.matchAll(pattern)) {
    const expires = `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
    const entry = {
      target: normalizeNodeName(match[4]) || match[4],
      expires,
      source,
    };
    graph.meta.temporaryHeadcounts ||= [];
    if (!graph.meta.temporaryHeadcounts.some((item) => item.target === entry.target && item.expires === expires)) {
      graph.meta.temporaryHeadcounts.push(entry);
    }
  }
}

export function parseNameList(value) {
  let text = String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/「[^」]+」/g, " ")
    .replace(/제\d+조(?:의\d+)?(?:제\d+항)?에\s+따른/g, " ")
    .replace(/(?:보조기관|보좌기관)\s*중/g, " ")
    .replace(/\s+(?:및|그리고)\s+/g, "ㆍ")
    .replace(
      /([가-힣A-Za-z0-9]+(?:사무국|사무소|위원회|박물관|미술관|도서관|극장|전당|세무서|소방서|연구원|기록원|관리원|교육원|개발원|본부|센터|분원|지소|실|국|과|팀|관|원|소|부|처|청|단))와\s+(?=[가-힣A-Za-z0-9])/g,
      "$1ㆍ",
    )
    .replace(/[,，·]/g, "ㆍ");
  const parts = text
      .split("ㆍ")
      .map((part) => part.replace(/^(?:그\s+밖에|해당|각|각각|하에)\s+/, "").trim())
      .map((part) => part.replace(/\s*(?:각\s*)?\d+\s*명.*$/, "").trim())
      .map((part) => part.replace(/\s*(?:으로|로)\s*하(?:며|고|되).*$/, "").trim())
      .map(normalizeNodeName);
  return uniq(expandSharedSuffix(parts).filter(isPlausibleNode));
}

function isPlausibleNode(name) {
  if (!name || GENERIC_NAMES.has(name)) return false;
  if (
    name.length > 30 ||
    /\s/.test(name) ||
    /(?:정하는|사항|업무|범위|정원|공무원|직무등급|법률|대통령령|총리령|부령|밑에|보좌하는|두는|각각|관한\s*통칙)/.test(name)
  ) return false;
  return (
    STRUCTURAL_SUFFIX.test(name) ||
    /^(?:장관|차관|차장|위원장|부위원장|대변인|부대변인|상임위원|비상임위원|이북5도)$/.test(
      name,
    )
  );
}

function expandSharedSuffix(parts) {
  const locations = new Set([
    "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
    "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
  ]);
  const last = parts.at(-1) || "";
  const lastLocation = [...locations].find((location) => last.startsWith(location));
  if (!lastLocation) return parts;
  const suffix = last.slice(lastLocation.length);
  if (!STRUCTURAL_SUFFIX.test(suffix)) return parts;
  return parts.map((part, index) => {
    if (index === parts.length - 1) return part;
    return locations.has(part) ? `${part}${suffix}` : part;
  });
}

function resolveHolderName(holder, contextName) {
  const clean = String(holder ?? "").trim();
  if (/^(?:장관|차관|차장|위원장|부위원장|대변인|부대변인|상임위원)$/.test(clean)) return clean;
  if (/장관$/.test(clean)) return clean.slice(0, -"장관".length);
  if (/위원회위원장$/.test(clean)) return clean.slice(0, -"위원장".length);
  const normalized = normalizeNodeName(clean);
  if (normalized) return normalized;
  return contextName || "";
}

function sentenceAt(text, index) {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("。", index), text.lastIndexOf("\n", index));
  const dot = text.indexOf(".", index);
  const fullStop = text.indexOf("。", index);
  const newline = text.indexOf("\n", index);
  const ends = [dot, fullStop, newline].filter((value) => value >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start + 1, end);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAmendmentNotes(value) {
  return String(value)
    .replace(/<\s*(?:개정|신설|전문개정|제목개정|삭제)[^>]*>/g, " ")
    .replace(/\[[^\]]*(?:개정|신설)[^\]]*\]/g, " ");
}

function inferInstitution(text) {
  const directive = text.match(/^@기관\s*:\s*(.+)$/m)?.[1]?.trim();
  if (directive) return directive;
  const title = text.match(
    /([가-힣A-Za-z0-9]+?)(?:와|과)\s+그\s+소속기관\s+직제(?:\s+시행규칙)?/,
  )?.[1];
  if (title) return title;
  const purpose = text.match(/이\s+(?:영|규칙)은\s+([가-힣A-Za-z0-9]+?)(?:와|과)\s+그\s+소속기관/);
  return purpose?.[1] || null;
}

function parseDirectives(text) {
  const result = { relations: [], kinds: [], jurisdictions: [], changes: [] };
  for (const line of String(text).split(/\r?\n/)) {
    let match;
    if ((match = line.match(/^@기관\s*:\s*(.+)$/))) result.institution = match[1].trim();
    else if ((match = line.match(/^@기관장\s*:\s*(.+)$/))) result.head = match[1].trim();
    else if ((match = line.match(/^@부기관장\s*:\s*(.+)$/))) result.deputy = match[1].trim();
    else if ((match = line.match(/^@기준일\s*:\s*(.+)$/))) result.asOf = match[1].trim();
    else if ((match = line.match(/^@관계\s*:\s*(.+?)\s*>\s*(.+?)(?:\s*\[(.+?)\])?\s*$/))) {
      result.relations.push({ parent: match[1].trim(), child: match[2].trim(), type: directiveType(match[3]) });
    } else if ((match = line.match(/^@소관\s*:\s*(.+?)\s*>\s*(.+?)(?:\s*\[(.+?)\])?\s*$/))) {
      result.jurisdictions.push({
        parent: match[1].trim(),
        children: parseNameList(match[2]),
        source: match[3]?.trim() || "사용자 소관 지정",
      });
    } else if ((match = line.match(/^@유형\s*:\s*(.+?)\s*=\s*(.+)$/))) {
      result.kinds.push({ name: match[1].trim(), kind: directiveKind(match[2]) });
    } else if ((match = line.match(/^@변경\s*:\s*(.+?)\s*=\s*(신설|폐지|명칭변경|이체|상계신설)$/))) {
      result.changes.push({ name: match[1].trim(), change: match[2].trim() });
    }
  }
  return result;
}

function applyDirectives(graph, directives) {
  for (const item of directives.kinds || []) {
    graph.addNode(item.name, { kind: item.kind, source: "사용자 지시문" });
  }
  for (const item of directives.changes || []) {
    const node = graph.addNode(item.name, { source: "사용자 지시문" });
    if (node) node.metadata.change = item.change;
  }
  for (const relation of directives.relations || []) {
    const parent = graph.addNode(relation.parent, { source: "사용자 지시문" });
    const child = graph.addNode(relation.child, {
      kind: relation.type === "advisor" ? "advisor" : relation.type === "affiliated" ? "affiliated" : undefined,
      source: "사용자 지시문",
    });
    if (parent && child) graph.addEdge(parent.id, child.id, { type: relation.type, source: "사용자 지시문" });
  }
  for (const relation of directives.jurisdictions || []) {
    for (const childName of relation.children) {
      setJurisdictionRelation(graph, relation.parent, childName, {
        source: relation.source,
        evidence: "declared",
        legalBasis: "@소관",
      });
    }
  }
}

function directiveType(value) {
  if (/보좌/.test(value || "")) return "advisor";
  if (/소속/.test(value || "")) return "affiliated";
  if (/한시/.test(value || "")) return "temporary";
  return "assistant";
}

function directiveKind(value) {
  if (/기관장/.test(value)) return "head";
  if (/부기관장/.test(value)) return "deputy";
  if (/보좌/.test(value)) return "advisor";
  if (/소속/.test(value)) return "affiliated";
  if (/한시/.test(value)) return "temporary";
  return "assistant";
}
