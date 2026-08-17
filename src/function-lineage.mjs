import { OrgGraph } from "./model.mjs";
import { compareDepartmentDutyFunctions } from "./duty-lineage.mjs";
import { dutyFunctionSimilarity, isResidualDuty, normalizeDutyFunctionText } from "./legal-duty.mjs";

export const FUNCTION_LINEAGE_SCHEMA = "kr.go.mois.orgchart.function-lineage/v1";

export const LINEAGE_VERDICTS = Object.freeze([
  "유지",
  "문언변경",
  "이관",
  "통합",
  "분할",
  "폐지후보",
  "신설후보",
]);

function asGraph(graphLike) {
  return graphLike instanceof OrgGraph ? graphLike : OrgGraph.fromJSON(graphLike);
}

/**
 * Two-pass (forward + backward) duty matching, then per-function verdicts.
 * Verdicts follow reorganization practice vocabulary:
 *   유지(동일 부서·동일 문언) / 문언변경(동일 부서·문언 수정) / 이관(타 부서로 이동)
 *   통합(여러 사무가 한 사무로 합류) / 분할(한 사무가 여러 사무로 갈라짐)
 *   폐지후보(사후 어디에도 매칭 없음) / 신설후보(사전 어디에도 기원 없음)
 */
export function buildFunctionLineage(beforeGraphLike, afterGraphLike, options = {}) {
  const beforeGraph = asGraph(beforeGraphLike);
  const afterGraph = asGraph(afterGraphLike);
  const forward = compareDepartmentDutyFunctions(beforeGraph, afterGraph, options);
  const backward = compareDepartmentDutyFunctions(afterGraph, beforeGraph, options);

  const beforeFunctionsEarly = collectFunctions(forward, "before");
  const afterFunctionsEarly = collectFunctions(forward, "after", backward);
  // 동명이과(서로 다른 소속기관의 같은 과명) 뭉개짐 보정: 완전 일치 매칭이
  // 다른 조문의 동일 문언을 가리키면, 같은 인용처(citation)의 자기 자신으로 재조준한다.
  retargetSameCitation(forward.functionMatches, afterFunctionsEarly);
  retargetSameCitation(backward.functionMatches, beforeFunctionsEarly);

  const forwardByBefore = new Map(forward.functionMatches.map((match) => [match.before.id, match]));
  const backwardByAfter = new Map(backward.functionMatches.map((match) => [match.before.id, match]));

  // 통합·분할은 '서로 다른 문언'이 실제로 합쳐지거나 갈라진 경우만 인정한다.
  // 동일 문언이 여러 부서·조문에 중복 등재된 경우는 통합이 아니라 중복 사무다.
  const mergeTexts = new Map();
  for (const match of forward.functionMatches) {
    if (!mergeTexts.has(match.after.id)) mergeTexts.set(match.after.id, new Set());
    mergeTexts.get(match.after.id).add(match.before.normalizedText || match.before.text);
  }
  const mergeCounts = new Map([...mergeTexts].map(([id, texts]) => [id, texts.size]));
  const splitTexts = new Map();
  for (const match of backward.functionMatches) {
    if (!splitTexts.has(match.after.id)) splitTexts.set(match.after.id, new Set());
    splitTexts.get(match.after.id).add(match.before.normalizedText || match.before.text);
  }
  const splitCounts = new Map([...splitTexts].map(([id, texts]) => [id, texts.size]));

  const beforeFunctions = beforeFunctionsEarly;
  const afterFunctions = afterFunctionsEarly;

  const entries = [];
  for (const item of beforeFunctions.values()) {
    const direct = forwardByBefore.get(item.id);
    const rescue = direct ? null : rescueFromBackward(item.id, backward.functionMatches);
    const match = direct || rescue;
    if (!match) {
      entries.push(verdictEntry(item, null, "폐지후보", { via: null }));
      continue;
    }
    const from = direct ? match.from : match.to;
    const to = direct ? match.to : match.from;
    const fromIdentity = (direct ? match.fromIdentity : match.toIdentity) || from;
    const toIdentity = (direct ? match.toIdentity : match.fromIdentity) || to;
    const afterEvidence = direct ? match.after : match.before;
    // 동명이과 분리: 매처가 판정한 정체성 기반 동일부서 여부를 그대로 쓴다
    // (스냅샷별 충돌 상태 비대칭에 안전).
    const sameDepartment = typeof match.sameDepartment === "boolean"
      ? match.sameDepartment
      : fromIdentity === toIdentity;
    let verdict;
    if (sameDepartment) verdict = match.score >= 0.999 ? "유지" : "문언변경";
    else verdict = "이관";
    const mergedWith = (mergeCounts.get(afterEvidence.id) || 0) >= 2;
    const splitInto = (splitCounts.get(item.id) || 0) >= 2;
    if (mergedWith) verdict = "통합";
    if (splitInto) verdict = "분할";
    // 동명이과 이동: 부서명은 같지만 정체성이 다른 이관은 검수 표시를 남긴다.
    const suspect = from === to && !sameDepartment;
    const fromContext = (direct ? match.fromContext : match.toContext) || "";
    const toContext = (direct ? match.toContext : match.fromContext) || "";
    // 표시명: 동일 표기 이관(소속만 변경)은 컨텍스트를 붙여 읽히게 한다.
    const fromLabel = suspect && fromContext ? `${from}(${fromContext})` : fromIdentity;
    const toLabel = suspect && toContext ? `${to}(${toContext})` : toIdentity;
    entries.push(verdictEntry(item, afterEvidence, verdict, {
      from: fromLabel,
      to: toLabel,
      score: match.score,
      margin: match.margin,
      match: match.match,
      via: direct ? "forward" : "backward",
      mergedWith,
      splitInto,
      suspect,
    }));
  }

  const matchedAfterIds = new Set();
  for (const entry of entries) if (entry.after?.id) matchedAfterIds.add(entry.after.id);
  const newFunctions = [];
  for (const item of afterFunctions.values()) {
    if (matchedAfterIds.has(item.id)) continue;
    if (backwardByAfter.has(item.id)) continue;
    newFunctions.push({ ...item, verdict: "신설후보" });
  }

  const counts = Object.fromEntries(LINEAGE_VERDICTS.map((verdict) => [verdict, 0]));
  for (const entry of entries) counts[entry.verdict] += 1;
  counts["신설후보"] = newFunctions.length;

  return {
    schema: FUNCTION_LINEAGE_SCHEMA,
    before: forward.before,
    after: forward.after,
    entries,
    newFunctions,
    departmentLinks: forward.links,
    reviews: forward.reviews,
    stats: {
      ...forward.stats,
      verdicts: counts,
      backwardRescues: entries.filter((entry) => entry.via === "backward").length,
      suspectSameNameDepartment: entries.filter((entry) => entry.suspect).length,
    },
  };
}

