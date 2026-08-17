import { OrgGraph } from "./model.mjs";

export const DUTY_ALLOCATION_SCHEMA = "kr.go.mois.orgchart.duty-allocation/v1";

export function listDutyAssignments(graphLike) {
  const graph = asGraph(graphLike);
  const fromMeta = Array.isArray(graph.meta?.dutyItemAssignments) ? graph.meta.dutyItemAssignments : [];
  const merged = new Map();
  for (const assignment of fromMeta) addAssignment(merged, assignment);
  if (!merged.size) {
    for (const node of graph.nodes.values()) {
      if (!node?.metadata?.dutyItems?.items?.length) continue;
      addAssignment(merged, {
        department: node.name,
        items: node.metadata.dutyItems.items,
        reference: node.metadata.dutyItems.reference,
        residual: node.metadata.dutyItems.residual,
        source: node.metadata.dutyItems.source,
      });
    }
  }
  return [...merged.values()].map((assignment) => ({
    ...assignment,
    parent: parentNameFor(graph, assignment.department),
  }));
}

export function compareDutyAllocations(beforeGraph, afterGraph) {
  const beforeGraphObj = asGraph(beforeGraph);
  const afterGraphObj = asGraph(afterGraph);
  const before = attachCatalogText(listDutyAssignments(beforeGraphObj), beforeGraphObj.meta?.dutyItemCatalog);
  const after = attachCatalogText(listDutyAssignments(afterGraphObj), afterGraphObj.meta?.dutyItemCatalog);
  const afterByItem = indexHolders(after);
  const afterTextIndex = buildTextIndex(after, afterGraphObj.meta?.dutyItemCatalog);
  const departmentUnits = before.map((assignment) => rollupUnit(assignment, afterByItem, afterTextIndex));
  const parentUnits = rollupParents(before, afterByItem, afterTextIndex);
  return {
    schema: DUTY_ALLOCATION_SCHEMA,
    units: departmentUnits,
    parentUnits,
    notable: notableAllocations(departmentUnits),
    notableParents: notableAllocations(parentUnits),
  };
}

export function notableAllocations(units = []) {
  return units.filter((unit) => {
    if (!unit.itemCount) return false;
    if (unit.unmatched > 0) return true;
    if (unit.shares.length > 1) return true;
    return unit.shares.length === 1 && unit.shares[0].unit !== unit.unit;
  });
}

export function formatAllocationLine(unit) {
  const shares = (unit.shares || []).map((share) => `${share.percent}% → ${share.unit}`).join(" · ");
  const unmatched = unit.unmatched ? ` · ${unit.unmatched}호 미대응` : "";
  return `${unit.unit}  ${unit.itemCount}호  ${shares || "대응 과 없음"}${unmatched}`;
}

export function formatCompactShares(unit) {
  const shares = (unit.shares || []).map((share) => `${share.percent}%→${share.unit}`).join(" ");
  if (shares) return shares;
  return unit.unmatched ? `${unit.unmatched}호 미대응` : "";
}

function addAssignment(merged, assignment) {
  const department = String(assignment?.department || "").trim();
  if (!department) return;
  const items = uniqueItems(assignment.items || []);
  if (!items.length) return;
  const existing = merged.get(department);
  if (!existing) {
    merged.set(department, {
      department,
      items,
      reference: assignment.reference || "",
      residual: Boolean(assignment.residual),
      source: assignment.source || "",
    });
    return;
  }
  existing.items = uniqueItems([...existing.items, ...items]);
  existing.residual = existing.residual || Boolean(assignment.residual);
  if (assignment.reference && !existing.reference.includes(assignment.reference)) {
    existing.reference = existing.reference
      ? `${existing.reference} · ${assignment.reference}`
      : assignment.reference;
  }
}

