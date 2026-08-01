import { findAnnex } from "./annex.mjs";
import { layoutPage, resolvePageSize } from "./layout.mjs";
import { summarizeStructure } from "./model.mjs";

const JURISDICTION_ADVISOR = /(?:정책관|기획관|관리관|심의관|교섭관|법무관|지원관|소통관)$/;
const DEPARTMENT = /(?:과|팀|담당관)$/;

export function buildAuditReport(graph, pages = [], options = {}) {
  const pageDiagnostics = options.layout === false ? [] : collectPageDiagnostics(graph, pages);
  const jurisdictionCandidates = suggestJurisdictionCandidates(graph);
  const reviewActions = collectReviewActions(graph, pageDiagnostics, jurisdictionCandidates);
  const annexRequirements = (graph.meta.annexRequirements || []).map((item) => ({
    ...item,
    matchedAnnex: findAnnex(graph, item.annex, { source: item.source }),
  }));
  const kindCounts = {};
  for (const node of graph.nodes.values()) kindCounts[node.kind] = (kindCounts[node.kind] || 0) + 1;

  return {
    meta: {
      institution: graph.meta.institution,
      title: graph.meta.title,
      asOf: graph.meta.asOf,
      sources: graph.meta.sources || [],
      status: reviewActions.some((action) => action.priority === "high")
        ? "needs-correction"
        : reviewActions.length
          ? "needs-review"
          : "ready",
    },
    summary: {
      nodes: graph.nodes.size,
      edges: graph.edges.size,
      kinds: kindCounts,
      structure: summarizeStructure(graph),
    },
    reviewActions,
    warnings: graph.meta.warnings || [],
    validation: graph.meta.validation || [],
    annexRequirements,
    annexes: graph.meta.annexes || [],
    annexOrganizations: graph.meta.annexOrganizations || [],
    temporaryHeadcounts: graph.meta.temporaryHeadcounts || [],
    jurisdictionRelations: graph.meta.jurisdictionRelations || [],
    jurisdictionCandidates,
    lawMap: graph.meta.lawMap || null,
    spanDiagnostics: graph.meta.spanDiagnostics || [],
    layoutDiagnostics: pageDiagnostics,
  };
}

export function formatAuditMarkdown(report) {
  const lines = [];
  lines.push(`# ${report.meta.title || report.meta.institution} 조직도 감사 리포트`);
  if (report.meta.asOf) lines.push(`- 기준일: ${report.meta.asOf}`);
  lines.push(`- 상태: ${statusLabel(report.meta.status)}`);
  lines.push(`- 노드/관계: ${report.summary.nodes} / ${report.summary.edges}`);
  lines.push(`- 기구 수: 보조 ${report.summary.structure.unitCounts.line}, 보좌 ${report.summary.structure.unitCounts.staff}, 소속 ${report.summary.structure.unitCounts.affiliated}`);
  lines.push("");

  appendSection(lines, "우선 확인", report.reviewActions, (item) => `- [${priorityLabel(item.priority)}] ${item.message}`);
  appendSection(lines, "통칙·구조 검증", report.validation, (item) => `- ${item}`);
  appendSection(lines, "별표 필요", report.annexRequirements, formatAnnexRequirement);
  appendSection(lines, "별표 인벤토리", report.annexes, formatAnnexInventory);
  appendSection(lines, "별표 조직 반영", report.annexOrganizations, formatAnnexOrganization);
  appendSection(lines, "한시정원", report.temporaryHeadcounts, (item) => `- ${item.target}: ${item.expires}까지 (${item.source})`);
  appendSection(lines, "정책관·관 소관 후보", report.jurisdictionCandidates, formatJurisdictionCandidate);
  appendSection(lines, "관리폭 진단", report.spanDiagnostics, (item) => `- ${item.node}: ${item.directUnits}개 · ${item.message}`);

  if (report.lawMap) {
    lines.push("## 소관법령 지도");
    lines.push(`- 매칭 기관: ${report.lawMap.matchedInstitution || "없음"}`);
    lines.push(`- 매칭 부서: ${report.lawMap.matchedDepartments}`);
    lines.push(`- 연결 법령: ${report.lawMap.lawCount}`);
    if (report.lawMap.excludedScopedNodes) {
      lines.push(`- scoped 하위기관 내부조직 제외: ${report.lawMap.excludedScopedNodes}`);
    }
    if (report.lawMap.ambiguousDepartments?.length) {
      lines.push("- 중복 후보 부서:");
      for (const item of report.lawMap.ambiguousDepartments.slice(0, 20)) {
        lines.push(`  - ${item.name} (${item.lawCount}건, 후보 ${item.candidates.length}개)`);
      }
      if (report.lawMap.ambiguousDepartments.length > 20) {
        lines.push(`  - 외 ${report.lawMap.ambiguousDepartments.length - 20}개`);
      }
    }
    if (report.lawMap.unmatchedDepartments?.length) {
      lines.push("- 미매칭 부서:");
      for (const item of report.lawMap.unmatchedDepartments.slice(0, 20)) {
        lines.push(`  - ${item.name} (${item.lawCount}건)`);
      }
      if (report.lawMap.unmatchedDepartments.length > 20) {
        lines.push(`  - 외 ${report.lawMap.unmatchedDepartments.length - 20}개`);
      }
    }
    lines.push("");
  }

  appendSection(
    lines,
    "페이지 배치",
    report.layoutDiagnostics,
    (item) => `- ${item.pageNumber}/${item.pageCount} ${item.layoutStyle} · ${item.subtitle}: 노드 ${item.nodes}, 관계 ${item.edges}, ${item.diagnostics.ok ? "정상" : `넘침 ${item.diagnostics.overflow.length} · 겹침 ${item.diagnostics.overlaps.length}`}`,
  );
  appendSection(lines, "파서 경고", report.warnings, (item) => `- ${item}`);
  return `${lines.join("\n")}\n`;
}

