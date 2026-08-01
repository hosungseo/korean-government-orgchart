export function buildAuditCaseSpecs({
  institutions,
  date,
  view = "operational",
  paper = "a4-half",
  layout = "best",
  layouts,
  focus,
  maxNodes,
  lawMap,
  lawMapDate,
} = {}) {
  const names = parseInstitutionList(institutions);
  if (!names.length) throw new Error("기관명이 하나 이상 필요합니다.");
  return {
    cases: names.map((institution) => ({
      id: caseId(institution, date),
      institution,
      ...(date ? { date } : {}),
      view,
      paper,
      ...(layouts ? { layouts } : { layout }),
      ...(focus ? { focus } : {}),
      ...(maxNodes ? { maxNodes: Number(maxNodes) } : {}),
      ...(lawMap ? { lawMap } : {}),
      ...(lawMapDate ? { lawMapDate } : {}),
    })),
  };
}

export function parseInstitutionList(value) {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item || "").split(/[,\n;]+/))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function caseId(institution, date) {
  return [institution, date].filter(Boolean).join("-").replace(/\s+/g, "");
}