function rollupUnit(assignment, afterByItem, afterTextIndex = []) {
  const shareMap = new Map();
  let unmatched = 0;
  for (const item of assignment.items) {
    const resolved = holdersForItem(item, afterByItem, afterTextIndex);
    if (!resolved.holders.length) {
      unmatched += 1;
      continue;
    }
    const weight = 1 / resolved.holders.length;
    for (const holder of resolved.holders) {
      const current = shareMap.get(holder) || { unit: holder, count: 0, items: [] };
      current.count += weight;
      current.items.push({ ...item, match: resolved.match });
      shareMap.set(holder, current);
    }
  }
  return decorateUnit({
    unit: assignment.department,
    parent: assignment.parent || null,
    itemCount: assignment.items.length,
    unmatched,
    residual: Boolean(assignment.residual),
    reference: assignment.reference || "",
    shares: [...shareMap.values()],
  });
}

function rollupParents(before, afterByItem, afterTextIndex = []) {
  const groups = new Map();
  for (const assignment of before) {
    if (!assignment.parent) continue;
    const current = groups.get(assignment.parent) || {
      department: assignment.parent,
      parent: null,
      items: [],
      residual: false,
      reference: "",
    };
    current.items = uniqueItems([...current.items, ...assignment.items]);
    current.residual = current.residual || Boolean(assignment.residual);
    if (assignment.reference && !current.reference.includes(assignment.reference)) {
      current.reference = current.reference
        ? `${current.reference} · ${assignment.reference}`
        : assignment.reference;
    }
    groups.set(assignment.parent, current);
  }
  return [...groups.values()].map((assignment) => rollupUnit(assignment, afterByItem, afterTextIndex));
}

function attachCatalogText(assignments, catalog) {
  const byKey = new Map();
  for (const entry of catalog || []) {
    if (!entry?.text) continue;
    byKey.set(`${entry.refKey || ""}:${entry.number}`, entry);
  }
  return assignments.map((assignment) => ({
    ...assignment,
    items: assignment.items.map((item) => {
      const hit = byKey.get(itemKey(item));
      if (!hit) return item;
      return {
        ...item,
        text: item.text || hit.text,
        residual: Boolean(item.residual || hit.residual),
      };
    }),
  }));
}

function buildTextIndex(assignments, catalog) {
  const holders = indexHolders(assignments);
  const index = [];
  for (const entry of catalog || []) {
    if (!entry?.text || entry.residual || /그\s*밖에/.test(entry.text)) continue;
    const owner = holders.get(`${entry.refKey || ""}:${entry.number}`) || [];
    if (!owner.length) continue;
    index.push({
      text: entry.text,
      normalized: normalizeDutyText(entry.text),
      holders: owner,
    });
  }
  return index;
}

function holdersForItem(item, afterByItem, afterTextIndex) {
  const direct = afterByItem.get(itemKey(item)) || [];
  if (direct.length) return { holders: direct, match: "number" };
  if (!item.text || item.residual || /그\s*밖에/.test(item.text)) return { holders: [], match: null };
  return lookupDutyText(item.text, afterTextIndex);
}

function lookupDutyText(text, index) {
  const normalized = normalizeDutyText(text);
  if (!normalized) return { holders: [], match: null };
  const exact = index.filter((entry) => entry.normalized === normalized);
  if (exact.length === 1) return { holders: exact[0].holders, match: "text" };
  if (exact.length > 1) {
    const holders = [...new Set(exact.flatMap((entry) => entry.holders))];
    if (holders.length === 1) return { holders, match: "text" };
    return { holders: [], match: null };
  }
  const scored = index
    .map((entry) => ({ ...entry, score: dutyTextSimilarity(normalized, entry.normalized) }))
    .filter((entry) => entry.score >= 0.86)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return { holders: [], match: null };
  if (scored.length === 1 || scored[0].score - (scored[1]?.score || 0) >= 0.12) {
    return { holders: scored[0].holders, match: "text" };
  }
  return { holders: [], match: null };
}

