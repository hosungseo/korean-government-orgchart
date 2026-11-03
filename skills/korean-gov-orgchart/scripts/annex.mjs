import { normalizeNodeName } from "./model.mjs";
import { normalizeWhitespace, uniq } from "./utils-core.mjs";

export function extractAnnexesFromLawJson(json, { source } = {}) {
  const law = json?.["법령"];
  if (!law) return [];
  const units = flattenAnnexUnits(law["별표"]);
  return units.map((unit, index) => {
    const text = annexText(unit);
    const rows = parseBoxTable(text);
    const title = normalizeWhitespace(
      unit["별표제목"] ||
        unit["별표제목문자열"] ||
        unit["별표명"] ||
        `별표 ${index + 1}`,
    );
    const annexNumber = normalizeAnnexNumber(unit["별표번호"] || title.match(/\[별표\s*([^\]]+)\]/)?.[1] || index + 1);
    return {
      annex: `별표 ${annexNumber}`,
      number: annexNumber,
      title,
      key: unit["별표키"] || null,
      effectiveDate: unit["별표시행일자"] || null,
      type: classifyAnnex(title, text),
      source: source || null,
      links: {
        hwp: unit["별표서식파일링크"] || null,
        pdf: unit["별표서식PDF파일링크"] || null,
        image: unit["별표서식이미지파일링크"] || null,
      },
      files: {
        hwp: unit["별표HWP파일명"] || null,
        pdf: unit["별표PDF파일명"] || null,
      },
      rowCount: rows.length,
      rows,
      textPreview: text.slice(0, 1200),
    };
  });
}

export function attachAnnexes(graph, annexes) {
  if (!annexes?.length) return graph;
  const existing = graph.meta.annexes || [];
  const byKey = new Map(existing.map((annex) => [`${annex.source || ""}|${annex.annex}|${annex.title}`, annex]));
  for (const annex of annexes) {
    const key = `${annex.source || ""}|${annex.annex}|${annex.title}`;
    byKey.set(key, annex);
  }
  graph.meta.annexes = [...byKey.values()];
  return graph;
}

export function applyAnnexOrganizations(graph, annexes = graph.meta.annexes || []) {
  if (!annexes?.length) return graph;
  const summaries = [];
  for (const annex of annexes) {
    if (isRegionalTaxOfficeAnnex(annex)) {
      const summary = applyRegionalTaxOfficeAnnex(graph, annex);
      if (summary.parentCount || summary.childCount) summaries.push(summary);
    }
  }
  for (const annex of annexes) {
    if (isRegionalJurisdictionAnnex(annex)) {
      const summary = applyRegionalJurisdictionAnnex(graph, annex);
      if (summary.updatedCount) summaries.push(summary);
    }
  }
  for (const annex of annexes) {
    if (isTaxOfficeJurisdictionAnnex(annex)) {
      const summary = applyTaxOfficeJurisdictionAnnex(graph, annex);
      if (summary.updatedCount || summary.skippedOffices.length) summaries.push(summary);
    } else if (isTaxOfficeBranchAnnex(annex)) {
      const summary = applyTaxOfficeBranchAnnex(graph, annex);
      if (summary.branchCount || summary.skippedTaxOffices.length) summaries.push(summary);
    }
  }
  for (const annex of annexes) {
    if (isTaxOfficeDepartmentMatrixAnnex(annex)) {
      const summary = applyTaxOfficeDepartmentMatrixAnnex(graph, annex);
      if (summary.officeCount || summary.skippedOffices.length) summaries.push(summary);
    }
  }
  // 범용 지방관서 별표: 상위기관 열이 없는 표(관서 본체)를 먼저 편입한 뒤,
  // 상위기관 열이 있는 표(지원센터 등)가 그 노드에 매달리게 두 번 돈다.
  const fieldOfficeAnnexes = annexes.filter((annex) => (
    isNamedFieldOfficeAnnex(annex)
    && !isRegionalTaxOfficeAnnex(annex)
    && !isRegionalJurisdictionAnnex(annex)
    && !isTaxOfficeJurisdictionAnnex(annex)
    && !isTaxOfficeBranchAnnex(annex)
    && !isTaxOfficeDepartmentMatrixAnnex(annex)
  ));
  for (const pass of [0, 1]) {
    for (const annex of fieldOfficeAnnexes) {
      const hasParentColumn = normalizeAnnexRows(annex)
        .some((row) => row.filter(Boolean).length >= 4);
      if ((pass === 0) === hasParentColumn) continue;
      const summary = applyNamedFieldOfficeAnnex(graph, annex);
      if (summary.officeCount || summary.childCount) summaries.push(summary);
    }
  }
  if (summaries.length) {
    graph.meta.annexOrganizations = mergeAnnexOrganizationSummaries(graph.meta.annexOrganizations || [], summaries);
  }
  return graph;
}