function collectPageDiagnostics(graph, pages) {
  return pages.map((page) => {
    const pageSize = resolvePageSize(page.paper || "slide");
    const layout = layoutPage(graph, page, { pageSize });
    return {
      pageNumber: page.pageNumber,
      pageCount: page.pageCount,
      title: page.title,
      subtitle: page.subtitle,
      paper: page.paper,
      layoutStyle: page.layoutStyle,
      nodes: layout.nodes.length,
      edges: layout.edges.length,
      diagnostics: layout.diagnostics,
    };
  });
}

function collectReviewActions(graph, pageDiagnostics, jurisdictionCandidates) {
  const actions = [];
  for (const message of graph.meta.validation || []) {
    actions.push({ priority: "high", topic: "validation", message });
  }
  for (const page of pageDiagnostics) {
    if (page.diagnostics?.overflow?.length) {
      actions.push({
        priority: "high",
        topic: "layout",
        message: `${page.pageNumber}쪽 ${page.subtitle}에서 ${page.diagnostics.overflow.length}개 조직이 인쇄 프레임을 벗어났습니다.`,
      });
    }
    if (page.diagnostics?.overlaps?.length) {
      actions.push({
        priority: "high",
        topic: "layout",
        message: `${page.pageNumber}쪽 ${page.subtitle}에서 상자 겹침 ${page.diagnostics.overlaps.length}건이 있습니다.`,
      });
    }
  }
  for (const item of graph.meta.annexRequirements || []) {
    const annex = findAnnex(graph, item.annex, { source: item.source });
    const applied = findAppliedAnnexOrganization(graph, annex);
    actions.push({
      priority: applied ? "low" : item.type === "organization-matrix" ? "high" : "medium",
      topic: "annex",
      message: applied
        ? `${item.annex} 조직 반영됨: ${item.description}`
        : annex
          ? `${item.annex} 확보됨(${annex.rowCount}행): ${item.description}`
          : `${item.annex} 확인 필요: ${item.description}`,
    });
  }
  for (const item of jurisdictionCandidates) {
    actions.push({
      priority: "medium",
      topic: "jurisdiction",
      message: `${item.parent} 밑 ${item.advisor}의 과 소관을 시행규칙 분장사무로 확인하세요. 후보 ${item.departments.length}개.`,
    });
  }
  if (graph.meta.lawMap?.unmatchedDepartments?.length) {
    actions.push({
      priority: "medium",
      topic: "law-map",
      message: `소관법령 지도에서 ${graph.meta.lawMap.unmatchedDepartments.length}개 부서가 조직 노드와 매칭되지 않았습니다.`,
    });
  }
  if (graph.meta.lawMap?.ambiguousDepartments?.length) {
    actions.push({
      priority: "medium",
      topic: "law-map",
      message: `소관법령 지도에서 ${graph.meta.lawMap.ambiguousDepartments.length}개 부서가 같은 이름의 여러 조직 후보와 충돌했습니다.`,
    });
  }
  for (const item of graph.meta.spanDiagnostics || []) {
    actions.push({
      priority: "low",
      topic: "span",
      message: `${item.node}: ${item.message}`,
    });
  }
  for (const message of graph.meta.warnings || []) {
    actions.push({ priority: "low", topic: "warning", message });
  }
  return actions;
}

