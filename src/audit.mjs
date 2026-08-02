import { findAnnex } from "./annex.mjs";
import { jurisdictionEvidenceLabel } from "./jurisdiction-evidence.mjs";
import { layoutPage, resolvePageSize } from "./layout.mjs";
import { summarizeStructure } from "./model.mjs";

const JURISDICTION_ADVISOR = /(?:정책관|기획관|관리관|심의관|교섭관|법무관|지원관|소통관)$/;
const DEPARTMENT = /(?:과|팀|담당관)$/;

export function buildAuditReport(graph, pages = [], options = {}) {
  const pageDiagnostics = options.layout === false ? [] : collectPageDiagnostics(graph, pages);
  const jurisdictionCandidates = suggestJurisdictionCandidates(graph);
  const jurisdictionCrosswalks = collectJurisdictionCrosswalks(graph);
  const reviewActions = collectReviewActions(graph, pageDiagnostics, jurisdictionCandidates, jurisdictionCrosswalks);
  const layoutRecommendations = collectLayoutRecommendations(pageDiagnostics);
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
    jurisdictionCrosswalks,
    jurisdictionRunInferences: graph.meta.jurisdictionRunInferences || [],
    lawMap: graph.meta.lawMap || null,
    spanDiagnostics: graph.meta.spanDiagnostics || [],
    layoutDiagnostics: pageDiagnostics,
    layoutRecommendations,
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
  appendSection(lines, "확정 소관관계", report.jurisdictionRelations, formatJurisdictionRelation);
  appendJurisdictionCrosswalkSection(lines, report.jurisdictionCrosswalks);
  appendSection(lines, "순서 기반 소관 보강", report.jurisdictionRunInferences, formatJurisdictionRunInference);
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
    (item) => `- ${item.pageNumber}/${item.pageCount} ${item.layoutStyle} · ${item.subtitle}: 노드 ${item.nodes}, 관계 ${item.edges}, ${formatLayoutStatus(item.diagnostics)}`,
  );
  appendSection(lines, "작도 개선 제안", report.layoutRecommendations, formatLayoutRecommendation);
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