// ---------------------------------------------------------------------------
// 범용 지방관서 별표: "○○의 명칭 및 위치(·관할구역)" 표를 기관 트리로 편입한다.
// 3열형(명칭|위치|관할), 4열형(소속|명칭|위치|관할)을 지원하고,
// 정원표·평가대상·과 단위 기구표와 국세청 전용 별표는 제외한다.
const FIELD_OFFICE_TITLE = /명칭.*(위치|소재지|관할)|관할구역/;
const FIELD_OFFICE_EXCLUDE = /정원|평가대상|공무원|기구|한시조직|계급/;

export function isNamedFieldOfficeAnnex(annex) {
  const title = normalizeAnnexTitle(annex?.title);
  if (!FIELD_OFFICE_TITLE.test(title)) return false;
  if (FIELD_OFFICE_EXCLUDE.test(title)) return false;
  if (/지방국세청|세무서/.test(title)) return false;
  return (annex?.rows || []).length > 0;
}

function fieldOfficeKinds(annexTitle) {
  const title = normalizeWhitespace(String(annexTitle || "")).replace(/[ㆍ‧∙･]/g, "·");
  const head = title.split(/의\s*(명칭|관할구역|위치)/)[0] || "";
  const kinds = head
    .split(/·|및|,/)
    .map((token) => token.replace(/^.*\s/, "").trim())
    .filter((token) => token.length >= 2 && /[가-힣]/.test(token));
  // "세관관서"처럼 총칭 접미어가 붙은 종별은 본딧말(세관)도 함께 허용한다.
  for (const kind of [...kinds]) {
    const stripped = kind.replace(/(관서|기관)$/, "");
    if (stripped.length >= 2 && stripped !== kind) kinds.push(stripped);
  }
  return kinds;
}

function isFieldOfficeHeaderRow(row) {
  return row.some((cell) => /명칭|위치|소재지|관할|소속/.test(cell)) && row.every((cell) => cell.length <= 12);
}

function matchesKind(name, kinds) {
  if (!name || name.length < 2 || name.length > 24) return false;
  if (!kinds.length) return true;
  return kinds.some((kind) => name.endsWith(kind) || (kind.length >= 3 && name.endsWith(kind.slice(-2))));
}

export function applyNamedFieldOfficeAnnex(graph, annex) {
  const source = annex.source || annex.title || annex.annex;
  const kinds = fieldOfficeKinds(annex.title);
  const summary = {
    annex: annex.annex,
    title: annex.title,
    type: "named-field-office",
    kinds,
    officeCount: 0,
    childCount: 0,
    skippedRows: 0,
  };
  const rows = normalizeAnnexRows(annex).filter((row) => !isFieldOfficeHeaderRow(row));
  for (const row of rows) {
    const cells = row.filter(Boolean);
    if (cells.length < 2) { summary.skippedRows += 1; continue; }
    // 4열형: [소속 상위기관, 명칭, 위치, 관할] — 첫 칸이 기존 노드명일 때
    const first = normalizeNodeName(cells[0]).replace(/\s+/g, "");
    const second = normalizeNodeName(cells[1] || "").replace(/\s+/g, "");
    const parentNode = cells.length >= 3 ? graph.nodeByName(first) : null;
    const isChildRow = Boolean(parentNode && matchesKind(second, kinds));
    const name = isChildRow ? second : first;
    if (!matchesKind(name, kinds)) { summary.skippedRows += 1; continue; }
    if (name.length > 20) { summary.skippedRows += 1; continue; }
    const location = cleanLocation(isChildRow ? cells[2] : cells[1]);
    const jurisdiction = normalizeWhitespace((isChildRow ? cells[3] : cells[2]) || "");
    const node = graph.addNode(name, {
      kind: "affiliated",
      forceKind: true,
      source,
      metadata: {
        affiliationType: "field-office",
        annex: annex.annex,
        annexTitle: annex.title,
        annexRole: "named-field-office",
        location,
        ...(jurisdiction ? { jurisdictionArea: jurisdiction } : {}),
        unitRole: "affiliated-institution",
      },
    });
    if (!node) { summary.skippedRows += 1; continue; }
    const parentId = isChildRow ? parentNode.id : graph.rootId;
    graph.addEdge(parentId, node.id, {
      type: "affiliated",
      source,
      metadata: {
        affiliationType: "field-office",
        annex: annex.annex,
        annexTitle: annex.title,
        annexRole: "named-field-office",
      },
    });
    if (isChildRow) summary.childCount += 1;
    else summary.officeCount += 1;
  }
  if (summary.officeCount || summary.childCount) {
    markGenericAffiliatedPlaceholders(graph, kinds);
  }
  return summary;
}

