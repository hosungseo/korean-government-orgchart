import { stableId, uniq } from "./utils.mjs";

const KIND_PRIORITY = {
  institution: 100,
  head: 90,
  deputy: 80,
  affiliated: 70,
  temporary: 65,
  advisor: 60,
  assistant: 50,
  unit: 40,
  unknown: 0,
};

const EDGE_PRIORITY = {
  affiliated: 40,
  temporary: 35,
  advisor: 30,
  jurisdiction: 25,
  assistant: 20,
  structural: 10,
};

export class OrgGraph {
  static fromJSON(value) {
    return orgGraphFromJSON(value);
  }

  constructor({ institution = "행정기관", asOf, title } = {}) {
    this.meta = {
      institution,
      title: title || institution,
      asOf: asOf || null,
      warnings: [],
      validation: [],
      sources: [],
    };
    this.nodes = new Map();
    this.edges = new Map();
    this.aliases = new Map();
    this.rootId = this.addNode(institution, {
      kind: "institution",
      rank: 0,
      source: "inferred",
    }).id;
  }

  addWarning(message) {
    if (!this.meta.warnings.includes(message)) this.meta.warnings.push(message);
  }

  addValidationIssue(message) {
    if (!this.meta.validation.includes(message)) this.meta.validation.push(message);
  }

  addSource(source) {
    if (!source) return;
    this.meta.sources = uniq([...this.meta.sources, source]);
  }

  addNode(name, attrs = {}) {
    let cleanName = normalizeNodeName(name);
    cleanName = this.aliases.get(cleanName) || cleanName;
    if (!cleanName) return null;
    // Most legal units are globally identifiable by name. Annex matrices can
    // repeat the same displayed department under many affiliated institutions
    // (e.g. every tax office has its own "징세과").  In those cases callers
    // pass attrs.id as a qualified key while keeping node.name as the label.
    const id = stableId(attrs.id || cleanName);
    const existing = this.nodes.get(id);
    const hasExplicitKind = Boolean(attrs.kind);
    const incomingKind = attrs.kind || inferKind(cleanName);
    const incoming = {
      id,
      name: cleanName,
      kind: incomingKind,
      rank: attrs.rank ?? inferRank(cleanName, incomingKind),
      metadata: normalizeNodeMetadata(incomingKind, attrs.metadata),
      sources: attrs.source ? [attrs.source] : [],
    };
    if (!existing) {
      this.nodes.set(id, incoming);
      return incoming;
    }
    if (
      attrs.forceKind ||
      (hasExplicitKind &&
        (KIND_PRIORITY[incomingKind] || 0) > (KIND_PRIORITY[existing.kind] || 0))
    ) {
      existing.kind = incomingKind;
    }
    existing.rank = Math.min(existing.rank ?? 99, incoming.rank ?? 99);
    existing.metadata = { ...existing.metadata, ...incoming.metadata };
    existing.sources = uniq([...existing.sources, ...incoming.sources]);
    return existing;
  }

  nodeByName(name) {
    let normalized = normalizeNodeName(name);
    normalized = this.aliases.get(normalized) || normalized;
    return this.nodes.get(stableId(normalized));
  }

  addEdge(parentNameOrId, childNameOrId, attrs = {}) {
    const parent = this.resolveNode(parentNameOrId);
    const child = this.resolveNode(childNameOrId);
    if (!parent || !child || parent.id === child.id) return null;
    const key = `${parent.id}>${child.id}`;
    const type = attrs.type || "structural";
    // An explicit affiliation relation is stronger than an older/inferred
    // assistant kind.  Annex parsers and legacy JSON may know the relation
    // before they have a reliable node classification (for example, a
    // district branch whose name ends in "지소").  Normalize the node here so
    // every newly-built graph observes the same headquarters/subordinate
    // institution invariant as graphs loaded from JSON.
    if (type === "affiliated" && !["institution", "head", "deputy"].includes(child.kind)) {
      child.kind = "affiliated";
      child.metadata = normalizeNodeMetadata("affiliated", child.metadata);
    }
    const metadata = {
      ...(attrs.article || this._currentArticleRef ? { article: attrs.article || this._currentArticleRef } : {}),
      ...(attrs.evidenceText || this._currentEvidenceText ? { evidenceText: attrs.evidenceText || this._currentEvidenceText } : {}),
      ...(attrs.metadata || {}),
    };
    const existing = this.edges.get(key);
    if (existing) {
      if ((EDGE_PRIORITY[type] || 0) > (EDGE_PRIORITY[existing.type] || 0)) {
        existing.type = type;
      }
      existing.sources = uniq([...existing.sources, ...(attrs.source ? [attrs.source] : [])]);
      existing.metadata = { ...existing.metadata, ...metadata };
      return existing;
    }
    const edge = {
      id: `e-${stableId(key).slice(2)}`,
      parent: parent.id,
      child: child.id,
      type,
      sources: attrs.source ? [attrs.source] : [],
      metadata,
    };
    this.edges.set(key, edge);
    return edge;
  }

