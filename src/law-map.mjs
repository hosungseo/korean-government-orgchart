import { uniq } from "./utils.mjs";

/**
 * Attach the law.go.kr contact-department pivot to exact organization nodes.
 * The contact department map is an operational/current snapshot, so its date
 * is deliberately recorded separately from the organization chart's as-of date.
 */
export function enrichGraphWithLawMap(graph, departmentMap, { asOf, source } = {}) {
  if (!departmentMap || typeof departmentMap !== "object" || Array.isArray(departmentMap)) {
    throw new Error("소관법령 지도는 '부처 → 부서 → laws' JSON 객체여야 합니다.");
  }

  const institutionKey = findInstitutionKey(departmentMap, graph.meta.institution);
  const mapMeta = {
    source: source || "소관법령 지도",
    asOf: asOf || null,
    institution: graph.meta.institution,
    matchedInstitution: institutionKey || null,
    matchedDepartments: 0,
    unmatchedDepartments: [],
    ambiguousDepartments: [],
    excludedScopedNodes: 0,
    lawCount: 0,
  };
  graph.meta.lawMap = mapMeta;

  if (!institutionKey) {
    graph.addWarning(`소관법령 지도에서 기관을 찾지 못했습니다: ${graph.meta.institution}`);
    return mapMeta;
  }

  const nodeIndex = new Map();
  for (const node of graph.nodes.values()) {
    if (!isLawMapEligibleNode(node)) {
      if (node.metadata?.scoped || node.metadata?.parentTaxOffice) mapMeta.excludedScopedNodes += 1;
      continue;
    }
    const key = normalizeDepartmentName(node.name);
    if (!key) continue;
    if (!nodeIndex.has(key)) nodeIndex.set(key, []);
    nodeIndex.get(key).push(node);
  }

  for (const [departmentName, record] of Object.entries(departmentMap[institutionKey] || {})) {
    const candidates = nodeIndex.get(normalizeDepartmentName(departmentName)) || [];
    const laws = Array.isArray(record?.laws) ? record.laws : [];
    if (!candidates.length) {
      mapMeta.unmatchedDepartments.push({
        name: departmentName,
        lawCount: laws.length,
      });
      continue;
    }
    if (candidates.length > 1) {
      mapMeta.ambiguousDepartments.push({
        name: departmentName,
        lawCount: laws.length,
        candidates: candidates.map((node) => ({
          id: node.id,
          name: node.name,
          kind: node.kind,
        })),
      });
      continue;
    }
    const [node] = candidates;
    node.metadata.lawResponsibility = {
      departmentKey: record?.부서키 || null,
      departmentName,
      contact: record?.부서연락처 || null,
      lawCount: laws.length,
      laws,
    };
    node.sources = uniq([...node.sources, mapMeta.source]);
    mapMeta.matchedDepartments += 1;
    mapMeta.lawCount += laws.length;
  }

  if (graph.meta.asOf && asOf && graph.meta.asOf !== asOf) {
    graph.addWarning(
      `기구도 기준일(${graph.meta.asOf})과 소관법령 지도 기준일(${asOf})이 다릅니다. 부서 매핑은 참고 정보로 취급합니다.`,
    );
  } else if (graph.meta.asOf && !asOf) {
    graph.addWarning("소관법령 지도의 기준일이 없어 기구도 기준일과의 정합성을 확인할 수 없습니다.");
  }
  return mapMeta;
}

export function buildLawAppendixPages(graph, { entriesPerPage = 10, representativesPerDepartment = 2 } = {}) {
  const entries = [...graph.nodes.values()]
    .filter((node) => node.metadata?.lawResponsibility?.lawCount)
    .map((node) => ({
      nodeId: node.id,
      name: node.name,
      lawCount: node.metadata.lawResponsibility.lawCount,
      laws: node.metadata.lawResponsibility.laws.slice(0, representativesPerDepartment),
    }))
    .sort((left, right) => right.lawCount - left.lawCount || left.name.localeCompare(right.name, "ko"));
  const pages = [];
  for (let index = 0; index < entries.length; index += entriesPerPage) {
    const pageEntries = entries.slice(index, index + entriesPerPage);
    pages.push({
      kind: "law-index",
      title: graph.meta.title,
      subtitle: `부서별 소관법령 색인 (${pages.length + 1})`,
      rootIds: [],
      nodeIds: [],
      breadcrumb: ["소관법령"],
      lawEntries: pageEntries,
    });
  }
  return pages;
}

function findInstitutionKey(map, institution) {
  const target = normalizeDepartmentName(institution);
  return Object.keys(map).find((key) => normalizeDepartmentName(key) === target) || null;
}

function isLawMapEligibleNode(node) {
  if (node.metadata?.scoped || node.metadata?.parentTaxOffice) return false;
  if (node.metadata?.countsTowardStructure === false && node.kind === "assistant") return false;
  return true;
}

function normalizeDepartmentName(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[ㆍ·]/g, "")
    .trim();
}