export function findAnnex(graph, annexLabel, { source } = {}) {
  const target = normalizeAnnexLabel(annexLabel);
  const matches = (graph.meta.annexes || []).filter((annex) => normalizeAnnexLabel(annex.annex) === target);
  if (!matches.length) return null;
  if (source) {
    const exact = matches.find((annex) => annex.source === source);
    if (exact) return exact;
  }
  return matches[0];
}

export function parseBoxTable(text) {
  const rows = [];
  let forceNewRow = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (isRowSeparator(line)) {
      forceNewRow = true;
      continue;
    }
    if (!/[┃│]/.test(line)) continue;
    if (/[┏┓┗┛┠┨┯┷┼━─]/.test(line)) continue;
    const firstBorder = line.search(/[┃│]/);
    const lastHeavy = line.lastIndexOf("┃");
    const lastLight = line.lastIndexOf("│");
    const lastBorder = Math.max(lastHeavy, lastLight);
    if (firstBorder < 0 || lastBorder <= firstBorder) continue;
    const normalized = line.slice(firstBorder, lastBorder + 1);
    if (!/[┃│]/.test(normalized)) continue;
    const cells = normalized
      .replace(/^[┃│]/, "")
      .replace(/[┃│]$/, "")
      .split(/[│┃]/)
      .map(cleanCell);
    if (!cells.some(Boolean)) continue;
    const startsNewUnseparatedRow = rows.length && !forceNewRow && startsNumberedRow(cells, rows.at(-1));
    if (rows.length && !forceNewRow && !startsNewUnseparatedRow) {
      const previous = rows.at(-1);
      cells.forEach((cell, index) => {
        if (!cell) return;
        previous[index] = previous[index] ? `${previous[index]} ${cell}` : cell;
      });
    } else {
      rows.push(cells);
    }
    forceNewRow = false;
  }
  return fillLeadingBlankCells(stripHeaderRows(rows));
}

function flattenAnnexUnits(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const units = [];
  for (const item of list) {
    if (Array.isArray(item?.["별표단위"])) units.push(...item["별표단위"]);
    else if (item?.["별표단위"]) units.push(item["별표단위"]);
    else units.push(item);
  }
  return units.filter(Boolean);
}

function annexText(unit) {
  const raw = unit?.["별표내용"] || unit?.["별표내용문자열"] || "";
  if (Array.isArray(raw)) return raw.flat(Infinity).map((line) => String(line ?? "")).join("\n");
  return String(raw || "");
}

function cleanCell(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/[┃│]/g, " ")
      .replace(/\s+/g, " "),
  );
}

function isRowSeparator(line) {
  const trimmed = String(line || "").trimStart();
  return /[┌┐└┘├┤┠┨┼┬┴┯┷─━]/.test(trimmed);
}

function startsNumberedRow(cells, previous) {
  return /^\d+(?:의\d+)?$/.test(cells[0] || "") && /^\d+(?:의\d+)?$/.test(previous?.[0] || "");
}

function stripHeaderRows(rows) {
  const result = [...rows];
  while (result.length && isHeaderRow(result[0])) result.shift();
  return result;
}

function isHeaderRow(row) {
  const text = row.join(" ");
  const nonEmpty = row.filter(Boolean).length;
  if (/(?:명칭|기관|직급|계|구분|위치|관할|소속|시ㆍ도|시·도|세무서명|국세청명)/.test(text)) return true;
  return nonEmpty <= 1 && /(?:국세청|기관|부서|과)$/.test(text.trim());
}

function fillLeadingBlankCells(rows) {
  const last = [];
  return rows.map((row) => {
    const filled = [...row];
    const firstNonEmpty = filled.findIndex(Boolean);
    if (firstNonEmpty > 0) {
      for (let index = 0; index < firstNonEmpty; index += 1) {
        if (!filled[index] && last[index]) filled[index] = last[index];
      }
    }
    filled.forEach((cell, index) => {
      if (cell) last[index] = cell;
    });
    return filled;
  });
}

