import { OrgGraph } from "./model.mjs";
import {
  dutyFunctionSimilarity,
  dutyFunctionTokens,
  isResidualDuty,
  normalizeDutyFunctionText,
} from "./legal-duty.mjs";
import { stableId } from "./utils-core.mjs";

export const DUTY_LINEAGE_SCHEMA = "kr.go.mois.orgchart.duty-lineage/v1";

function articleContextOf(article) {
  const match = String(article || "").match(/\(([^)]+)\)/);
  return match ? match[1].trim() : "";
}

export function listDepartmentDutyFunctions(graphLike) {
  const graph = asGraph(graphLike);
  // 동명이과 분리: 같은 과명이 서로 다른 조문 괄호(실·소속기관) 아래에
  // 등장하면 별도 정체성으로 매칭한다. 표시·링크용 원명(department)은 유지.
  const contextsByName = new Map();
  for (const entry of graph.meta?.departmentDutyCatalog || []) {
    const name = String(entry?.department || "").trim();
    if (!name) continue;
    if (!contextsByName.has(name)) contextsByName.set(name, new Set());
    contextsByName.get(name).add(articleContextOf(entry.article));
  }
  const collidingNames = new Set(
    [...contextsByName.entries()].filter(([, set]) => set.size >= 2).map(([name]) => name),
  );
  const byDepartment = new Map();
  for (const entry of graph.meta?.departmentDutyCatalog || []) {
    const department = String(entry?.department || "").trim();
    if (!department) continue;
    const context = articleContextOf(entry.article);
    const identity = collidingNames.has(department) && context && context !== department
      ? `${department}(${context})`
      : department;
    const current = byDepartment.get(identity) || {
      department,
      identity,
      context,
      parent: parentNameFor(graph, department),
      articles: [],
      sources: [],
      functions: [],
    };
    if (entry.article && !current.articles.includes(entry.article)) current.articles.push(entry.article);
    if (entry.source && !current.sources.includes(entry.source)) current.sources.push(entry.source);
    for (const item of entry.items || []) {
      const text = String(item?.text || "").trim();
      if (!text) continue;
      const number = item.subparagraph || item.number;
      const citation = item.citation || synthesizeCitation(entry, number);
      const normalizedText = item.normalizedText || normalizeDutyFunctionText(text);
      current.functions.push({
        id: stableId([department, citation, normalizedText].join("|")),
        department,
        parent: current.parent,
        number,
        citation,
        text,
        normalizedText,
        tokens: dutyFunctionTokens(text),
        source: item.source || entry.source || "",
        article: item.article || entry.article || null,
        paragraph: item.paragraph ?? entry.paragraph ?? null,
        residual: Boolean(item.residual || isResidualDuty(text)),
        deleted: Boolean(item.deleted || /^삭제/u.test(text)),
      });
    }
    byDepartment.set(identity, current);
  }
  return [...byDepartment.values()]
    .map((entry) => ({
      ...entry,
      functions: uniqueFunctions(entry.functions),
    }))
    .sort((left, right) => left.department.localeCompare(right.department, "ko"));
}