export function suggestJurisdictionCandidates(graph) {
  const parentToAdvisors = new Map();
  for (const node of graph.nodes.values()) {
    if (node.kind !== "advisor" || !JURISDICTION_ADVISOR.test(node.name)) continue;
    for (const { edge, node: parent } of graph.parentsOf(node.id)) {
      if (edge.type !== "advisor" || !parent) continue;
      if (!parentToAdvisors.has(parent.id)) parentToAdvisors.set(parent.id, []);
      parentToAdvisors.get(parent.id).push(node);
    }
  }

  const assigned = new Set((graph.meta.jurisdictionRelations || []).map((item) => item.child));
  const result = [];
  for (const [parentId, advisors] of parentToAdvisors) {
    const parent = graph.nodes.get(parentId);
    if (!parent) continue;
    if (!/(?:실|국|본부|단)$/.test(parent.name)) continue;
    const departments = orderedChildrenOf(graph, parent.id, ["assistant", "temporary"])
      .filter((node) => node && DEPARTMENT.test(node.name) && !assigned.has(node.name));
    if (!departments.length) continue;
    if (advisors.length > 1) {
      result.push({
        parent: parent.name,
        advisor: advisors.map((advisor) => advisor.name).join("ㆍ"),
        advisors: advisors.map((advisor) => advisor.name),
        departments: departments.map((node) => node.name),
        confidence: "multiple-advisors-need-range-crosswalk",
        directive: null,
      });
      continue;
    }
    for (const advisor of advisors) {
      result.push({
        parent: parent.name,
        advisor: advisor.name,
        departments: departments.map((node) => node.name),
        confidence: "single-advisor-container",
        directive: `@소관: ${advisor.name} > ${departments.map((node) => node.name).join("ㆍ")} [시행규칙 분장사무 확인 필요]`,
      });
    }
  }
  return result;
}

function orderedChildrenOf(graph, parentId, types) {
  return [...graph.edges.values()]
    .filter((edge) => edge.parent === parentId && types.includes(edge.type))
    .map((edge) => graph.nodes.get(edge.child))
    .filter(Boolean);
}

function appendSection(lines, title, items, formatter) {
  if (!items?.length) return;
  lines.push(`## ${title}`);
  for (const item of items) lines.push(formatter(item));
  lines.push("");
}

function formatJurisdictionCandidate(item) {
  const lines = [
    `- ${item.parent} > ${item.advisor}: ${item.departments.join("ㆍ")}`,
    `  - 후보 수준: ${item.confidence}`,
  ];
  if (item.directive) lines.push(`  - 지시문 초안: \`${item.directive}\``);
  else lines.push("  - 지시문 초안: 복수 보좌기관이므로 직제 호 번호 범위와 시행규칙 과 분장사무를 먼저 대조해야 합니다.");
  return lines.join("\n");
}

function formatAnnexRequirement(item) {
  const annex = item.matchedAnnex;
  if (annex) return `- ${item.annex} · 확보됨 ${annex.rowCount}행 · ${item.description} (${item.source})`;
  return `- ${item.annex} · ${item.description} (${item.source})`;
}

function formatAnnexInventory(item) {
  const suffix = item.rowCount ? ` · 표 ${item.rowCount}행` : "";
  return `- ${item.annex} · ${item.type} · ${item.title}${suffix}`;
}

function findAppliedAnnexOrganization(graph, annex) {
  if (!annex) return null;
  return (graph.meta.annexOrganizations || []).find(
    (item) => item.annex === annex.annex && item.title === annex.title,
  ) || null;
}

function formatAnnexOrganization(item) {
  if (item.type === "regional-tax-office-tree") {
    return `- ${item.annex} · ${item.title}: 지방청 ${item.parentCount}개, 세무서 ${item.childCount}개를 소속기관 트리로 반영`;
  }
  if (item.type === "regional-tax-office-jurisdiction") {
    return `- ${item.annex} · ${item.title}: 지방청 ${item.updatedCount}개의 위치·관할구역 메타데이터 반영`;
  }
  if (item.type === "tax-office-jurisdiction") {
    const skipped = item.skippedOffices?.length ? `, 미매칭 세무서 ${item.skippedOffices.length}개` : "";
    return `- ${item.annex} · ${item.title}: 세무서 ${item.updatedCount}개의 위치·관할구역 메타데이터 반영${skipped}`;
  }
  if (item.type === "tax-office-branch-jurisdiction") {
    const skipped = item.skippedTaxOffices?.length ? `, 미매칭 세무서 ${item.skippedTaxOffices.length}개` : "";
    return `- ${item.annex} · ${item.title}: 지서 ${item.branchCount}개를 세무서 하위 소속기관으로 반영${skipped}`;
  }
  if (item.type === "tax-office-department-matrix") {
    const skipped = item.skippedOffices?.length ? `, 미매칭 세무서 ${item.skippedOffices.length}개` : "";
    return `- ${item.annex} · ${item.title}: 세무서 ${item.officeCount}개에 과 ${item.departmentCount}개를 scoped 하부조직으로 반영${skipped}`;
  }
  return `- ${item.annex} · ${item.title}: ${item.type}`;
}

function statusLabel(value) {
  if (value === "needs-correction") return "수정 필요";
  if (value === "needs-review") return "검토 필요";
  return "사용 가능";
}

function priorityLabel(value) {
  if (value === "high") return "높음";
  if (value === "medium") return "중간";
  return "낮음";
}