function classifyAnnex(title, text) {
  const haystack = `${title}\n${text}`;
  if (/^\s*삭제\b|삭제\s*&lt;|삭제\s*</.test(haystack)) return "deleted";
  if (/평가대상/.test(haystack)) return "evaluation";
  if (/한시조직|한시정원/.test(haystack)) return "temporary-headcount";
  if (/정원표|직급별\s*정원|공무원\s*정원/.test(haystack)) return "headcount";
  if (/관할구역|위치|등급구분/.test(haystack)) return "jurisdiction";
  if (/소속(?:세무서|기관|관서)|두는\s+(?:과|부서|담당관)/.test(haystack)) return "organization-matrix";
  return "other";
}

function normalizeAnnexNumber(value) {
  const raw = String(value ?? "").replace(/^0+/, "").trim();
  if (!raw) return "1";
  const match = raw.match(/(\d+)(?:의(\d+))?/);
  if (!match) return raw;
  return match[2] ? `${Number(match[1])}의${Number(match[2])}` : String(Number(match[1]));
}

function normalizeAnnexLabel(value) {
  const match = String(value || "").match(/별표\s*(\d+(?:의\d+)?)/);
  return match ? `별표 ${normalizeAnnexNumber(match[1])}` : String(value || "").trim();
}

function isRegionalTaxOfficeAnnex(annex) {
  const title = normalizeAnnexTitle(annex?.title);
  return /지방국세청의\s*명칭.*위치.*소속세무서/.test(title);
}

function isRegionalJurisdictionAnnex(annex) {
  const title = normalizeAnnexTitle(annex?.title);
  return /지방국세청의\s*관할구역/.test(title);
}

function isTaxOfficeDepartmentMatrixAnnex(annex) {
  const title = normalizeAnnexTitle(annex?.title);
  return /세무서에\s*두는\s*과\s*단위\s*기구/.test(title);
}

function isTaxOfficeJurisdictionAnnex(annex) {
  const title = normalizeAnnexTitle(annex?.title);
  return !/지서/.test(title) && /세무서의\s*명칭.*위치.*관할구역/.test(title);
}

function isTaxOfficeBranchAnnex(annex) {
  const title = normalizeAnnexTitle(annex?.title);
  return /지서의\s*명칭.*위치.*관할구역/.test(title);
}

function applyRegionalTaxOfficeAnnex(graph, annex) {
  const rows = normalizeAnnexRows(annex);
  const source = annex.source || annex.title || annex.annex;
  const summary = {
    annex: annex.annex,
    title: annex.title,
    type: "regional-tax-office-tree",
    parentCount: 0,
    childCount: 0,
  };
  markGenericAffiliatedPlaceholders(graph, ["지방국세청", "세무서"]);
  for (const row of rows) {
    const regionalName = normalizeNodeName(row[0]);
    if (!regionalName || !/지방국세청$/.test(regionalName)) continue;
    const location = cleanLocation(row[1]);
    const regional = graph.addNode(regionalName, {
      kind: "affiliated",
      forceKind: true,
      source,
      metadata: {
        affiliationType: "special-local",
        annex: annex.annex,
        annexTitle: annex.title,
        annexRole: "regional-tax-office",
        location,
        unitRole: "affiliated-institution",
      },
    });
    if (!regional) continue;
    graph.addEdge(graph.rootId, regional.id, {
      type: "affiliated",
      source,
      metadata: {
        affiliationType: "special-local",
        annex: annex.annex,
        annexTitle: annex.title,
        annexRole: "regional-tax-office",
      },
    });
    summary.parentCount += 1;
    for (const officeName of splitTaxOfficeList(row[2])) {
      const office = graph.addNode(officeName, {
        kind: "affiliated",
        forceKind: true,
        source,
        metadata: {
          affiliationType: "special-local",
          annex: annex.annex,
          annexTitle: annex.title,
          annexRole: "tax-office",
          parentRegionalOffice: regionalName,
          unitRole: "affiliated-institution",
        },
      });
      if (!office) continue;
      graph.addEdge(regional.id, office.id, {
        type: "affiliated",
        source,
        metadata: {
          affiliationType: "special-local",
          annex: annex.annex,
          annexTitle: annex.title,
          annexRole: "tax-office",
        },
      });
      summary.childCount += 1;
    }
  }
  return summary;
}