function normalizeDutyText(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[·ㆍ.,;:()[\]"'“”]/g, "")
    .replace(/(?:에관한사항|의사항)$/g, "");
}

function dutyTextSimilarity(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const common = [...left].filter((character) => right.includes(character)).length;
  return common / Math.max(left.length, right.length, 1);
}

function decorateUnit(unit) {
  const shares = unit.shares
    .map((share) => ({
      unit: share.unit,
      count: Number(share.count.toFixed(3)),
      percent: unit.itemCount ? Math.round((share.count / unit.itemCount) * 100) : 0,
      items: uniqueItems(share.items),
      label: formatItemList(share.items),
    }))
    .sort((left, right) => right.count - left.count || left.unit.localeCompare(right.unit, "ko"));
  reconcilePercents(shares, unit.itemCount, unit.unmatched);
  return { ...unit, shares };
}

function reconcilePercents(shares, itemCount, unmatched) {
  if (!shares.length || !itemCount) return;
  const target = Math.max(0, 100 - Math.round((unmatched / itemCount) * 100));
  const total = shares.reduce((sum, share) => sum + share.percent, 0);
  const delta = target - total;
  if (!delta) return;
  shares[0].percent = Math.max(0, shares[0].percent + delta);
}

function indexHolders(assignments) {
  const map = new Map();
  for (const assignment of assignments) {
    for (const item of assignment.items) {
      const key = itemKey(item);
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(assignment.department)) map.get(key).push(assignment.department);
    }
  }
  return map;
}

function parentNameFor(graph, departmentName) {
  const node = graph.nodeByName?.(departmentName) || [...graph.nodes.values()].find((item) => item.name === departmentName);
  if (!node) return null;
  if (node.metadata?.jurisdiction?.parent) return node.metadata.jurisdiction.parent;
  for (const edge of graph.edges.values()) {
    if (edge.child !== node.id) continue;
    if (!["assistant", "jurisdiction", "structural", "advisor"].includes(edge.type)) continue;
    const parent = graph.nodes.get(edge.parent);
    if (parent && parent.kind !== "institution") return parent.name;
  }
  return null;
}

function uniqueItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const number = normalizeItemNumber(item?.number ?? item?.subparagraph);
    if (number == null) continue;
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      refKey: item.refKey || "",
      number,
      ...(item.text ? { text: item.text } : {}),
      ...(item.citation ? { citation: item.citation } : {}),
      ...(item.residual ? { residual: true } : {}),
      ...(item.match ? { match: item.match } : {}),
    });
  }
  return result.sort((left, right) => (
    left.refKey.localeCompare(right.refKey, "ko") || compareItemNumber(left.number, right.number)
  ));
}

export function formatItemList(items) {
  const unique = uniqueItems(items);
  if (!unique.length) return "";
  const grouped = new Map();
  for (const item of unique) {
    if (!grouped.has(item.refKey)) grouped.set(item.refKey, []);
    grouped.get(item.refKey).push(item.number);
  }
  return [...grouped.entries()].map(([refKey, numbers]) => {
    numbers.sort(compareItemNumber);
    const ranges = [];
    let start = numbers[0];
    let prev = numbers[0];
    for (const number of numbers.slice(1)) {
      if (Number.isFinite(number) && Number.isFinite(prev) && number === prev + 1) {
        prev = number;
        continue;
      }
      ranges.push(String(start) === String(prev) ? `제${start}호` : `제${start}~${prev}호`);
      start = number;
      prev = number;
    }
    ranges.push(String(start) === String(prev) ? `제${start}호` : `제${start}~${prev}호`);
    return `${refKey ? `${refKey} ` : ""}${ranges.join("ㆍ")}`;
  }).join(", ");
}

function itemKey(item) {
  return `${item.refKey || ""}:${normalizeItemNumber(item?.number ?? item?.subparagraph) ?? ""}`;
}

function normalizeItemNumber(value) {
  const normalized = String(value ?? "").replace(/\s+/g, "");
  if (!/^\d+(?:의\d+)?$/.test(normalized)) return null;
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

function compareItemNumber(left, right) {
  const [leftBase, leftSuffix = "0"] = String(left).split("의");
  const [rightBase, rightSuffix = "0"] = String(right).split("의");
  return Number(leftBase) - Number(rightBase) || Number(leftSuffix) - Number(rightSuffix);
}

function asGraph(value) {
  if (value?.nodes instanceof Map) return value;
  return OrgGraph.fromJSON(value);
}