export function compareDepartmentDutyFunctions(beforeGraphLike, afterGraphLike, options = {}) {
  const beforeGraph = asGraph(beforeGraphLike);
  const afterGraph = asGraph(afterGraphLike);
  const beforeDepartments = listDepartmentDutyFunctions(beforeGraph);
  const afterDepartments = listDepartmentDutyFunctions(afterGraph);
  const afterFunctionIndex = buildFunctionIndex(afterDepartments);
  const matches = [];
  const rejected = [];

  for (const before of beforeDepartments) {
    for (const beforeFunction of usableFunctions(before.functions)) {
      const result = matchDutyFunction(beforeFunction, before, afterFunctionIndex);
      if (!result) continue;
      const record = {
        before: functionEvidence(beforeFunction),
        after: functionEvidence(result.afterFunction),
        from: before.department,
        to: result.afterDepartment.department,
        fromIdentity: identityOf(before),
        toIdentity: identityOf(result.afterDepartment),
        fromContext: before.context || "",
        toContext: result.afterDepartment.context || "",
        sameDepartment: Boolean(result.sameDepartment),
        score: result.score,
        margin: result.margin,
        match: result.match,
        accepted: result.accepted,
      };
      (result.accepted ? matches : rejected).push(record);
    }
  }

  const links = aggregateDepartmentLinks(beforeDepartments, afterDepartments, matches, {
    minimumCoverage: options.minimumCoverage,
  });
  const acceptedKeys = new Set(links.filter((link) => link.accepted).map((link) => `${link.from}>${link.to}`));
  const reviews = aggregateReviewLinks(beforeDepartments, afterDepartments, rejected, acceptedKeys);
  const matchedBeforeIds = new Set(matches.map((match) => match.before.id));
  const matchedAfterIds = new Set(matches.map((match) => match.after.id));
  const allBeforeFunctions = beforeDepartments.flatMap((entry) => usableFunctions(entry.functions));
  const allAfterFunctions = afterDepartments.flatMap((entry) => usableFunctions(entry.functions));
  const acceptedLinks = links.filter((link) => link.accepted);

  const beforeSummary = sourceSummary(beforeGraph, beforeDepartments, allBeforeFunctions);
  const afterSummary = sourceSummary(afterGraph, afterDepartments, allAfterFunctions);
  return {
    schema: DUTY_LINEAGE_SCHEMA,
    before: beforeSummary,
    after: afterSummary,
    automaticEligible: beforeSummary.evidenceQuality === "structured-law-text"
      && afterSummary.evidenceQuality === "structured-law-text",
    links: acceptedLinks,
    reviews: [
      ...links.filter((link) => !link.accepted),
      ...reviews,
    ].sort(compareLinks),
    functionMatches: matches,
    rejectedFunctionMatches: rejected,
    unmatchedBefore: allBeforeFunctions
      .filter((item) => !matchedBeforeIds.has(item.id))
      .map(functionEvidence),
    unmatchedAfter: allAfterFunctions
      .filter((item) => !matchedAfterIds.has(item.id))
      .map(functionEvidence),
    stats: {
      beforeDepartments: beforeDepartments.length,
      afterDepartments: afterDepartments.length,
      beforeFunctions: allBeforeFunctions.length,
      afterFunctions: allAfterFunctions.length,
      acceptedFunctionMatches: matches.length,
      acceptedDepartmentLinks: acceptedLinks.length,
      reviewDepartmentLinks: links.filter((link) => !link.accepted).length + reviews.length,
      unmatchedBeforeFunctions: allBeforeFunctions.length - matchedBeforeIds.size,
      unmatchedAfterFunctions: allAfterFunctions.length - matchedAfterIds.size,
    },
  };
}

function buildFunctionIndex(departments) {
  const functions = departments.flatMap((department) => (
    usableFunctions(department.functions).map((item) => ({ item, department }))
  ));
  const exact = new Map();
  const token = new Map();
  for (const entry of functions) {
    if (entry.item.normalizedText) {
      if (!exact.has(entry.item.normalizedText)) exact.set(entry.item.normalizedText, []);
      exact.get(entry.item.normalizedText).push(entry);
    }
    for (const value of entry.item.tokens || []) {
      if (!token.has(value)) token.set(value, []);
      token.get(value).push(entry);
    }
  }
  return { functions, exact, token };
}