function collectReviewActions(graph, pageDiagnostics, jurisdictionCandidates, jurisdictionCrosswalks = {}) {
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
    if (page.diagnostics?.edgeIssues?.length) {
      actions.push({
        priority: "high",
        topic: "layout",
        message: `${page.pageNumber}쪽 ${page.subtitle}에서 연결선 품질 문제 ${page.diagnostics.edgeIssues.length}건이 있습니다.`,
      });
    }
    if (page.diagnostics?.qualityIssues?.length) {
      actions.push({
        priority: "low",
        topic: "layout-quality",
        message: `${page.pageNumber}쪽 ${page.subtitle}에서 간격·정렬·선교차·선-상자 관통·선 우회·균형·가독성 다듬기 후보 ${page.diagnostics.qualityIssues.length}건이 있습니다.`,
      });
    }
  }
  for (const item of graph.meta.annexRequirements || []) {
    const annex = findAnnex(graph, item.annex, { source: item.source });
    const applied = findAppliedAnnexOrganization(graph, annex);
    const sourceLabel = item.source ? compactSourceLabel(item.source) : "";
    const sourcePrefix = sourceLabel ? `${sourceLabel}, ` : "";
    const sourceParen = sourceLabel ? `(${sourceLabel})` : "";
    actions.push({
      priority: applied ? "low" : item.type === "organization-matrix" ? "high" : "medium",
      topic: "annex",
      message: applied
        ? `${item.annex} 조직 반영됨(${sourcePrefix}${annex?.rowCount ?? 0}행): ${item.description}`
        : annex
          ? `${item.annex} 확보됨(${sourcePrefix}${annex.rowCount}행): ${item.description}`
          : `${item.annex} 확인 필요${sourceParen}: ${item.description}`,
    });
  }
  for (const item of jurisdictionCandidates) {
    actions.push({
      priority: "medium",
      topic: "jurisdiction",
      message: `${item.parent} 밑 ${item.advisor}의 과 소관을 시행규칙 분장사무로 확인하세요. 후보 ${item.departments.length}개.`,
    });
  }
  for (const item of jurisdictionCrosswalks.unresolved || []) {
    actions.push({
      priority: "medium",
      topic: "jurisdiction-range",
      message: `${item.department}의 ${item.reference} 소관이 단일 보좌기관 범위로 확정되지 않았습니다.`,
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
  for (const item of collectSourceCompletenessWarnings(graph)) {
    actions.push({
      priority: "medium",
      topic: "source-completeness",
      message: item.message,
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

function collectSourceCompletenessWarnings(graph) {
  const inventory = graph.meta.sourceInventory || [];
  const hasDecree = inventory.some((item) => item.role === "decree");
  const hasRule = inventory.some((item) => item.role === "rule");
  if (!hasDecree || hasRule) return [];
  const leafUpperUnits = [...graph.nodes.values()]
    .filter((node) => isPotentialRuleExpandedUnit(node))
    .filter((node) => !hasDepartmentChildren(graph, node))
    .map((node) => node.name)
    .sort((a, b) => a.localeCompare(b, "ko"));
  if (!leafUpperUnits.length) return [];
  const sample = leafUpperUnits.slice(0, 6).join("ㆍ");
  const extra = leafUpperUnits.length > 6 ? ` 외 ${leafUpperUnits.length - 6}개` : "";
  return [{
    message: `직제 시행규칙 입력이 확인되지 않아 ${sample}${extra} 밑 과·담당관·팀이 누락됐을 수 있습니다. 과 단위 조직도에는 시행규칙 원문과 필요한 별표를 함께 넣으세요.`,
    units: leafUpperUnits,
  }];
}

function isPotentialRuleExpandedUnit(node) {
  if (!node || ["institution", "head", "deputy", "affiliated"].includes(node.kind)) return false;
  if (DEPARTMENT.test(node.name)) return false;
  if (/(?:박물관|미술관|도서관|극장|전당|연구원|관리원|교육원|개발원|사무소)$/.test(node.name)) return false;
  return /(?:실|국|본부|관|단)$/.test(node.name);
}

function hasDepartmentChildren(graph, node) {
  return graph.childrenOf(node.id).some(({ edge, node: child }) =>
    edge.type !== "jurisdiction" && DEPARTMENT.test(child.name),
  );
}

function collectLayoutRecommendations(pageDiagnostics) {
  const recommendations = [];
  for (const page of pageDiagnostics || []) {
    const diagnostics = page.diagnostics || {};
    if (diagnostics.ok) continue;
    const prefix = `${page.pageNumber}/${page.pageCount} ${page.subtitle}`;
    if (diagnostics.overflow?.length || diagnostics.overlaps?.length) {
      recommendations.push({
        pageNumber: page.pageNumber,
        pageCount: page.pageCount,
        subtitle: page.subtitle,
        layoutStyle: page.layoutStyle,
        paper: page.paper,
        issue: "box-fit",
        message:
          page.paper === "a4-half"
            ? `${prefix}: A4 반쪽 면에서 상자 밀도가 높습니다. --max-nodes를 12~16으로 낮추거나 --focus로 실·국 단위 면을 더 나누세요.`
            : `${prefix}: 상자가 인쇄 프레임을 넘거나 겹칩니다. --max-nodes를 낮춰 분할하거나 --paper a4-landscape --layout two-column을 우선 시도하세요.`,
      });
      if (page.layoutStyle !== "catalog") {
        recommendations.push({
          pageNumber: page.pageNumber,
          pageCount: page.pageCount,
          subtitle: page.subtitle,
          layoutStyle: page.layoutStyle,
          paper: page.paper,
          issue: "print-safe-fallback",
          message: `${prefix}: 검토서 첨부용으로는 연결선을 줄인 --layout catalog가 가장 안전한 대체안입니다.`,
        });
      }
    }
    if (diagnostics.edgeIssues?.length) {
      const reasons = [...new Set(diagnostics.edgeIssues.map((item) => item.reason).filter(Boolean))];
      recommendations.push({
        pageNumber: page.pageNumber,
        pageCount: page.pageCount,
        subtitle: page.subtitle,
        layoutStyle: page.layoutStyle,
        paper: page.paper,
        issue: "connector-routing",
        message: `${prefix}: 연결선 문제가 있습니다(${reasons.join(", ") || "원인 미상"}). --max-nodes를 낮춰 계층 간격을 확보하거나, 기능 검토용이면 --layout flow, 인쇄 첨부용이면 --layout catalog를 쓰세요.`,
      });
    }
    if (diagnostics.qualityIssues?.length) {
      const reasons = [...new Set(diagnostics.qualityIssues.map((item) => item.reason).filter(Boolean))];
      recommendations.push({
        pageNumber: page.pageNumber,
        pageCount: page.pageCount,
        subtitle: page.subtitle,
        layoutStyle: page.layoutStyle,
        paper: page.paper,
        issue: "layout-polish",
        message: `${prefix}: 상자 간격·중심축·연결선 교차·선-상자 관통·과도한 선 우회·컬럼 균형·세로글자 폭이 어색할 수 있습니다(${reasons.join(", ") || "원인 미상"}). --layout best가 다른 후보를 고르도록 두거나, 같은 페이지 안 노드 수를 줄여 균일한 간격을 확보하세요.`,
      });
    }
  }
  return recommendations;
}

function collectJurisdictionCrosswalks(graph) {
  const rangeRelations = (graph.meta.jurisdictionRelations || []).filter(
    (item) => item.evidence === "duty-item-range",
  );
  const confirmedKeys = new Set(rangeRelations.map((item) => `${item.child}:${item.reference || ""}`));
  const unresolved = [];
  for (const item of graph.meta.jurisdictionRangeCandidates || []) {
    const key = `${item.department}:${item.reference || ""}`;
    if (confirmedKeys.has(key)) continue;
    const node = graph.nodeByName(item.department);
    const assigned = node?.metadata?.jurisdiction;
    if (assigned && (!item.advisors?.length || item.advisors.includes(assigned.parent))) continue;
    unresolved.push(item);
  }
  return {
    hints: graph.meta.jurisdictionRangeHints || [],
    confirmed: rangeRelations,
    unresolved,
  };
}

function formatLayoutStatus(diagnostics) {
  const hard = `넘침 ${diagnostics?.overflow?.length || 0} · 겹침 ${diagnostics?.overlaps?.length || 0} · 연결선 ${diagnostics?.edgeIssues?.length || 0}`;
  const quality = diagnostics?.qualityIssues?.length ? ` · 품질 ${diagnostics.qualityIssues.length}` : "";
  if (diagnostics?.ok && !diagnostics?.qualityIssues?.length) return "정상";
  if (diagnostics?.ok) return `정상${quality}`;
  return `${hard}${quality}`;
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

function appendJurisdictionCrosswalkSection(lines, crosswalks) {
  if (!crosswalks?.confirmed?.length && !crosswalks?.unresolved?.length) return;
  lines.push("## 직제 호 번호 소관 대조");
  if (crosswalks.confirmed?.length) {
    lines.push("- 자동 확정:");
    for (const item of crosswalks.confirmed) {
      const reference = item.reference ? ` · ${item.reference}` : "";
      lines.push(`  - ${item.parent} > ${item.child}${reference} (${item.source})`);
    }
  }
  if (crosswalks.unresolved?.length) {
    lines.push("- 확인 필요:");
    for (const item of crosswalks.unresolved) {
      const advisors = item.advisors?.length ? item.advisors.join("ㆍ") : "일치 범위 없음";
      lines.push(`  - ${item.department}: ${item.reference} · ${advisors} (${item.source})`);
    }
  }
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

function formatJurisdictionRelation(item) {
  const evidence = jurisdictionEvidenceLabel(item.evidence);
  const reference = item.reference ? ` · ${item.reference}` : "";
  const article = item.article ? ` · ${item.article}` : "";
  return `- ${item.parent} > ${item.child}: ${evidence || item.legalBasis || "근거 미상"}${reference}${article} (${item.source || "출처 미상"})`;
}

function formatJurisdictionRunInference(item) {
  return `- ${item.parent} > ${item.advisor}: ${item.departments.join("ㆍ")} (${item.source})`;
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

function formatLayoutRecommendation(item) {
  return `- ${item.message}`;
}

function compactSourceLabel(source) {
  return String(source || "")
    .replace(/\s*\[시행\s*\d+\]\s*$/, "")
    .trim();
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
