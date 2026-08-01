const RELATION_LABELS = {
  structural: "상부구조",
  assistant: "보조기관",
  advisor: "보좌기관",
  affiliated: "소속기관",
  temporary: "한시조직",
  jurisdiction: "운영상 소관",
};

const KIND_LABELS = {
  institution: "기관",
  head: "기관장",
  deputy: "부기관장",
  assistant: "보조기관",
  advisor: "보좌기관",
  affiliated: "소속기관",
  temporary: "한시조직",
  unit: "조직",
  unknown: "미분류",
};

export function buildTraceRows(graph) {
  const rows = [];
  for (const edge of graph.edges.values()) {
    const parent = graph.nodes.get(edge.parent);
    const child = graph.nodes.get(edge.child);
    if (!parent || !child) continue;
    rows.push({
      institution: graph.meta.institution,
      asOf: graph.meta.asOf || "",
      parent: parent.name,
      parentKind: KIND_LABELS[parent.kind] || parent.kind,
      relation: RELATION_LABELS[edge.type] || edge.type,
      child: child.name,
      childKind: KIND_LABELS[child.kind] || child.kind,
      legalBasis: edge.metadata?.legalBasis || "",
      edgeSource: (edge.sources || []).join(" / "),
      childSource: (child.sources || []).join(" / "),
      flags: traceFlags(edge, child).join("; "),
    });
  }
  return rows.sort(
    (a, b) =>
      a.parent.localeCompare(b.parent, "ko") ||
      relationOrder(a.relation) - relationOrder(b.relation) ||
      a.child.localeCompare(b.child, "ko"),
  );
}

export function formatTraceCsv(rows) {
  const headers = [
    "기관",
    "기준일",
    "상위조직",
    "상위유형",
    "관계",
    "하위조직",
    "하위유형",
    "근거문형",
    "관계출처",
    "조직출처",
    "표식",
  ];
  return `\uFEFF${[headers, ...rows.map(rowToColumns)].map(csvLine).join("\n")}\n`;
}

function rowToColumns(row) {
  return [
    row.institution,
    row.asOf,
    row.parent,
    row.parentKind,
    row.relation,
    row.child,
    row.childKind,
    row.legalBasis,
    row.edgeSource,
    row.childSource,
    row.flags,
  ];
}

function csvLine(values) {
  return values.map(csvCell).join(",");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function relationOrder(label) {
  const order = ["상부구조", "보조기관", "보좌기관", "운영상 소관", "소속기관", "한시조직"];
  const index = order.indexOf(label);
  return index >= 0 ? index : 99;
}

function traceFlags(edge, child) {
  const flags = [];
  const meta = child.metadata || {};
  const edgeMeta = edge.metadata || {};
  if (meta.grade) flags.push(`고공단 ${meta.grade}`);
  if (meta.gradeRange) flags.push(meta.gradeRange);
  if (meta.count) flags.push(`${meta.count}명`);
  if (meta.responsible || edgeMeta.affiliationType === "responsible") flags.push("책임운영기관");
  if (meta.affiliationType === "subsidiary" || edgeMeta.affiliationType === "subsidiary") flags.push("부속기관");
  if (meta.affiliationType === "special-local" || edgeMeta.affiliationType === "special-local") flags.push("특별지방행정기관");
  if (meta.unitRole === "headquarters" || edgeMeta.unitRole === "headquarters") flags.push("본부");
  if (meta.autonomous) flags.push("자율기구");
  if (meta.expires) flags.push(`${meta.expires}까지`);
  if (meta.change) flags.push(meta.change);
  if (meta.jurisdiction?.parent) flags.push(`소관:${meta.jurisdiction.parent}`);
  if (edgeMeta.jurisdiction) flags.push("차관 소관");
  if (meta.concurrentWith) flags.push(`겸직:${meta.concurrentWith}`);
  if (meta.employmentType) flags.push(meta.employmentType);
  if (meta.staffCategories?.length) flags.push(meta.staffCategories.join("+"));
  return [...new Set(flags)];
}
