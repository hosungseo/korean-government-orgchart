import { findAnnex } from "./annex.mjs";
import { buildTraceRows } from "./trace.mjs";

const RELATION_ORDER = ["상부구조", "보조기관", "보좌기관", "운영상 소관", "소속기관", "한시조직"];

/**
 * Turn the parsed graph's provenance into a compact review-facing summary.
 *
 * The legal graph remains the source of truth.  This helper deliberately
 * counts only what is present in the graph and does not infer missing
 * citations; reviewers can open the full trace CSV/audit report for the
 * row-level article and sentence evidence.
 */
export function summarizeEvidence(graph) {
  const sourceInventory = Array.isArray(graph?.meta?.sourceInventory) ? graph.meta.sourceInventory : [];
  const traceRows = buildTraceRows(graph);
  const relationStats = groupRelations(traceRows);
  const citedRows = traceRows.filter((row) => hasEvidence(row));
  const sourceRows = traceRows.filter((row) => row.edgeSource || row.childSource);
  const lawMap = graph?.meta?.lawMap || null;
  const annexRequirements = Array.isArray(graph?.meta?.annexRequirements) ? graph.meta.annexRequirements : [];
  const annexes = Array.isArray(graph?.meta?.annexes) ? graph.meta.annexes : [];
  const annexMissing = annexRequirements.filter(
    (item) => !findAnnex(graph, item.annex, { source: item.source }),
  );
  const jurisdictionRelations = Array.isArray(graph?.meta?.jurisdictionRelations)
    ? graph.meta.jurisdictionRelations
    : [];
  const jurisdictionCandidates = Array.isArray(graph?.meta?.jurisdictionRangeCandidates)
    ? graph.meta.jurisdictionRangeCandidates
    : [];

  return {
    sourceInventory,
    sourceRoles: countBy(sourceInventory, (item) => item.role || "unknown"),
    traceRows: traceRows.length,
    citedRows: citedRows.length,
    citationCoverage: traceRows.length ? citedRows.length / traceRows.length : 0,
    sourceRows: sourceRows.length,
    relationStats,
    lawMap: lawMap
      ? {
          source: lawMap.source || null,
          asOf: lawMap.asOf || null,
          matchedInstitution: lawMap.matchedInstitution || null,
          matchedDepartments: lawMap.matchedDepartments || 0,
          lawCount: lawMap.lawCount || 0,
          unmatchedDepartments: lawMap.unmatchedDepartments?.length || 0,
          ambiguousDepartments: lawMap.ambiguousDepartments?.length || 0,
          excludedScopedNodes: lawMap.excludedScopedNodes || 0,
        }
      : null,
    annex: {
      requirements: annexRequirements.length,
      secured: annexRequirements.length - annexMissing.length,
      missing: annexMissing.length,
      inventory: annexes.length,
      appliedOrganizations: graph?.meta?.annexOrganizations?.length || 0,
    },
    jurisdiction: {
      confirmed: jurisdictionRelations.length,
      candidates: jurisdictionCandidates.length,
      unresolvedRanges: graph?.meta?.jurisdictionRangeCandidates?.length || 0,
    },
  };
}

function hasEvidence(row) {
  return Boolean(row.article || row.evidenceLabel || row.legalBasis || row.evidenceText);
}

function countBy(items, keyFn) {
  const result = {};
  for (const item of items) {
    const key = keyFn(item);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function groupRelations(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const relation = row.relation || "미분류";
    const item = grouped.get(relation) || { relation, count: 0, cited: 0 };
    item.count += 1;
    if (hasEvidence(row)) item.cited += 1;
    grouped.set(relation, item);
  }
  return [...grouped.values()].sort(
    (left, right) => relationRank(left.relation) - relationRank(right.relation) || left.relation.localeCompare(right.relation, "ko"),
  );
}

function relationRank(relation) {
  const index = RELATION_ORDER.indexOf(relation);
  return index >= 0 ? index : RELATION_ORDER.length;
}