function matchDutyFunction(beforeFunction, beforeDepartment, index) {
  const exact = index.exact.get(beforeFunction.normalizedText) || [];
  if (exact.length) {
    const byDepartment = bestByDepartment(exact.map((entry) => ({ ...entry, score: 1 })));
    const preferred = byDepartment.find((entry) => sameDepartmentIdentity(entry.department, beforeDepartment))
      || uniqueTopDepartment(byDepartment, 0.03);
    if (preferred) {
      const sameIdentity = sameDepartmentIdentity(preferred.department, beforeDepartment);
      return {
        afterFunction: preferred.item,
        afterDepartment: preferred.department,
        score: 1,
        margin: sameIdentity ? 1 : topMargin(byDepartment),
        match: "exact-text",
        accepted: sameIdentity || topMargin(byDepartment) >= 0.03,
        sameDepartment: sameIdentity,
      };
    }
  }

  const candidates = candidateFunctions(beforeFunction, index);
  if (!candidates.length) return null;
  const scored = bestByDepartment(candidates.map((entry) => ({
    ...entry,
    score: dutyFunctionSimilarity(beforeFunction.text, entry.item.text),
  })).filter((entry) => entry.score >= 0.48));
  if (!scored.length) return null;
  scored.sort((left, right) => {
    const leftRank = rankedFunctionScore(beforeDepartment, left);
    const rightRank = rankedFunctionScore(beforeDepartment, right);
    return rightRank - leftRank || right.score - left.score;
  });
  const best = scored[0];
  const second = scored.find((entry) => identityOf(entry.department) !== identityOf(best.department));
  const margin = roundScore(best.score - (second?.score || 0));
  const sameDepartment = sameDepartmentIdentity(beforeDepartment, best.department);
  // 동명이과 패널티: 원명이 같아도 소속기관 정체성이 다르면 이름 일치를
  // 근거로 승계를 수용하지 않는다(문언 유사도 사다리로만 판정).
  const homonymPenalty = !sameDepartment
    && beforeDepartment.department === best.department.department ? 0.5 : 1;
  const nameScore = departmentNameSimilarity(beforeDepartment.department, best.department.department)
    * homonymPenalty;
  // 동명이과(원명 같고 정체성 다름) 간 승계는 준-완전일치 문언일 때만 인정한다.
  const homonym = homonymPenalty < 1;
  const accepted = Boolean(
    (sameDepartment && best.score >= 0.60)
    || (homonym
      ? (best.score >= 0.92 && margin >= 0.02)
      : (
        (best.score >= 0.92 && margin >= 0.02)
        || (best.score >= 0.80 && margin >= 0.07)
        || (best.score >= 0.72 && margin >= 0.12)
        || (nameScore >= 0.72 && best.score >= 0.62 && margin >= 0.04)
      ))
  );
  return {
    afterFunction: best.item,
    afterDepartment: best.department,
    score: best.score,
    margin,
    match: sameDepartment ? "same-department-text" : "duty-text",
    accepted,
    sameDepartment,
  };
}

function candidateFunctions(beforeFunction, index) {
  const candidates = new Map();
  for (const token of beforeFunction.tokens || []) {
    for (const entry of index.token.get(token) || []) candidates.set(entry.item.id, entry);
  }
  if (candidates.size) return [...candidates.values()];
  const normalized = beforeFunction.normalizedText;
  if (!normalized || normalized.length < 8) return [];
  const prefix = normalized.slice(0, 4);
  return index.functions.filter((entry) => entry.item.normalizedText.includes(prefix));
}

function aggregateDepartmentLinks(beforeDepartments, afterDepartments, matches, options = {}) {
  const afterByName = new Map(afterDepartments.map((entry) => [entry.department, entry]));
  const matchesBySource = groupBy(matches, (match) => match.fromIdentity || match.from);
  const links = [];
  for (const before of beforeDepartments) {
    const functions = usableFunctions(before.functions);
    const sourceMatches = matchesBySource.get(identityOf(before)) || [];
    const byDestination = groupBy(sourceMatches, (match) => match.to);
    for (const [destination, destinationMatches] of byDestination) {
      const after = afterByName.get(destination);
      if (!after) continue;
      const matchedCount = new Set(destinationMatches.map((match) => match.before.id)).size;
      const coverage = functions.length ? matchedCount / functions.length : 0;
      const averageScore = destinationMatches.reduce((sum, match) => sum + match.score, 0)
        / Math.max(destinationMatches.length, 1);
      const nameScore = departmentNameSimilarity(before.department, destination);
      const sameDepartment = before.department === destination;
      const minimumCoverage = Number.isFinite(options.minimumCoverage) ? options.minimumCoverage : 0.18;
      const accepted = Boolean(
        sameDepartment
        || (matchedCount >= 2 && coverage >= minimumCoverage && averageScore >= 0.70)
        || (matchedCount >= 1 && coverage >= 0.10 && averageScore >= 0.88 && nameScore >= 0.38)
        || (matchedCount >= 1 && nameScore >= 0.72 && averageScore >= 0.64)
      );
      const evidence = destinationMatches
        .sort((left, right) => right.score - left.score)
        .slice(0, 12)
        .map((match) => ({
          beforeCitation: match.before.citation,
          afterCitation: match.after.citation,
          beforeText: match.before.text,
          afterText: match.after.text,
          score: match.score,
          match: match.match,
        }));
      links.push({
        id: stableId(`${before.department}>${destination}`),
        from: before.department,
        to: destination,
        fromParent: before.parent,
        toParent: after.parent,
        basis: "duty-function",
        accepted,
        confidence: roundScore(averageScore * Math.min(1, 0.58 + coverage)),
        coverage: roundScore(coverage),
        sharePercent: Math.round(coverage * 100),
        matchedFunctions: matchedCount,
        sourceFunctions: functions.length,
        destinationFunctions: usableFunctions(after.functions).length,
        nameScore: roundScore(nameScore),
        evidence,
        reason: accepted
          ? "각 호 분장사무의 고유 문언이 다음 조직으로 승계됨"
          : "기능 유사성은 있으나 자동 점선 기준에 미달",
      });
    }
  }
  return mergeDuplicateLinks(links).sort(compareLinks);
}

