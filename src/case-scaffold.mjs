import { LAYOUT_PRESETS, parseLayoutStyles } from "./layout.mjs";

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
  expandLayouts,
} = {}) {
  const names = parseInstitutionList(institutions);
  if (!names.length) throw new Error("기관명이 하나 이상 필요합니다.");
  const cases = names.map((institution) => ({
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
  }));
  return {
    cases: expandCaseSpecsByLayouts(cases, expandLayouts).cases,
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

export function expandCaseSpecsByLayouts(caseSpecs = [], globalLayouts) {
  const cases = [];
  let expandedCases = 0;
  for (let index = 0; index < caseSpecs.length; index += 1) {
    const caseSpec = caseSpecs[index] || {};
    const requested = layoutExpansionRequest(caseSpec, globalLayouts);
    const styles = parseLayoutStyles(requested);
    if (!styles.length) {
      cases.push({ ...caseSpec });
      continue;
    }
    expandedCases += 1;
    const baseId = caseSpec.id || caseSpec.institution || caseSpec.title || `case-${index + 1}`;
    for (const style of styles) {
      const {
        layouts: _layouts,
        layoutCandidates: _layoutCandidates,
        expandLayouts: _expandLayouts,
        ...rest
      } = caseSpec;
      cases.push({
        ...rest,
        id: `${baseId}-${style}`,
        outputName: `${caseSpec.outputName || baseId}-${style}`,
        layout: style,
        layoutVariantOf: baseId,
        layoutVariant: style,
        layoutVariantLabel: LAYOUT_PRESETS[style]?.label || style,
      });
    }
  }
  return {
    cases,
    expanded: expandedCases > 0,
    expandedCases,
    sourceCases: caseSpecs.length,
  };
}

function layoutExpansionRequest(caseSpec = {}, globalLayouts) {
  if (caseSpec.expandLayouts === false || caseSpec.expandLayouts === "false") return null;
  if (caseSpec.layoutCandidates != null) return caseSpec.layoutCandidates;
  if (caseSpec.expandLayouts != null && caseSpec.expandLayouts !== true) return caseSpec.expandLayouts;
  if (caseSpec.expandLayouts === true) return caseSpec.layouts || globalLayouts || "all";
  if (globalLayouts == null || globalLayouts === false || globalLayouts === "false") return null;
  if (globalLayouts === true) return caseSpec.layouts || "all";
  return globalLayouts;
}
