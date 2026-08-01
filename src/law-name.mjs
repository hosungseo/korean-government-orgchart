export function organizationLawNameCandidateGroups(institution) {
  const name = cleanInstitutionName(institution);
  if (!name) return [];
  return [
    {
      role: "decree",
      label: "직제",
      required: true,
      candidates: [`${name}와 그 소속기관 직제`, `${name} 직제`],
    },
    {
      role: "rule",
      label: "직제 시행규칙",
      required: true,
      candidates: [`${name}와 그 소속기관 직제 시행규칙`, `${name} 직제 시행규칙`],
    },
  ];
}

export function inferredOrganizationLawNames(institution) {
  return organizationLawNameCandidateGroups(institution).flatMap((group) => group.candidates);
}

function cleanInstitutionName(value) {
  return String(value || "")
    .replace(/(?:와|과)\s+그\s+소속기관\s+직제(?:\s+시행규칙)?$/, "")
    .replace(/\s+직제(?:\s+시행규칙)?$/, "")
    .trim();
}