// 동명이과 분리로 같은 원명 쌍(from>to)의 링크가 둘 이상 생기면 작도용으로 병합한다.
function mergeDuplicateLinks(links) {
  const byPair = new Map();
  for (const link of links) {
    const key = `${link.from}>${link.to}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { ...link });
      continue;
    }
    existing.matchedFunctions += link.matchedFunctions;
    existing.sourceFunctions += link.sourceFunctions;
    existing.destinationFunctions = Math.max(existing.destinationFunctions, link.destinationFunctions);
    existing.coverage = roundScore(existing.sourceFunctions
      ? existing.matchedFunctions / existing.sourceFunctions
      : 0);
    existing.sharePercent = Math.round(existing.coverage * 100);
    existing.confidence = Math.max(existing.confidence, link.confidence);
    existing.accepted = existing.accepted || link.accepted;
    existing.evidence = [...existing.evidence, ...link.evidence]
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);
  }
  return [...byPair.values()];
}

function aggregateReviewLinks(beforeDepartments, afterDepartments, rejected, acceptedKeys) {
  const beforeByName = new Map(beforeDepartments.map((entry) => [entry.department, entry]));
  const afterByName = new Map(afterDepartments.map((entry) => [entry.department, entry]));
  const groups = groupBy(rejected.filter((match) => !acceptedKeys.has(`${match.from}>${match.to}`)), (match) => `${match.from}>${match.to}`);
  const reviews = [];
  for (const [key, entries] of groups) {
    if (!entries.length) continue;
    const [from, to] = key.split(">");
    const before = beforeByName.get(from);
    const after = afterByName.get(to);
    const peak = Math.max(...entries.map((entry) => entry.score));
    if (peak < 0.62) continue;
    reviews.push({
      id: stableId(`review:${key}`),
      from,
      to,
      fromParent: before?.parent || null,
      toParent: after?.parent || null,
      basis: "duty-function-review",
      accepted: false,
      confidence: roundScore(peak),
      coverage: 0,
      sharePercent: 0,
      matchedFunctions: 0,
      sourceFunctions: usableFunctions(before?.functions || []).length,
      destinationFunctions: usableFunctions(after?.functions || []).length,
      evidence: entries.sort((left, right) => right.score - left.score).slice(0, 5).map((entry) => ({
        beforeCitation: entry.before.citation,
        afterCitation: entry.after.citation,
        beforeText: entry.before.text,
        afterText: entry.after.text,
        score: entry.score,
      })),
      reason: "유사 기능 후보가 둘 이상이거나 점수 차가 작아 사람 확인 필요",
    });
  }
  return reviews;
}

const identityOf = (group) => group.identity || group.department;

// 스냅샷별 충돌 상태가 달라도 안전한 동일부서 판정:
// 원명이 같고, 양쪽 모두 컨텍스트가 붙어 있으면서 서로 다를 때만 다른 부서로 본다.
function sameDepartmentIdentity(a, b) {
  if (!a || !b) return false;
  if (a.department !== b.department) return false;
  const contextA = String(a.context || "");
  const contextB = String(b.context || "");
  return !contextA || !contextB || contextA === contextB;
}

function bestByDepartment(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = entry.department.identity || entry.department.department;
    const existing = map.get(key);
    if (!existing || entry.score > existing.score) map.set(key, entry);
  }
  return [...map.values()].sort((left, right) => right.score - left.score);
}

function uniqueTopDepartment(entries, minimumMargin) {
  if (!entries.length) return null;
  const margin = topMargin(entries);
  return entries.length === 1 || margin >= minimumMargin ? entries[0] : null;
}

function topMargin(entries) {
  const sorted = [...entries].sort((left, right) => right.score - left.score);
  return roundScore((sorted[0]?.score || 0) - (sorted[1]?.score || 0));
}

function rankedFunctionScore(beforeDepartment, entry) {
  const same = sameDepartmentIdentity(beforeDepartment, entry.department) ? 0.08 : 0;
  const name = departmentNameSimilarity(beforeDepartment.department, entry.department.department) * 0.025;
  const parent = beforeDepartment.parent && beforeDepartment.parent === entry.department.parent ? 0.015 : 0;
  return entry.score + same + name + parent;
}

function departmentNameSimilarity(left, right) {
  const a = normalizeDepartmentName(left);
  const b = normalizeDepartmentName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return diceSet(characterNgrams(a, 2), characterNgrams(b, 2));
}

function normalizeDepartmentName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[·ㆍ()[\]]/g, "")
    .replace(/(?:담당관|정책관|기획관|관리관|과|팀)$/g, "");
}

function sourceSummary(graph, departments, functions) {
  return {
    institution: graph.meta?.institution || "",
    asOf: graph.meta?.asOf || null,
    departments: departments.length,
    functions: functions.length,
    evidenceQuality: graph.meta?.dutyEvidenceQuality
      || (/legal-duty-v2/u.test(String(graph.meta?.parserVersion || ""))
        ? "structured-law-text"
        : "legacy-unknown"),
  };
}

function functionEvidence(item) {
  return {
    id: item.id,
    department: item.department,
    parent: item.parent,
    number: item.number,
    citation: item.citation,
    text: item.text,
    source: item.source,
  };
}

function usableFunctions(functions) {
  return (functions || []).filter((item) => (
    item?.text
    && item.normalizedText
    && !item.residual
    && !item.deleted
    && item.normalizedText.length >= 2
  ));
}

function uniqueFunctions(functions) {
  const seen = new Set();
  const result = [];
  for (const item of functions || []) {
    const key = `${item.citation || ""}|${item.normalizedText || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function synthesizeCitation(entry, number) {
  const article = entry?.article || "조문 미상";
  const paragraph = entry?.paragraph ? `제${entry.paragraph}항` : "";
  const subparagraph = number != null && number !== "" ? `제${number}호` : "";
  return `${article}${paragraph}${subparagraph}`;
}

function parentNameFor(graph, departmentName) {
  const node = graph.nodeByName?.(departmentName)
    || [...graph.nodes.values()].find((item) => item.name === departmentName);
  if (!node) return null;
  if (node.metadata?.jurisdiction?.parent) return node.metadata.jurisdiction.parent;
  const parents = graph.parentsOf?.(node.id) || [];
  const preferred = parents.find(({ edge, node: parent }) => (
    parent
    && parent.kind !== "institution"
    && ["jurisdiction", "assistant", "advisor", "structural", "temporary"].includes(edge.type)
  ));
  return preferred?.node?.name || null;
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values || []) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function characterNgrams(value, size) {
  const result = new Set();
  if (value.length < size) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index <= value.length - size; index += 1) result.add(value.slice(index, index + size));
  return result;
}

function diceSet(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function compareLinks(left, right) {
  return Number(right.accepted) - Number(left.accepted)
    || right.confidence - left.confidence
    || left.from.localeCompare(right.from, "ko")
    || left.to.localeCompare(right.to, "ko");
}

function roundScore(value) {
  return Number(Number(value || 0).toFixed(3));
}

function asGraph(value) {
  if (value?.nodes instanceof Map) return value;
  return OrgGraph.fromJSON(value);
}