function applyTaxOfficeJurisdictionAnnex(graph, annex) {
  const rows = normalizeAnnexRows(annex);
  const source = annex.source || annex.title || annex.annex;
  const summary = {
    annex: annex.annex,
    title: annex.title,
    type: "tax-office-jurisdiction",
    updatedCount: 0,
    skippedOffices: [],
  };
  for (const row of rows) {
    const officeName = normalizeTaxOfficeName(row[2]);
    if (!officeName) continue;
    const office = graph.nodeByName(officeName);
    if (!office) {
      summary.skippedOffices.push(officeName);
      continue;
    }
    graph.addNode(officeName, {
      kind: "affiliated",
      forceKind: true,
      source,
      metadata: {
        regionalOffice: normalizeRegionalOfficeName(row[0]),
        province: cleanLocation(row[1]),
        location: cleanLocation(row[3]),
        jurisdictionArea: cleanJurisdiction(row[4]),
        jurisdictionAnnex: annex.annex,
        jurisdictionAnnexTitle: annex.title,
      },
    });
    summary.updatedCount += 1;
  }
  summary.skippedOffices = uniq(summary.skippedOffices);
  return summary;
}

function applyTaxOfficeBranchAnnex(graph, annex) {
  const rows = normalizeAnnexRows(annex);
  const source = annex.source || annex.title || annex.annex;
  const summary = {
    annex: annex.annex,
    title: annex.title,
    type: "tax-office-branch-jurisdiction",
    branchCount: 0,
    skippedTaxOffices: [],
  };
  for (const row of rows) {
    const taxOfficeName = normalizeTaxOfficeName(row[2]);
    const branchName = normalizeBranchOfficeName(row[3]);
    if (!taxOfficeName || !branchName) continue;
    const taxOffice = graph.nodeByName(taxOfficeName);
    if (!taxOffice) {
      summary.skippedTaxOffices.push(taxOfficeName);
      continue;
    }
    const branch = graph.addNode(branchName, {
      id: `${taxOffice.id}/${branchName}`,
      kind: "affiliated",
      forceKind: true,
      source,
      metadata: {
        affiliationType: "special-local",
        annex: annex.annex,
        annexTitle: annex.title,
        annexRole: "tax-office-branch",
        parentTaxOffice: taxOfficeName,
        regionalOffice: normalizeRegionalOfficeName(row[0]),
        province: cleanLocation(row[1]),
        location: cleanLocation(row[4]),
        jurisdictionArea: cleanJurisdiction(row[5]),
        unitRole: "affiliated-institution",
        scoped: true,
      },
    });
    if (!branch) continue;
    graph.addEdge(taxOffice.id, branch.id, {
      type: "affiliated",
      source,
      metadata: {
        affiliationType: "special-local",
        annex: annex.annex,
        annexTitle: annex.title,
        annexRole: "tax-office-branch",
        scoped: true,
      },
    });
    summary.branchCount += 1;
  }
  summary.skippedTaxOffices = uniq(summary.skippedTaxOffices);
  return summary;
}

function applyTaxOfficeDepartmentMatrixAnnex(graph, annex) {
  const rows = normalizeAnnexRows(annex);
  const source = annex.source || annex.title || annex.annex;
  const summary = {
    annex: annex.annex,
    title: annex.title,
    type: "tax-office-department-matrix",
    groupCount: 0,
    officeCount: 0,
    departmentCount: 0,
    skippedOffices: [],
  };
  for (const row of rows) {
    const group = normalizeWhitespace(row[0]);
    const offices = splitTaxOfficeList(row[1]);
    const departments = splitDepartmentList(row[2]);
    if (!offices.length || !departments.length) continue;
    summary.groupCount += 1;
    for (const officeName of offices) {
      const office = graph.nodeByName(officeName);
      if (!office) {
        summary.skippedOffices.push(officeName);
        continue;
      }
      summary.officeCount += 1;
      office.metadata = {
        ...office.metadata,
        departmentMatrixGroup: group || null,
        departmentMatrixAnnex: annex.annex,
        departmentMatrixAnnexTitle: annex.title,
      };
      for (const departmentName of departments) {
        const department = graph.addNode(departmentName, {
          id: `${office.id}/${departmentName}`,
          kind: "assistant",
          forceKind: true,
          source,
          metadata: {
            annex: annex.annex,
            annexTitle: annex.title,
            annexRole: "tax-office-department",
            parentTaxOffice: officeName,
            matrixGroup: group || null,
            scoped: true,
            countsTowardStructure: false,
          },
        });
        if (!department) continue;
        graph.addEdge(office.id, department.id, {
          type: "assistant",
          source,
          metadata: {
            annex: annex.annex,
            annexTitle: annex.title,
            annexRole: "tax-office-department",
            matrixGroup: group || null,
            scoped: true,
          },
        });
        summary.departmentCount += 1;
      }
    }
  }
  summary.skippedOffices = uniq(summary.skippedOffices);
  return summary;
}