  resolveNode(nameOrId) {
    if (!nameOrId) return null;
    if (typeof nameOrId === "object" && nameOrId.id) return nameOrId;
    return this.nodes.get(nameOrId) || this.nodeByName(nameOrId);
  }

  childrenOf(nodeOrId, { types } = {}) {
    const node = this.resolveNode(nodeOrId);
    if (!node) return [];
    return [...this.edges.values()]
      .filter((edge) => edge.parent === node.id && (!types || types.includes(edge.type)))
      .map((edge) => ({ edge, node: this.nodes.get(edge.child) }))
      .filter((entry) => entry.node)
      .sort((a, b) => a.node.rank - b.node.rank || a.node.name.localeCompare(b.node.name, "ko"));
  }

  parentsOf(nodeOrId) {
    const node = this.resolveNode(nodeOrId);
    if (!node) return [];
    return [...this.edges.values()]
      .filter((edge) => edge.child === node.id)
      .map((edge) => ({ edge, node: this.nodes.get(edge.parent) }))
      .filter((entry) => entry.node);
  }

  descendantsOf(nodeOrId, { depth = Infinity } = {}) {
    const start = this.resolveNode(nodeOrId);
    if (!start) return [];
    const result = [];
    const seen = new Set([start.id]);
    const queue = [{ node: start, level: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (current.level >= depth) continue;
      for (const child of this.childrenOf(current.node)) {
        if (seen.has(child.node.id)) continue;
        seen.add(child.node.id);
        result.push(child.node);
        queue.push({ node: child.node, level: current.level + 1 });
      }
    }
    return result;
  }

  finalize({ headName, deputyName } = {}) {
    let head = headName ? this.addNode(headName, { kind: "head", rank: 1 }) : this.findHead();
    if (!head) {
      head = this.addNode(inferHeadTitle(this.meta.institution), { kind: "head", rank: 1, source: "inferred" });
    }
    this.addEdge(this.rootId, head.id, { type: "structural", source: "inferred" });

    if (deputyName) this.addNode(deputyName, { kind: "deputy", rank: 2 });
    let deputies = this.findDeputies();
    if (!deputies.length) {
      const inferred = inferDeputyTitle(this.meta.institution);
      if (inferred) this.addNode(inferred, { kind: "deputy", rank: 2, source: "inferred" });
      deputies = this.findDeputies();
    }
    const deputy = deputies[0] || null;
    const defaultOperationalParent = deputies.length === 1 ? deputy : head;
    for (const deputyNode of deputies) {
      this.addEdge(head.id, deputyNode.id, { type: "structural", source: "inferred" });
    }

    for (const edge of [...this.edges.values()]) {
      const child = this.nodes.get(edge.child);
      if (edge.parent !== this.rootId || !child) continue;
      if (child.id === head.id || child.kind === "affiliated") continue;
      this.edges.delete(`${edge.parent}>${edge.child}`);
      const explicitParents = this.parentsOf(child.id).filter(({ node }) => node.id !== this.rootId);
      if (explicitParents.length) continue;
      this.addEdge(defaultOperationalParent?.id || head.id, child.id, {
        type: edge.type === "structural" ? "assistant" : edge.type,
        source: edge.sources[0] || "inferred",
        metadata: edge.metadata,
      });
    }

    for (const node of this.nodes.values()) {
      if ([this.rootId, head.id, deputy?.id].includes(node.id)) continue;
      if (node.kind === "deputy") {
        this.addEdge(head.id, node.id, { type: "structural", source: "inferred" });
        continue;
      }
      if (this.parentsOf(node.id).length) continue;
      if (node.kind === "affiliated") {
        this.addEdge(this.rootId, node.id, { type: "affiliated", source: "inferred" });
      } else if (node.kind === "advisor") {
        this.addEdge(head.id, node.id, { type: "advisor", source: "inferred" });
      } else {
        this.addEdge(defaultOperationalParent?.id || head.id, node.id, {
          type: "assistant",
          source: "inferred",
        });
      }
    }

    this.removeCycles();
    return this;
  }

  validateLegalStructure() {
    this.meta.validation = [];
    this.meta.spanDiagnostics = [];
    for (const node of this.nodes.values()) {
      const children = this.childrenOf(node.id);
      if (/차관보$/.test(node.name) && children.length) {
        this.addValidationIssue(`차관보 밑에는 하부조직을 둘 수 없습니다: ${node.name}`);
      }
      if (node.kind === "affiliated" && node.metadata?.unitRole !== "affiliated-institution") {
        this.addValidationIssue(`소속기관 노드에 소속기관 표식이 없습니다: ${node.name}`);
      }
      if (node.kind === "affiliated" && node.metadata?.unitRole === "headquarters") {
        this.addValidationIssue(`본부와 소속기관 표식이 동시에 있습니다: ${node.name}`);
      }
      if (node.kind !== "affiliated" && node.metadata?.affiliationType) {
        this.addValidationIssue(`소속기관 유형이 보조·보좌 노드에 붙어 있습니다: ${node.name}`);
      }
    }

    for (const edge of this.edges.values()) {
      const parent = this.nodes.get(edge.parent);
      const child = this.nodes.get(edge.child);
      if (!parent || !child) continue;
      if (edge.type === "affiliated" && child.kind !== "affiliated") {
        this.addValidationIssue(`소속기관 연결선의 하위 노드가 소속기관이 아닙니다: ${parent.name} → ${child.name}`);
      }
      if (child.kind === "affiliated" && !["affiliated", "temporary"].includes(edge.type)) {
        this.addValidationIssue(`소속기관이 본부 계선·보좌 관계에 섞였습니다: ${parent.name} → ${child.name}`);
      }
      if (edge.type !== "assistant") continue;
      if (/실$/.test(parent.name) && /실$/.test(child.name)) {
        this.addValidationIssue(`실 밑에 실을 둔 관계를 확인해야 합니다: ${parent.name} → ${child.name}`);
      }
      if (/국$/.test(parent.name) && /국$/.test(child.name)) {
        this.addValidationIssue(`국 밑에 국을 둔 관계를 확인해야 합니다: ${parent.name} → ${child.name}`);
      }
    }

    for (const node of this.nodes.values()) {
      if (node.kind !== "advisor") continue;
      for (const { node: parent } of this.parentsOf(node.id)) {
        if (!/국$/.test(parent.name)) continue;
        const parentUnderOffice = this.parentsOf(parent.id).some(
          ({ edge, node: grandparent }) => edge.type === "assistant" && /실$/.test(grandparent.name),
        );
        if (parentUnderOffice) {
          this.addValidationIssue(
            `실 밑 국에는 국장 보좌기관을 둘 수 없습니다: ${parent.name} → ${node.name}`,
          );
        }
      }
    }

    // The corpus shows 3–6 direct departments as the usual bureau span. Keep
    // this as a diagnostic, not a legal violation: small and large bureaus
    // can both be valid under the decree.
    for (const node of this.nodes.values()) {
      if (!/국$/.test(node.name)) continue;
      const count = this.childrenOf(node.id).filter(({ node: child }) => /(?:과|팀|담당관)$/.test(child.name)).length;
      if (count < 3) {
        this.meta.spanDiagnostics.push({
          node: node.name,
          directUnits: count,
          status: "consolidation-candidate",
          message: "직속 과·팀이 3개 미만입니다.",
        });
      } else if (count > 9) {
        this.meta.spanDiagnostics.push({
          node: node.name,
          directUnits: count,
          status: "split-candidate",
          message: "직속 과·팀이 9개를 초과합니다.",
        });
      }
    }
    return this.meta.validation;
  }

  findHead() {
    return [...this.nodes.values()].find((node) => node.kind === "head");
  }

  findDeputy() {
    return [...this.nodes.values()].find((node) => node.kind === "deputy");
  }

  findDeputies() {
    return [...this.nodes.values()].filter((node) => node.kind === "deputy");
  }

  removeCycles() {
    const visiting = new Set();
    const visited = new Set();
    const walk = (nodeId) => {
      if (visiting.has(nodeId)) return;
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const { edge, node } of this.childrenOf(nodeId)) {
        if (visiting.has(node.id)) {
          this.edges.delete(`${edge.parent}>${edge.child}`);
          this.addWarning(`순환 관계를 제거했습니다: ${this.nodes.get(edge.parent)?.name} → ${node.name}`);
          continue;
        }
        walk(node.id);
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    walk(this.rootId);
  }

  toJSON() {
    return {
      meta: this.meta,
      rootId: this.rootId,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }
}

export function orgGraphFromJSON(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("OrgGraph JSON object is required.");
  }
  const meta = structuredClone(value.meta || {});
  const institution = meta.institution || meta.title || "행정기관";
  const graph = new OrgGraph({
    institution,
    asOf: meta.asOf,
    title: meta.title || institution,
  });
  graph.meta = {
    ...meta,
    institution,
    title: meta.title || institution,
    asOf: meta.asOf || null,
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    validation: Array.isArray(meta.validation) ? meta.validation : [],
    sources: Array.isArray(meta.sources) ? meta.sources : [],
  };
  graph.nodes = new Map();
  graph.edges = new Map();
  graph.aliases = new Map(Array.isArray(value.aliases) ? value.aliases : []);

  for (const rawNode of value.nodes || []) {
    if (!rawNode?.id || !rawNode?.name) continue;
    const kind = rawNode.kind || inferKind(rawNode.name);
    graph.nodes.set(rawNode.id, {
      id: rawNode.id,
      name: rawNode.name,
      kind,
      rank: rawNode.rank ?? inferRank(rawNode.name, kind),
      metadata: normalizeNodeMetadata(kind, rawNode.metadata),
      sources: Array.isArray(rawNode.sources) ? [...rawNode.sources] : [],
    });
  }

  let rootId = value.rootId && graph.nodes.has(value.rootId) ? value.rootId : null;
  if (!rootId) {
    rootId =
      [...graph.nodes.values()].find((node) => node.kind === "institution")?.id ||
      [...graph.nodes.values()].find((node) => node.name === institution)?.id ||
      null;
  }
  if (!rootId) {
    rootId = graph.addNode(institution, { kind: "institution", rank: 0, source: "inferred" }).id;
  }
  graph.rootId = rootId;

  for (const rawEdge of value.edges || []) {
    if (!rawEdge?.parent || !rawEdge?.child) continue;
    if (!graph.nodes.has(rawEdge.parent) || !graph.nodes.has(rawEdge.child)) continue;
    const key = `${rawEdge.parent}>${rawEdge.child}`;
    graph.edges.set(key, {
      id: rawEdge.id || `e-${stableId(key).slice(2)}`,
      parent: rawEdge.parent,
      child: rawEdge.child,
      type: rawEdge.type || "structural",
      sources: Array.isArray(rawEdge.sources) ? [...rawEdge.sources] : [],
      metadata: structuredClone(rawEdge.metadata || {}),
    });
  }

  normalizeLoadedAffiliationEdges(graph);

  return graph;
}

/**
 * Makes a rendering-only tree that groups departments under their confirmed
 * policy-officer/national-bureau jurisdiction.  The source graph remains the
 * legal installation model: an operational view must never overwrite it.
 */
export function projectOperationalView(graph) {
  const view = new OrgGraph({
    institution: graph.meta.institution,
    asOf: graph.meta.asOf,
    title: graph.meta.title,
  });
  view.meta = structuredClone(graph.meta);
  view.meta.renderView = "operational";
  view.nodes = new Map([...graph.nodes.entries()].map(([id, node]) => [id, structuredClone(node)]));
  view.edges = new Map([...graph.edges.entries()].map(([id, edge]) => [id, structuredClone(edge)]));
  view.aliases = new Map(graph.aliases);
  view.rootId = graph.rootId;

  for (const relation of graph.meta.jurisdictionRelations || []) {
    const parent = view.nodeByName(relation.parent);
    const child = view.nodeByName(relation.child);
    if (!parent || !child || parent.id === child.id) continue;
    // A confirmed jurisdiction replaces only the rendering parent.  The
    // original legal assistant edge stays in the source graph.
    for (const edge of [...view.edges.values()]) {
      if (edge.child === child.id && edge.type === "assistant") {
        view.edges.delete(`${edge.parent}>${edge.child}`);
      }
    }
    view.addEdge(parent.id, child.id, {
      type: "jurisdiction",
      source: relation.source,
      metadata: {
        evidence: relation.evidence,
        legalBasis: relation.legalBasis,
      },
    });
  }
  view.removeCycles();
  return view;
}

export function normalizeNodeName(value) {
  let name = String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(?:부|실|국|과|팀|관|원|소|본부|단|센터|분원|지소|사무소|정원|한시정원|고위공무원단|전문위원)$/.test(
      name,
    )
  ) {
    return "";
  }
  if (/\s/.test(name) && /(?:정원|등의|관한\s+통칙|소속\s+하에)/.test(name)) return "";
  if (/^(?:장관|차관|차장|위원장|부위원장|청장|처장|상임위원|비상임위원)$/.test(name)) return name;
  name = name
    .replace(/^(?:및|또는|각)\s+/, "")
    .replace(/\s*(?:각\s*)?\d+\s*명.*$/, "")
    .replace(/\s*(?:으로|로)\s*보.*$/, "")
    .trim();
  if (/^(?:실장|국장|과장|팀장|본부장|단장|원장|소장|관장|분원장|지소장|센터장)$/.test(name)) {
    return "";
  }
  name = name.replace(
    /(실|국|과|팀|본부|단|부|처|청|원|소|센터|사무국|사무소|학교|박물관|미술관|도서관|연구원|기록관|분원|지소)장$/,
    "$1",
  );
  return name.trim();
}

export function inferKind(name) {
  if (/^(?:장관|청장|처장|위원장)$/.test(name)) return "head";
  if (/^(?:차관|차장|부위원장|제\d+차관)$/.test(name)) return "deputy";
  if (/(?:정책보좌관|차관보|대변인|감사관|기획관|정책관|심의관|담당관|보좌관|상임위원|비상임위원)$/.test(name)) return "advisor";
  if (name === "사무처") return "assistant";
  if (name === "이북5도") return "affiliated";
  if (/(?:연구원|박물관|미술관|도서관|극장|전당|세무서|소방서|학교|교육원|개발원|기록원|관리원|사무소|위원회|청|처)$/.test(name)) return "affiliated";
  if (/(?:실|국|본부|단|부|과|팀|관|센터|사무국|원|소)$/.test(name)) return "assistant";
  return "unknown";
}

function normalizeNodeMetadata(kind, metadata = {}) {
  const normalized = { ...metadata };
  // Older saved graphs recorded the affiliation type but not the explicit
  // unit role. Keep those files semantically equivalent to newly parsed
  // graphs so renderers and audits can reliably separate the headquarters
  // tree from subordinate institutions.
  if (kind === "affiliated" && !normalized.unitRole) {
    normalized.unitRole = "affiliated-institution";
  }
  return normalized;
}

function normalizeLoadedAffiliationEdges(graph) {
  for (const edge of graph.edges.values()) {
    const child = graph.nodes.get(edge.child);
    if (!child) continue;
    if (edge.type === "affiliated" && !["institution", "head", "deputy"].includes(child.kind)) {
      child.kind = "affiliated";
      child.metadata = normalizeNodeMetadata("affiliated", child.metadata);
    }
    if (edge.type === "affiliated" && edge.metadata?.affiliationType && !child.metadata.affiliationType) {
      child.metadata.affiliationType = edge.metadata.affiliationType;
      child.metadata.responsible ||= edge.metadata.affiliationType === "responsible";
    }
  }
}

export function inferRank(name, kind = inferKind(name)) {
  if (kind === "institution") return 0;
  if (kind === "head") return 1;
  if (kind === "deputy") return 2;
  if (/(?:실|본부)$/.test(name)) return 3;
  if (/(?:국|관|단|부)$/.test(name)) return 4;
  if (/(?:과|팀|담당관|센터)$/.test(name)) return 5;
  if (kind === "affiliated") return 3;
  return 4;
}

export function inferHeadTitle(institution) {
  if (/위원회$/.test(institution)) return "위원장";
  if (/청$/.test(institution)) return "청장";
  if (/처$/.test(institution)) return "처장";
  return "장관";
}

export function inferDeputyTitle(institution) {
  if (/위원회$/.test(institution)) return "부위원장";
  if (/(?:청|처)$/.test(institution)) return "차장";
  return "차관";
}

/**
 * Returns the organization-table counts used by the 2026 government-chart
 * convention. These are unit counts, not personnel headcounts. Personnel
 * totals still require the relevant annex or operating-headcount table.
 */
export function summarizeStructure(graph) {
  const rootId = graph.rootId;
  const excluded = (node) =>
    node.id === rootId ||
    node.kind === "head" ||
    node.kind === "deputy" ||
    node.metadata?.countsTowardStructure === false ||
    (node.metadata?.concurrentOffice && /사무처|사무총장/.test(node.name));
  const nodes = [...graph.nodes.values()].filter((node) => !excluded(node));
  const countBy = (predicate) => nodes.filter(predicate).length;
  const line = countBy((node) => ["assistant", "temporary"].includes(node.kind));
  const staff = countBy((node) => node.kind === "advisor");
  const affiliated = countBy((node) => node.kind === "affiliated");
  const affiliatedByLevel = {};
  let affiliatedDepthMax = 0;
  for (const node of nodes.filter((candidate) => candidate.kind === "affiliated")) {
    const level = affiliationLevel(graph, node);
    if (!level) continue;
    const bucket = level > 3 ? "4+" : String(level);
    affiliatedByLevel[bucket] = (affiliatedByLevel[bucket] || 0) + 1;
    affiliatedDepthMax = Math.max(affiliatedDepthMax, level);
  }
  const grade = (value) => countBy((node) => node.metadata?.grade === value);
  const rank = (value) => countBy((node) => node.metadata?.gradeRange === value);
  const staffing = {
    knownUnits: nodes.length,
    grade: { 가: grade("가"), 나: grade("나") },
    gradeRange: {
      "3.4급": rank("3.4급"),
      "4급": rank("4급"),
      "4.5급": rank("4.5급"),
    },
    staffCategories: Object.fromEntries(
      ["일반직", "연구직", "지도직", "전문직", "전문경력관", "임기제", "별정직", "특정직"].map(
        (category) => [category, countBy((node) => node.metadata?.staffCategories?.includes(category))],
      ),
    ),
  };
  return {
    unitCounts: {
      line,
      staff,
      affiliated,
      affiliatedByLevel,
      affiliatedDepthMax,
      total: line + staff + affiliated,
    },
    staffing,
    countingRules: {
      temporaryIncluded: true,
      payrollIncluded: true,
      autonomousIncluded: false,
      deputyExcluded: true,
      policyAssistantExcluded: true,
      commissionSecretariatExcluded: true,
      note: "단위기관 수이며 운영정원·직급별 정원은 별표 또는 운영정원표를 별도로 읽어야 합니다.",
    },
  };
}

/**
 * Returns the legal affiliation depth used by the government organization
 * tables (1차·2차·3차 소속기관).  The graph can contain operational or
 * legacy edges in addition to explicit affiliation edges, so the node kind is
 * the primary signal and any affiliated ancestor increments the level.
 */
function affiliationLevel(graph, node) {
  if (node.kind !== "affiliated") return 0;
  let level = 1;
  let current = node;
  const seen = new Set([node.id]);
  while (true) {
    const parent = graph
      .parentsOf(current.id)
      .map(({ node: candidate }) => candidate)
      .find((candidate) => candidate?.kind === "affiliated");
    if (!parent || seen.has(parent.id)) return level;
    seen.add(parent.id);
    level += 1;
    current = parent;
  }
}