function articleContext(citation) {
  const match = String(citation || "").match(/\(([^)]+)\)/);
  return match ? match[1] : "";
}

function retargetSameCitation(matches, counterpartFunctions) {
  const byKey = new Map();
  for (const item of counterpartFunctions.values()) {
    const key = [item.department, item.citation, normalizeDutyFunctionText(item.text)].join("|#|");
    if (!byKey.has(key)) byKey.set(key, item);
  }
  for (const match of matches) {
    if (match.score < 0.999) continue;
    if (match.before.citation === match.after.citation) continue;
    const key = [match.to, match.before.citation, normalizeDutyFunctionText(match.before.text)].join("|#|");
    const better = byKey.get(key);
    if (better && better.id !== match.after.id) match.after = { ...better };
  }
}

function rescueFromBackward(beforeId, backwardMatches) {
  let best = null;
  for (const match of backwardMatches) {
    if (match.after.id !== beforeId) continue;
    if (!best || match.score > best.score) best = match;
  }
  return best;
}

function collectFunctions(forwardResult, side, backwardResult = null) {
  const map = new Map();
  const push = (evidence, from) => {
    if (evidence?.id && !map.has(evidence.id)) map.set(evidence.id, { ...evidence, department: from });
  };
  for (const match of forwardResult.functionMatches) {
    if (side === "before") push(match.before, match.from);
    else push(match.after, match.to);
  }
  for (const match of forwardResult.rejectedFunctionMatches) {
    if (side === "before") push(match.before, match.from);
    else push(match.after, match.to);
  }
  const unmatched = side === "before" ? forwardResult.unmatchedBefore : forwardResult.unmatchedAfter;
  for (const item of unmatched) push(item, item.department);
  if (backwardResult && side === "after") {
    for (const match of backwardResult.functionMatches) push(match.before, match.from);
    for (const item of backwardResult.unmatchedBefore) push(item, item.department);
  }
  return map;
}

function verdictEntry(beforeFunction, afterFunction, verdict, extra) {
  return {
    id: beforeFunction.id,
    verdict,
    before: beforeFunction,
    after: afterFunction,
    ...extra,
  };
}

/**
 * Cross-department near-duplicate duties inside a single snapshot.
 * 잔여사무("그 밖에 …")는 제외하고, 3개 부서 이상이 공유하는 문언은
 * 소속기관 공통 서무(관례 서무)로 분리해 실질 중복과 구분한다.
 */
export function findDuplicateDuties(graphLike, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.85;
  const graph = asGraph(graphLike);
  const catalog = [];
  for (const entry of graph.meta?.departmentDutyCatalog || []) {
    for (const item of entry.items || []) {
      const text = String(item?.text || "").trim();
      if (!text || /^삭제/u.test(text)) continue;
      if (isResidualDuty(text)) continue;
      catalog.push({
        department: entry.department,
        citation: item.citation || `${entry.article || ""} 제${item.subparagraph || item.number || "?"}호`,
        text,
        normalizedText: item.normalizedText || normalizeDutyFunctionText(text),
      });
    }
  }
  const holders = new Map();
  for (const item of catalog) {
    if (!holders.has(item.normalizedText)) holders.set(item.normalizedText, new Set());
    holders.get(item.normalizedText).add(item.department);
  }
  const duplicates = [];
  const boilerplate = [];
  for (let i = 0; i < catalog.length; i += 1) {
    for (let j = i + 1; j < catalog.length; j += 1) {
      const left = catalog[i];
      const right = catalog[j];
      if (left.department === right.department) continue;
      const score = dutyFunctionSimilarity(left.text, right.text);
      if (score < threshold) continue;
      const spread = Math.max(
        holders.get(left.normalizedText)?.size || 1,
        holders.get(right.normalizedText)?.size || 1,
      );
      const record = { left, right, score: Math.round(score * 1000) / 1000, spread };
      (spread >= 3 ? boilerplate : duplicates).push(record);
    }
  }
  duplicates.sort((a, b) => b.score - a.score);
  boilerplate.sort((a, b) => b.spread - a.spread || b.score - a.score);
  return { threshold, totalDuties: catalog.length, duplicates, boilerplate };
}