function applyRegionalJurisdictionAnnex(graph, annex) {
  const rows = normalizeAnnexRows(annex);
  const source = annex.source || annex.title || annex.annex;
  const summary = {
    annex: annex.annex,
    title: annex.title,
    type: "regional-tax-office-jurisdiction",
    updatedCount: 0,
  };
  for (const row of rows) {
    const regionalName = normalizeNodeName(row[0]);
    if (!regionalName || !/지방국세청$/.test(regionalName)) continue;
    const node = graph.nodeByName(regionalName);
    if (!node) continue;
    const location = cleanLocation(row[1]);
    const jurisdictionArea = cleanJurisdiction(row[2]);
    graph.addNode(regionalName, {
      kind: "affiliated",
      forceKind: true,
      source,
      metadata: {
        location: node.metadata?.location || location,
        jurisdictionArea,
        jurisdictionAnnex: annex.annex,
        jurisdictionAnnexTitle: annex.title,
      },
    });
    summary.updatedCount += 1;
  }
  return summary;
}

function normalizeAnnexRows(annex) {
  return (annex?.rows || [])
    .map((row) => row.map((cell) => normalizeWhitespace(cell)))
    .filter((row) => row.some(Boolean));
}

function normalizeAnnexTitle(title) {
  return normalizeWhitespace(title)
    .replace(/[ㆍ‧∙･·]/g, "·")
    .replace(/\s+/g, "");
}

function splitTaxOfficeList(value) {
  return uniq(
    normalizeWhitespace(value)
      .replace(/[ㆍ‧∙･·]/g, ",")
      .split(/\s*,\s*|\s+및\s+/)
      .map(normalizeTaxOfficeName),
  );
}

function normalizeTaxOfficeName(value) {
  const name = String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[.;:，、]/g, "")
    .trim();
  if (!name || /^(?:및|외|등)$/.test(name)) return "";
  if (/(?:세무서|지서)$/.test(name)) return name;
  return `${name}세무서`;
}

function normalizeRegionalOfficeName(value) {
  const name = String(value || "").replace(/\s+/g, "").trim();
  if (!name) return "";
  if (/(?:지방국세청)$/.test(name)) return name;
  return name;
}

function normalizeBranchOfficeName(value) {
  const name = String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[.;:，、]/g, "")
    .trim();
  if (!name || /^(?:및|외|등)$/.test(name)) return "";
  return name;
}

function splitDepartmentList(value) {
  return uniq(
    normalizeWhitespace(value)
      .split(/\s*,\s*|\s+및\s+/)
      .map(normalizeDepartmentUnitName),
  );
}

function normalizeDepartmentUnitName(value) {
  const name = String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[.;:，、]/g, "")
    .trim();
  if (!name || /^(?:및|외|등)$/.test(name)) return "";
  if (!/(?:과|팀|담당관|센터)$/.test(name)) return "";
  return name;
}

function cleanLocation(value) {
  const text = normalizeWhitespace(value);
  const compact = text.replace(/\s+/g, "");
  if (/^[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도)$/.test(compact)) return compact;
  return text.replace(/\s*([ㆍ·])\s*/g, "$1").replace(/\s*,\s*/g, ", ");
}

function cleanJurisdiction(value) {
  return normalizeWhitespace(value)
    .replace(/\s*([ㆍ·])\s*/g, "$1")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function markGenericAffiliatedPlaceholders(graph, names) {
  for (const name of names) {
    const node = graph.nodeByName(name);
    if (!node) continue;
    node.metadata = {
      ...node.metadata,
      placeholderFromAnnexRequirement: true,
      countsTowardStructure: false,
    };
    for (const edge of [...graph.edges.values()]) {
      if (edge.child === node.id && edge.parent === graph.rootId && edge.type === "affiliated") {
        graph.edges.delete(`${edge.parent}>${edge.child}`);
      }
    }
  }
}

function mergeAnnexOrganizationSummaries(existing, incoming) {
  const byKey = new Map();
  for (const item of [...existing, ...incoming]) {
    byKey.set(`${item.annex}|${item.title}|${item.type}`, item);
  }
  return [...byKey.values()];
}
