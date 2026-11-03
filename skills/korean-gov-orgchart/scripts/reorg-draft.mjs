/**
 * Reverse direction for local-government reorganizations: target org chart →
 * amended 행정기구 설치 조례·시행규칙 text, 개정문 and 신구조문대비표.
 *
 * The target is an indented outline (one unit per line, `[보좌]`/`[소속]` tags,
 * `(← 옛이름)` for renames). The current texts are edited in place — lists in
 * "…에 A, B를 둔다" sentences are rewritten, new 국 get a new article, abolished
 * 국 become "제N조 삭제" — and the result is parsed again to confirm it draws the
 * target chart. Anything the chart cannot decide (분장사무, 직급) is left as a
 * visible placeholder and reported as a todo.
 */
import { parseOrganizationTexts } from "./parser.mjs";
import { projectOperationalView } from "./model.mjs";

export const PLACEHOLDER_DUTY = "[분장사무 작성 필요]";
export const PLACEHOLDER_GRADE = "[직급 작성 필요]";
const TAGS = { 보좌: "advisor", 소속: "affiliated" };
const TAG_OF = { advisor: "보좌", affiliated: "소속" };

// ---------------------------------------------------------------- structure

/** Parse 조례·시행규칙 text and return the drawn hierarchy as a tree. */
export function readStructure({ decreeText = "", ruleText = "", institution } = {}) {
  const texts = [decreeText, ruleText].filter((text) => String(text).trim());
  const legal = parseOrganizationTexts(texts, institution ? { institution } : {});
  const graph = projectOperationalView(legal);
  const root = graph.nodes.get(graph.rootId);
  const seen = new Set([root.id]);
  const walk = (node) => graph.childrenOf(node).filter(({ node: child }) => !seen.has(child.id)).map(({ edge, node: child }) => {
    seen.add(child.id);
    return { name: child.name, type: edge.type, children: walk(child) };
  });
  return { name: root.name, type: "root", children: walk(root) };
}

/** Tree → editable outline text (2-space indent). */
export function formatOutline(tree) {
  const lines = [
    "# 개편안 작성법: 한 줄에 한 기구, 들여쓰기(2칸)로 상하 관계를 적습니다.",
    "# [보좌] = 보좌기관(점선), [소속] = 직속기관·사업소·하부기관. 이름을 바꾸면 '새이름 (← 옛이름)'.",
    "# 없앨 기구는 줄을 지우고, 새 기구는 줄을 추가하고, 옮길 기구는 다른 상위 밑으로 옮깁니다.",
  ];
  const visit = (node, depth) => {
    const tag = TAG_OF[node.type] ? ` [${TAG_OF[node.type]}]` : "";
    lines.push(`${"  ".repeat(depth)}${node.name}${tag}`);
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(tree, 0);
  return `${lines.join("\n")}\n`;
}

/** Outline text → tree. Each node may carry `from` (rename source). */
export function parseOutline(text) {
  const entries = [];
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length;
    let body = raw.trim().replace(/^[-*·ㆍ•]\s*/, "");
    let from = null;
    body = body.replace(/\(\s*(?:←|<-|<=|구|舊|기존)\s*([^)]+?)\s*\)/, (_, name) => {
      from = name.trim();
      return "";
    });
    let tag = null;
    body = body.replace(/\[\s*([^\]]+?)\s*\]/g, (_, value) => {
      if (TAGS[value]) tag = TAGS[value];
      return "";
    });
    const name = body.replace(/\s+/g, "");
    if (name) entries.push({ indent, name, tag, from });
  }
  if (!entries.length) throw new Error("개편안 개요가 비어 있습니다.");
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`같은 이름이 두 번 나옵니다: ${entry.name}`);
    seen.add(entry.name);
  }
  const root = { name: entries[0].name, type: "root", children: [], indent: entries[0].indent };
  const stack = [root];
  for (const entry of entries.slice(1)) {
    while (stack.length > 1 && stack.at(-1).indent >= entry.indent) stack.pop();
    const parent = stack.at(-1);
    if (entry.indent <= parent.indent) throw new Error(`들여쓰기를 확인하세요: "${entry.name}"`);
    const node = { name: entry.name, type: entry.tag || inferType(entry.name, parent), children: [], indent: entry.indent };
    if (entry.from) node.from = entry.from;
    parent.children.push(node);
    stack.push(node);
  }
  const strip = (node) => {
    delete node.indent;
    node.children.forEach(strip);
    return node;
  };
  return strip(root);
}

function inferType(name, parent) {
  if (/담당관$/.test(name)) return "advisor";
  if (parent.type === "root") return /^(?:시장|군수|구청장|도지사)$/.test(name) ? "structural" : "affiliated";
  if (/^(?:부시장|부군수|부구청장|행정부지사|행정부시장)$/.test(name)) return "structural";
  return "assistant";
}

function flatten(tree) {
  const nodes = new Map();
  const visit = (node, parent) => {
    if (nodes.has(node.name)) throw new Error(`같은 이름이 두 번 나옵니다: ${node.name}`);
    nodes.set(node.name, { ...node, parent: parent?.name ?? null, children: node.children.map((child) => child.name) });
    node.children.forEach((child) => visit(child, node));
  };
  visit(tree, null);
  return nodes;
}

// ---------------------------------------------------------------- changes

/** Compare two trees and classify every change. */
export function planChanges(currentTree, targetTree) {
  const current = flatten(currentTree);
  const target = flatten(targetTree);
  const renames = [];
  for (const node of target.values()) {
    if (node.from && node.from !== node.name) {
      if (!current.has(node.from)) throw new Error(`'${node.name} (← ${node.from})': 현행 조직에 ${node.from}이(가) 없습니다.`);
      renames.push({ from: node.from, to: node.name });
    }
  }
  const renamed = new Map(renames.map(({ from, to }) => [from, to]));
  const now = (name) => renamed.get(name) || name;
  const currentNow = new Map([...current.values()].map((node) => [now(node.name), { ...node, name: now(node.name), parent: node.parent && now(node.parent), children: node.children.map(now) }]));
  const created = [...target.values()].filter((node) => !currentNow.has(node.name)).map((node) => ({ name: node.name, parent: node.parent, type: node.type }));
  const abolished = [...currentNow.values()].filter((node) => !target.has(node.name)).map((node) => ({ name: node.name, parent: node.parent, type: node.type }));
  const moved = [...target.values()]
    .filter((node) => currentNow.has(node.name) && currentNow.get(node.name).parent !== node.parent)
    .map((node) => ({ name: node.name, from: currentNow.get(node.name).parent, to: node.parent, type: node.type }));
  // A group is one installing sentence: the children of one parent with one relation type.
  const groupsOf = (nodes) => {
    const groups = new Map();
    for (const node of nodes.values()) {
      if (!node.parent) continue;
      const key = `${node.parent}|${groupType(node)}`;
      if (!groups.has(key)) groups.set(key, { parent: node.parent, type: groupType(node), names: [] });
      groups.get(key).names.push(node.name);
    }
    return groups;
  };
  const orderIn = (nodes) => (group) => {
    const parent = nodes.get(group.parent);
    const order = parent ? parent.children : [];
    group.names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return group;
  };
  const before = new Map([...groupsOf(currentNow)].map(([key, group]) => [key, orderIn(currentNow)(group)]));
  const after = new Map([...groupsOf(target)].map(([key, group]) => [key, orderIn(target)(group)]));
  const groups = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key)?.names || [];
    const next = after.get(key)?.names || [];
    if (old.join("|") !== next.join("|")) {
      const { parent, type } = before.get(key) || after.get(key);
      groups.push({ parent, type, before: old, after: next });
    }
  }
  return { renames, created, abolished, moved, groups, current, target, currentNow };
}

function groupType(node) {
  if (node.type === "advisor") return "advisor";
  if (node.type === "affiliated") return "affiliated";
  return "line";
}

// ---------------------------------------------------------------- drafting

/**
 * Edit the current texts toward the target tree.
 * Returns amended texts, the change plan, todos and a verification report.
 */
export function draftAmendment({ decreeText, ruleText, target, institution, effectiveNote } = {}) {
  const currentTree = readStructure({ decreeText, ruleText, institution });
  const targetTree = typeof target === "string" ? parseOutline(target) : target;
  const plan = planChanges(currentTree, targetTree);
  const todos = [];
  const docs = { decree: String(decreeText || ""), rule: String(ruleText || "") };
  const note = effectiveNote || "";

  // 1. Renames: every mention, including 「…과장」 and article titles.
  for (const { from, to } of [...plan.renames].sort((a, b) => b.from.length - a.from.length)) {
    const pattern = new RegExp(`(?<![가-힣])${escapeRegExp(from)}`, "g");
    for (const key of Object.keys(docs)) docs[key] = docs[key].replace(pattern, to);
    if (/담당관$/.test(to)) todos.push(`시행규칙의 ${to} 조문에서 "…업무에 관하여" 부분이 새 명칭과 맞는지 확인하세요.`);
  }

  const abolishedNames = new Set(plan.abolished.map((node) => node.name));
  const createdNames = new Set(plan.created.map((node) => node.name));
  const deputy = [...plan.target.values()].find((node) => node.type === "structural" && plan.target.get(node.parent)?.type === "structural");
  const isBureau = (name, nodes) => {
    const node = nodes.get(name);
    return Boolean(node) && node.type === "assistant" && nodes.get(node.parent)?.type === "structural";
  };

  // 2. Rewrite each installing list.
  for (const group of plan.groups) {
    if (!group.before.length) continue; // new holder — handled below
    const replaced = rewriteList(docs, group);
    if (!replaced) {
      todos.push(`"${group.parent}"의 ${group.type === "advisor" ? "보좌기관" : "하부조직"} 목록(${group.before.join(", ")})을 문언에서 찾지 못했습니다. ${group.after.length ? `"${group.after.join(", ")}"로 직접 고치세요.` : "직접 삭제하세요."}`);
    }
  }

  // 3. 과 leaving a 국 (abolished or moved): remember their 직급, then take them out of
  //    the old 직급 sentence before any new article is written.
  const leaving = [
    ...plan.abolished.filter((item) => item.type !== "advisor" && !isBureau(item.name, plan.currentNow)),
    ...plan.moved.filter((item) => item.type !== "advisor"),
  ];
  const carriedGrades = new Map();
  for (const item of leaving) {
    const grade = extractGrade(docs.rule, item.name);
    if (grade) carriedGrades.set(item.name, grade);
    docs.rule = removeFromGradeLists(docs.rule, item.name);
  }

  // 4. New 국 with their own article; abolished 국 → 삭제.
  const targetBureaus = (deputy ? plan.target.get(deputy.name).children : []).filter((name) => isBureau(name, plan.target));
  for (const name of targetBureaus.filter((bureau) => createdNames.has(bureau))) {
    const node = plan.target.get(name);
    const units = node.children.filter((child) => plan.target.get(child).type !== "advisor" && plan.target.get(child).type !== "affiliated");
    const previous = targetBureaus.slice(0, targetBureaus.indexOf(name)).reverse().find((bureau) => findArticle(docs.decree, `${bureau}에 두는 과`));
    const decreeArticle = [
      `(${name}에 두는 과) `,
      ...(units.length ? [`① ${name}에 ${joinWithParticle(units)} 둔다.`] : []),
      `${units.length ? "②" : "①"} ${name}장은 다음 사항을 분장한다.`,
      `1. ${PLACEHOLDER_DUTY}`,
    ];
    const anchor = previous ? findArticle(docs.decree, `${previous}에 두는 과`) : lastArticleMatching(docs.decree, /에 두는 과\)/);
    if (anchor) {
      docs.decree = insertArticleAfter(docs.decree, anchor, decreeArticle);
      todos.push(`조례 신설 조문의 ${name}장 분장사항을 작성하세요.`);
    } else {
      todos.push(`${name} 조문을 넣을 자리를 찾지 못했습니다. 조례에 "${name}에 두는 과" 조문을 직접 추가하세요.`);
    }
    // 시행규칙: 직급 조문 (절 heading + article) after the previous 국's article.
    const ruleAnchor = previous ? findArticle(docs.rule, previous) : null;
    if (ruleAnchor) {
      const grades = units.map((unit) => ({ name: unit, grade: carriedGrades.get(unit) }));
      docs.rule = insertArticleAfter(docs.rule, ruleAnchor, [
        `(${name}) 국장은 ${withParticle(PLACEHOLDER_GRADE, "으로", "로")} 보하고${grades.length ? `, ${gradeClauses(grades)}` : ""} 보한다.`,
      ], { section: name });
      const missing = grades.filter((item) => !item.grade).map((item) => `${item.name}장`);
      todos.push(`시행규칙 신설 조문의 ${name}장${missing.length ? `·${missing.join("·")}` : ""} 직급을 작성하세요.`);
    } else if (docs.rule.trim()) {
      todos.push(`시행규칙에 ${name}의 국장·과장 직급 조문을 추가하세요.`);
    }
  }
  for (const node of plan.abolished.filter((item) => isBureau(item.name, plan.currentNow))) {
    const article = findArticle(docs.decree, `${node.name}에 두는 과`);
    if (article) docs.decree = deleteArticle(docs.decree, article, note);
    const ruleArticle = findArticle(docs.rule, node.name);
    if (ruleArticle) docs.rule = deleteArticle(docs.rule, ruleArticle, note, { section: node.name });
  }

  // 5. 담당관: new → 시행규칙 article with placeholders; abolished → 삭제.
  for (const node of plan.created.filter((item) => item.type === "advisor")) {
    // Right after the 담당관 that precedes it under the same 기관장·부기관장, else after the last 담당관.
    const siblings = plan.target.get(node.parent)?.children.filter((name) => plan.target.get(name)?.type === "advisor") || [];
    const previous = siblings.slice(0, siblings.indexOf(node.name)).reverse().find((name) => findArticle(docs.rule, name));
    const anchor = (previous && findArticle(docs.rule, previous)) || lastArticleMatching(docs.rule, /담당관\)/);
    if (!anchor) {
      if (docs.rule.trim()) todos.push(`시행규칙에 ${node.name}의 직급·보좌 조문을 추가하세요.`);
      continue;
    }
    docs.rule = insertArticleAfter(docs.rule, anchor, [
      `(${node.name}) ${withParticle(node.name, "은", "는")} ${withParticle(PLACEHOLDER_GRADE, "으로", "로")} 보하며 ${PLACEHOLDER_DUTY}에 관하여 ${withParticle(node.parent, "을", "를")} 보좌한다.`,
    ]);
    todos.push(`시행규칙 신설 조문의 ${node.name} 직급과 보좌 업무를 작성하세요.`);
  }
  for (const node of plan.abolished.filter((item) => item.type === "advisor")) {
    const article = findArticle(docs.rule, node.name);
    if (article) docs.rule = deleteArticle(docs.rule, article, note);
  }

  // 6. 과 that arrived in an existing 국 (created or moved in): add a 직급 clause there.
  const arriving = [
    ...plan.created.filter((item) => item.type === "assistant" && !isBureau(item.name, plan.target)),
    ...plan.moved.filter((item) => item.type === "assistant"),
  ].filter((item) => !createdNames.has(item.parent ?? item.to));
  const byHolder = new Map();
  for (const item of arriving) {
    const holder = item.parent ?? item.to;
    if (!byHolder.has(holder)) byHolder.set(holder, []);
    byHolder.get(holder).push(item.name);
  }
  for (const [holder, names] of byHolder) {
    const order = plan.target.get(holder)?.children || [];
    names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const siblings = order.filter((name) => !names.includes(name));
    const items = names.map((name) => ({ name, grade: carriedGrades.get(name) }));
    const article = findArticle(docs.rule, holder) || articleMentioning(docs.rule, siblings.map((name) => `${name}장`));
    if (article) {
      docs.rule = addGradeClause(docs.rule, article, gradeClauses(items), siblings.map((name) => `${name}장`));
      const missing = items.filter((item) => !item.grade).map((item) => `${item.name}장`);
      if (missing.length) todos.push(`시행규칙 ${holder} 직급 조문에 추가한 ${missing.join("·")} 직급을 작성하세요.`);
    } else if (docs.rule.trim()) {
      todos.push(`시행규칙에서 ${holder} 직급 조문을 찾지 못했습니다. ${names.map((name) => `${name}장`).join("·")} 직급을 직접 추가하세요.`);
    }
  }
  for (const item of plan.moved.filter((entry) => entry.type === "assistant")) {
    todos.push(`${withParticle(item.name, "이", "가")} ${item.from}에서 ${withParticle(item.to, "으로", "로")} 옮겨졌습니다. 조례의 두 국장 분장사항을 조정하세요.`);
  }
  for (const name of abolishedNames) {
    const left = [...Object.entries(docs)].flatMap(([key, text]) => (new RegExp(`(?<![가-힣])${escapeRegExp(name)}`).test(stripDeleted(text)) ? [key === "decree" ? "조례" : "시행규칙"] : []));
    if (left.length) todos.push(`폐지한 ${withParticle(name, "이", "가")} ${left.join("·")} 문언에 아직 남아 있습니다. 확인하세요.`);
  }
  if (plan.renames.length || plan.created.length || plan.abolished.length || plan.moved.length) {
    todos.push("시행규칙 별표 1(사무분장)은 HWP 첨부라 고치지 않았습니다. 바뀐 기구에 맞게 사무분장을 고치세요.");
    todos.push("기구 신설·폐지에 따른 「지방공무원 정원 조례」 개정이 필요한지 확인하세요.");
  }

  const verification = verifyDraft({ decreeText: docs.decree, ruleText: docs.rule, institution, target: targetTree });
  return {
    plan: summarizePlan(plan),
    amended: { decreeText: docs.decree, ruleText: docs.rule },
    todos,
    verification,
  };
}

function summarizePlan(plan) {
  return {
    renames: plan.renames,
    created: plan.created,
    abolished: plan.abolished,
    moved: plan.moved,
  };
}

/** Parse the amended texts again and compare the drawn tree with the target. */
export function verifyDraft({ decreeText, ruleText, institution, target }) {
  const drawn = flatten(readStructure({ decreeText, ruleText, institution }));
  const wanted = flatten(typeof target === "string" ? parseOutline(target) : target);
  const problems = [];
  for (const node of wanted.values()) {
    if (!node.parent) continue;
    const got = drawn.get(node.name);
    if (!got) problems.push(`${node.name}: 개정안 문언에서 읽히지 않습니다.`);
    else if (got.parent !== node.parent) problems.push(`${node.name}: ${node.parent} 밑이어야 하는데 ${got.parent} 밑으로 읽힙니다.`);
  }
  for (const node of drawn.values()) {
    if (node.parent && !wanted.has(node.name)) problems.push(`${node.name}: 개편안에 없는데 개정안 문언에 남아 있습니다.`);
  }
  for (const node of wanted.values()) {
    const got = drawn.get(node.name);
    if (!got || !node.children.length) continue;
    const order = got.children.filter((name) => node.children.includes(name));
    const expected = node.children.filter((name) => order.includes(name));
    if (order.join("|") !== expected.join("|")) problems.push(`${node.name} 밑 순서: 개편안 ${expected.join(", ")} / 개정안 ${order.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, units: wanted.size - 1 };
}

// ---------------------------------------------------------------- text surgery

function rewriteList(docs, group) {
  const list = group.before.map(escapeRegExp).join("\\s*,\\s*");
  const holder = escapeRegExp(group.parent);
  const prefix = `(?:${holder}장?\\s*(?:밑에|에)|위하여)\\s*`;
  const pattern = new RegExp(`(${prefix})(${list})(\\s*(?:을|를)(?=\\s*(?:둔다|설치한다|둘\\s*수))|(?=\\s*,\\s*[가-힣]+\\s*밑에))`);
  for (const key of ["decree", "rule"]) {
    const match = docs[key].match(pattern);
    if (!match) continue;
    const [whole, lead, , tail] = match;
    let replacement;
    if (!group.after.length) {
      // Holder lost all its units in a multi-holder sentence: drop "X 밑에 …, ".
      replacement = "";
      const start = match.index;
      const rest = docs[key].slice(start + whole.length).replace(/^\s*,\s*/, "");
      docs[key] = docs[key].slice(0, start) + rest;
      return true;
    }
    const names = group.after.join(", ");
    replacement = tail.trim() ? `${lead}${names}${particle(group.after.at(-1), "을", "를")}` : `${lead}${names}`;
    docs[key] = docs[key].slice(0, match.index) + replacement + docs[key].slice(match.index + whole.length);
    return true;
  }
  return false;
}

const ARTICLE_LINE = /^(제(\d+)조(?:의(\d+))?)\s*(?:\(([^)]*)\)|(삭제))/;

function articleBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  let chapter = "";
  let section = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const head = trimmed.match(ARTICLE_LINE);
    const chapterHead = trimmed.match(/^(제\d+장(?:의\d+)?)\s/);
    const sectionHead = trimmed.match(/^(제\d+절(?:의\d+)?)\s/);
    if (chapterHead) {
      chapter = chapterHead[1];
      section = null;
    }
    if (sectionHead) section = { key: sectionHead[1], line: trimmed, index };
    if (head || chapterHead || sectionHead) {
      if (current) current.end = index;
      current = head ? { key: head[1], number: Number(head[2]), branch: Number(head[3] || 0), title: head[4] || "", start: index, chapter, section } : null;
      if (current) blocks.push(current);
    }
  });
  if (current) current.end = lines.length;
  return { lines, blocks };
}

function findArticle(text, title) {
  if (!text) return null;
  return articleBlocks(text).blocks.find((block) => block.title.trim() === title) || null;
}

function lastArticleMatching(text, pattern) {
  if (!text) return null;
  return articleBlocks(text).blocks.filter((block) => pattern.test(`(${block.title})`)).at(-1) || null;
}

function insertArticleAfter(text, anchor, contentLines, { section } = {}) {
  const { lines, blocks } = articleBlocks(text);
  const used = new Set(blocks.map((block) => block.key));
  let branch = 2;
  while (used.has(`제${anchor.number}조의${branch}`)) branch += 1;
  const key = `제${anchor.number}조의${branch}`;
  const insertion = [`${key}${contentLines[0]}`, ...contentLines.slice(1)];
  if (section) {
    // Section heading: same numbering as the anchor's section, with 의N.
    const heading = lines.slice(0, anchor.start).reverse().find((line) => /^제\d+절(?:의\d+)?\s/.test(line.trim()));
    const base = heading?.trim().match(/^제(\d+)절/)?.[1];
    if (base) {
      let sectionBranch = 2;
      while (lines.some((line) => line.trim().startsWith(`제${base}절의${sectionBranch} `))) sectionBranch += 1;
      insertion.unshift(`제${base}절의${sectionBranch} ${section}`);
    }
  }
  lines.splice(anchor.end, 0, ...insertion);
  return lines.join("\n");
}

function deleteArticle(text, article, note, { section } = {}) {
  const { lines } = articleBlocks(text);
  const suffix = note ? ` <${note}>` : "";
  lines.splice(article.start, article.end - article.start, `${article.key} 삭제${suffix}`);
  if (section) {
    const index = lines.slice(0, article.start).findLastIndex((line) => new RegExp(`^제\\d+절(?:의\\d+)?\\s+${escapeRegExp(section)}\\s*$`).test(line.trim()));
    if (index >= 0) lines[index] = `${lines[index].trim().match(/^제\d+절(?:의\d+)?/)[0]} 삭제${suffix}`;
  }
  return lines.join("\n");
}

// Put "X과장은 G으로" into the article's 직급 sentence, before its closing "보한다".
// Prefers the line that already names a sibling 과장.
function addGradeClause(text, article, clause, siblingTitles = []) {
  const { lines } = articleBlocks(text);
  const candidates = [];
  for (let index = article.start; index < article.end; index += 1) {
    if (/(으로|로)\s*보한다/.test(lines[index]) && /과장|담당관/.test(lines[index])) candidates.push(index);
  }
  const preferred = candidates.find((index) => siblingTitles.some((title) => lines[index].includes(title))) ?? candidates[0];
  if (preferred !== undefined) {
    const match = [...lines[preferred].matchAll(/(으로|로)(\s*)보한다/g)].at(-1);
    const at = match.index + match[1].length;
    lines[preferred] = `${lines[preferred].slice(0, at)}, ${clause}${lines[preferred].slice(at)}`;
    return lines.join("\n");
  }
  let last = article.end - 1;
  while (last > article.start && !lines[last].trim()) last -= 1;
  lines[last] = `${lines[last].replace(/\s+$/, "")} ${clause} 보한다.`;
  return lines.join("\n");
}

function articleMentioning(text, titles) {
  if (!text || !titles.length) return null;
  const { lines, blocks } = articleBlocks(text);
  return blocks.find((block) => lines.slice(block.start, block.end).some((line) => /보한다/.test(line) && titles.some((title) => new RegExp(`(?<![가-힣])${escapeRegExp(title)}`).test(line)))) || null;
}

// [{name, grade}] → "A과장ㆍB과장은 G1으로, C과장은 [직급 작성 필요]로" (consecutive equal grades share a clause).
function gradeClauses(items) {
  const runs = [];
  for (const item of items) {
    const grade = item.grade || PLACEHOLDER_GRADE;
    if (runs.at(-1)?.grade === grade) runs.at(-1).names.push(`${item.name}장`);
    else runs.push({ grade, names: [`${item.name}장`] });
  }
  return runs.map((run) => `${withParticle(run.names.join("ㆍ"), "은", "는")} ${withParticle(run.grade, "으로", "로")}`).join(", ");
}

function extractGrade(text, name) {
  const pattern = new RegExp(`(?<![가-힣])${escapeRegExp(name)}장(?:\\s*[ㆍ·]\\s*[가-힣]+장)*\\s*(?:은|는)\\s*([^,，.]+?)(?:으로|로)\\s*(?:,|보한다|한다)`);
  return text.match(pattern)?.[1]?.trim() || null;
}

function removeFromGradeLists(text, name) {
  const unit = `${escapeRegExp(name)}장`;
  return text
    .replace(new RegExp(`(?<![가-힣])${unit}\\s*[ㆍ·]\\s*`, "g"), "")
    .replace(new RegExp(`\\s*[ㆍ·]\\s*${unit}(?=\\s*(?:은|는|[ㆍ·]|$))`, "g"), "")
    // Sole subject: "…, X과장은 Y으로 보한다" / "X과장은 Y으로, …".
    .replace(new RegExp(`,\\s*${unit}(?:은|는)\\s*[^,，.]+?(?:으로|로)(?=\\s*보한다)`, "g"), "")
    .replace(new RegExp(`(?<![가-힣ㆍ·])${unit}(?:은|는)\\s*[^,，.]+?(?:으로|로)\\s*,\\s*`, "g"), "");
}

function stripDeleted(text) {
  return text.split("\n").filter((line) => !/삭제/.test(line)).join("\n");
}

// ---------------------------------------------------------------- 개정문 · 신구조문대비표

/** Article-level comparison of two texts (plus renamed 장·절 headings). */
export function compareArticles(oldText, newText) {
  const index = (text) => {
    const { lines, blocks } = articleBlocks(String(text || ""));
    return {
      lines,
      blocks: new Map(blocks.map((block) => [block.key, { ...block, lines: lines.slice(block.start, block.end).filter((line) => line.trim()) }])),
      headings: headingIndex(lines, blocks),
    };
  };
  const before = index(oldText);
  const after = index(newText);
  const oldLines = new Set(before.lines.map((line) => line.trim()));
  const keys = [...new Set([...after.blocks.keys(), ...before.blocks.keys()])].sort(compareKeys);
  const changes = [];
  const claimedHeadings = new Set();
  for (const key of keys) {
    const old = before.blocks.get(key);
    const next = after.blocks.get(key);
    if (old && next && old.lines.join("\n") === next.lines.join("\n")) continue;
    const deleted = next && /^제\d+조(?:의\d+)?\s*삭제/.test(next.lines[0]?.trim() || "");
    const kind = !old ? "inserted" : deleted || !next ? "deleted" : "modified";
    const change = { key, kind, before: old?.lines || [], after: next?.lines || [] };
    // A 절 heading that appears or disappears with this article.
    const section = next?.section;
    if (kind === "inserted" && section && !oldLines.has(section.line) && section.index === next.start - 1) {
      change.section = { key: section.key, line: section.line, chapter: next.chapter, change: "inserted" };
      claimedHeadings.add(`${next.chapter}${section.key}`);
    }
    if (kind === "deleted" && section && /삭제/.test(section.line) && !oldLines.has(section.line)) {
      change.section = { key: section.key, line: section.line, chapter: next.chapter, change: "deleted", before: old?.section?.line };
      claimedHeadings.add(`${next.chapter}${section.key}`);
    }
    changes.push(change);
  }
  // Headings renamed in place (e.g. "제5절 문화관광국" → "제5절 문화체육관광국").
  for (const [key, heading] of after.headings) {
    const old = before.headings.get(key);
    if (!old || old.line === heading.line || claimedHeadings.has(key)) continue;
    changes.push({ key: heading.ref, kind: "heading", order: heading.next, before: [old.line], after: [heading.line], title: { old: old.title, new: heading.title } });
  }
  return changes.sort((a, b) => compareKeys(a.order || a.key, b.order || b.key) || (a.kind === "heading" ? -1 : b.kind === "heading" ? 1 : 0));
}

function headingIndex(lines, blocks) {
  const headings = new Map();
  let chapter = "";
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^(제\d+(장|절)(?:의\d+)?)\s+(.+)$/);
    if (!match) return;
    if (match[2] === "장") chapter = match[1];
    const ref = match[2] === "장" ? match[1] : `${chapter}${match[1]}`;
    const next = blocks.find((block) => block.start > index)?.key || "제9999조";
    headings.set(ref, { ref, line: trimmed, title: match[3].trim(), next });
  });
  return headings;
}

function compareKeys(a, b) {
  const parse = (key) => (String(key).match(/제(\d+)조(?:의(\d+))?/) || [null, 9999, 0]).slice(1).map((value) => Number(value || 0));
  const [an, ab] = parse(a);
  const [bn, bb] = parse(b);
  return an - bn || ab - bb;
}

const HISTORY_TAG = /\s*<(?:개정|신설|전문개정|본조신설)[^>]*>/g;

/** 개정문 lines for one law ("○○ 일부를 다음과 같이 개정한다." 본문). */
export function amendmentSentences(changes) {
  const blocks = [];
  const whole = (change, verb) => [`${withParticle(change.key, "을", "를")} ${verb}`, ...change.after.map((line) => line.replace(HISTORY_TAG, ""))];
  for (const change of changes) {
    if (change.kind === "heading") {
      blocks.push([`${change.key}의 제목 “${change.title.old}”${particle(change.title.old, "을", "를")} “${change.title.new}”${particle(change.title.new, "으로", "로")} 한다.`]);
      continue;
    }
    if (change.kind === "inserted" && change.section?.change === "inserted") {
      const ref = `${change.section.key}(${change.key})`;
      blocks.push([`${change.section.chapter ? `${change.section.chapter}에 ` : ""}${withParticle(ref, "을", "를")} 다음과 같이 신설한다.`, change.section.line, ...change.after]);
      continue;
    }
    if (change.kind === "inserted") {
      blocks.push(whole(change, "다음과 같이 신설한다."));
      continue;
    }
    if (change.kind === "deleted" && change.section?.change === "deleted") {
      blocks.push([`${withParticle(`${change.section.chapter}${change.section.key}(${change.key})`, "을", "를")} 삭제한다.`]);
      continue;
    }
    if (change.kind === "deleted") {
      blocks.push([`${withParticle(change.key, "을", "를")} 삭제한다.`]);
      continue;
    }
    const edits = change.before.length === change.after.length ? lineEdits(change) : null;
    if (!edits || edits.length > 4) {
      blocks.push(whole(change, "다음과 같이 한다."));
      continue;
    }
    const parts = edits.map((edit, index) => {
      const ref = index === 0 ? edit.ref : `같은 조${edit.ref.slice(change.key.length).replace(/^(?=제)/, " ")}`;
      const quote = edit.title ? `${ref} ` : `${ref} 중 `;
      return `${quote}“${edit.old}”${particle(edit.old, "을", "를")} “${edit.new}”${particle(edit.new, "으로", "로")}`;
    });
    blocks.push([`${parts.join(" 하고, ")} 한다.`]);
  }
  return blocks.flat();
}

// Per-line edits of a modified article with their legal references
// (제N조의 제목 / 제N조제M항 / 제M항 각 호 외의 부분 / 제M항제K호).
function lineEdits(change) {
  const edits = [];
  let paragraph = 0;
  const lines = change.before;
  lines.forEach((old, i) => {
    const next = change.after[i];
    const trimmed = old.trim();
    const mark = trimmed.match(/^([①-⑳])/)?.[1];
    if (mark) paragraph = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳".indexOf(mark) + 1;
    if (old === next) return;
    if (i === 0) {
      const oldTitle = headTitle(old);
      const newTitle = headTitle(next);
      if (oldTitle !== newTitle) edits.push({ ref: `${change.key}의 제목`, old: oldTitle, new: newTitle, title: true });
      const oldBody = stripHead(old);
      const newBody = stripHead(next);
      if (oldBody !== newBody) edits.push({ ref: change.key, ...quotedSpan(oldBody, newBody) });
      return;
    }
    const item = trimmed.match(/^(\d+)\./)?.[1];
    let ref = change.key;
    if (mark) {
      const rest = lines.slice(i + 1);
      const end = rest.findIndex((line) => /^[①-⑳]/.test(line.trim()));
      const hasItems = (end < 0 ? rest : rest.slice(0, end)).some((line) => /^\d+\./.test(line.trim()));
      ref = `${change.key}제${paragraph}항${hasItems ? " 각 호 외의 부분" : ""}`;
    } else if (item) {
      ref = `${change.key}${paragraph ? `제${paragraph}항` : ""}제${item}호`;
    }
    edits.push({ ref, ...quotedSpan(stripHead(old).replace(/^\d+\.\s*/, ""), stripHead(next).replace(/^\d+\.\s*/, "")) });
  });
  return edits;
}

// The quoted text must occur once in its 항/호, or the edit is ambiguous: widen until it does.
function quotedSpan(oldText, newText) {
  let widen = 0;
  let span = minimalSpan(oldText, newText);
  // A 직급 clause is quoted from its subject ("하수과장은 …으로"), not from mid-clause.
  const midClause = (value) => /(?:으로|로)$/.test(value.old) && !/^[가-힣]+장(?:은|는|[ㆍ·])/.test(value.old);
  while (widen < 12 && (occurrences(oldText, span.old) > 1 || midClause(span))) {
    widen += 1;
    const wider = minimalSpan(oldText, newText, widen);
    if (wider.old === span.old) break;
    span = wider;
  }
  return span;
}

function headTitle(line = "") {
  return line.trim().match(/^제\d+조(?:의\d+)?\s*\(([^)]*)\)/)?.[1] ?? null;
}

function stripHead(line = "") {
  return line.trim().replace(/^제\d+조(?:의\d+)?\s*\([^)]*\)\s*/, "").replace(/^[①-⑳]\s*/, "");
}

// Words keep their trailing separator (space or ㆍ) so "A과장ㆍB과장은" splits per 과장.
function words(text) {
  return String(text).match(/[^\sㆍ·]+(?:[ㆍ·]|\s+)?|[ㆍ·]/g) || [];
}

const LIST_END = /[,ㆍ·]\s*$/;

function minimalSpan(oldLine, newLine, widen = 0) {
  const a = words(oldLine);
  const b = words(newLine);
  const same = (x, y) => x.trim() === y.trim();
  let head = 0;
  while (head < a.length && head < b.length && same(a[head], b[head])) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && same(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail += 1;
  let start = head;
  let end = tail;
  // Keep at least one word on each side so pure insertions/deletions are quotable.
  if (a.length - end - start === 0 || b.length - end - start === 0) {
    const insertion = a.length - end - start === 0;
    const removed = (insertion ? b : a).slice(start, (insertion ? b : a).length - end);
    const shared = (insertion ? a : b)[(insertion ? a : b).length - end];
    // Insertion into a list: anchor on the previous name ("“A”를 “A, B”로").
    if (insertion && start > 0 && LIST_END.test(a[start - 1])) start -= 1;
    // "X" → "X, Y는 …X": quote the shared X ("“X”를 “X, Y는 …X”로").
    else if (insertion && end > 0 && shared && removed[0].trim() === `${shared.trim()},`) end -= 1;
    // Deletion from a list: take the next name along ("“A, B”를 “B”로").
    else if (!insertion && LIST_END.test(removed.at(-1)) && end > 0) end -= 1;
    else start = Math.max(0, start - 1);
  }
  start = Math.max(0, start - widen);
  let oldSpan = a.slice(start, a.length - end).join("").trim();
  let newSpan = b.slice(start, b.length - end).join("").trim();
  // Quote whole names: drop a shared trailing list separator.
  while (LIST_END.test(oldSpan) && LIST_END.test(newSpan) && oldSpan.at(-1) === newSpan.at(-1)) {
    oldSpan = oldSpan.slice(0, -1).trim();
    newSpan = newSpan.slice(0, -1).trim();
  }
  const [oldCore, newCore] = trimSharedParticle(oldSpan, newSpan);
  return { old: oldCore, new: newCore };
}

function occurrences(text, part) {
  if (!part) return 0;
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) count += 1;
  return count;
}

function trimSharedParticle(oldSpan, newSpan) {
  // "…과를" → "…과" so the quoted text ends with a name; the particle is re-derived.
  const strip = (value) => value.replace(/(을|를)$/, "");
  if (/(?:을|를)$/.test(oldSpan) && /(?:을|를)$/.test(newSpan)) return [strip(oldSpan), strip(newSpan)];
  return [oldSpan, newSpan];
}

/** Token-level marks for a 신구조문대비표: [{text, changed}] for each side. */
export function markedDiff(oldLine = "", newLine = "") {
  const a = oldLine.split(/(\s+|[ㆍ·,])/).filter((token) => token !== "");
  const b = newLine.split(/(\s+|[ㆍ·,])/).filter((token) => token !== "");
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const left = [];
  const right = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      left.push({ text: a[i], changed: false });
      right.push({ text: b[j], changed: false });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      right.push({ text: b[j], changed: !/^[\sㆍ·,]+$/.test(b[j]) });
      j += 1;
    } else {
      left.push({ text: a[i], changed: !/^[\sㆍ·,]+$/.test(a[i]) });
      i += 1;
    }
  }
  return { left: mergeRuns(left), right: mergeRuns(right) };
}

function mergeRuns(runs) {
  const merged = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && last.changed === run.changed) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

/** Rows for a 신구조문대비표: unchanged 항 of a changed article collapse to (생 략)/(현행과 같음). */
export function comparisonRows(changes) {
  return changes.map((change) => {
    if (change.kind === "heading") {
      const marks = markedDiff(change.before[0], change.after[0]);
      return { key: change.key, left: [marks.left], right: [marks.right] };
    }
    if (change.kind === "inserted" && change.section) {
      return { key: change.key, left: [[{ text: "<신 설>", changed: false }]], right: [change.section.line, ...change.after].map((line) => [{ text: line, changed: true }]) };
    }
    if (change.kind === "inserted") return { key: change.key, left: [[{ text: "<신 설>", changed: false }]], right: change.after.map((line) => [{ text: line, changed: true }]) };
    const length = Math.max(change.before.length, change.after.length);
    const left = [];
    const right = [];
    let skipped = false;
    for (let i = 0; i < length; i += 1) {
      const old = change.before[i] ?? "";
      const next = change.after[i] ?? "";
      if (i > 0 && old === next) {
        if (!skipped) {
          left.push([{ text: "(생 략)", changed: false }]);
          right.push([{ text: "(현행과 같음)", changed: false }]);
          skipped = true;
        }
        continue;
      }
      skipped = false;
      const marks = markedDiff(old, next);
      if (old) left.push(marks.left);
      if (next) right.push(marks.right);
    }
    return { key: change.key, left, right };
  });
}

// ---------------------------------------------------------------- Korean particles

// Final consonant index (0 = none) of the last pronounced syllable; digits read as 영·일·이….
function finalOf(text) {
  const chars = [...String(text).replace(/[\s\])」』"”'’>]+$/u, "")];
  const last = chars.at(-1);
  if (last && /\d/.test(last)) return [21, 8, 0, 16, 0, 0, 1, 8, 8, 0][Number(last)];
  const char = [...chars].reverse().find((value) => value >= "가" && value <= "힣");
  return char ? (char.charCodeAt(0) - 0xac00) % 28 : null;
}

/** particle("과", "을", "를") → "를"; particle("국", "으로", "로") → "으로" (ㄹ받침은 "로"). */
export function particle(text, withFinal, withoutFinal) {
  const final = finalOf(text);
  if (final === null) return withFinal;
  if (withFinal === "으로" && final === 8) return withoutFinal;
  return final ? withFinal : withoutFinal;
}

function withParticle(text, withFinal, withoutFinal) {
  return `${text}${particle(text, withFinal, withoutFinal)}`;
}

function joinWithParticle(names) {
  return `${names.join(", ")}${particle(names.at(-1), "을", "를")}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- documents

/**
 * 일부개정안 document (개정문 + 부칙 + 신구조문대비표) for one law, as blocks for
 * createAmendmentHwpxBytes and as Markdown.
 */
export function buildAmendmentDocument({ lawName, oldText, newText, kind = "조례", effective = "공포한 날부터 시행한다" }) {
  const changes = compareArticles(oldText, newText);
  if (!changes.length) return null;
  const sentences = amendmentSentences(changes);
  const uncovered = uncoveredLines(oldText, newText, changes);
  const suffix = kind === "규칙" ? "일부개정규칙안" : "일부개정조례안";
  const title = `${lawName} ${suffix}`;
  const subject = kind === "규칙" ? "이 규칙은" : "이 조례는";
  const rows = comparisonRows(changes);
  const blocks = [
    { type: "title", text: title },
    { type: "paragraph", runs: [{ text: `${lawName} 일부를 다음과 같이 개정한다.` }], indentMm: 4 },
    ...sentences.map((line) => ({ type: "paragraph", runs: highlightPlaceholders(line), indentMm: /^제\d+(?:장|절|조)/.test(line) && !/한다\.$/.test(line) ? 0 : 4 })),
    { type: "paragraph", runs: [{ text: "부      칙", bold: true }], align: "center" },
    { type: "paragraph", runs: [{ text: `${subject} ${effective}.` }], indentMm: 4 },
    { type: "pageBreak" },
    { type: "title", text: "신ㆍ구조문대비표" },
    {
      type: "table",
      columns: ["현      행", "개   정   안"],
      rows: rows.map((row) => [row.left.map(toRuns), row.right.map(toRuns)]),
    },
  ];
  const markdown = [
    `## ${title}`,
    "",
    `${lawName} 일부를 다음과 같이 개정한다.`,
    "",
    ...sentences.map((line) => `${line}  `),
    "",
    "부칙",
    `${subject} ${effective}.`,
    "",
    `### 신ㆍ구조문대비표 — ${lawName}`,
    "",
    "| 현행 | 개정안 |",
    "|---|---|",
    ...rows.map((row) => `| ${row.left.map(markdownLine).join("<br>")} | ${row.right.map(markdownLine).join("<br>")} |`),
    "",
  ].join("\n");
  return { title, sentences, changes, blocks, markdown, uncovered };
}

/**
 * Lines that differ between the two texts but belong to no listed change —
 * a 개정문 that would not turn the old text into the new one.
 */
export function uncoveredLines(oldText, newText, changes) {
  const lines = (text) => String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const a = lines(oldText);
  const b = lines(newText);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  const covered = new Set(changes.flatMap((change) => [...change.before, ...change.after, change.section?.line, change.section?.before].filter(Boolean).map((line) => line.trim())));
  return [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].filter((entry) => !covered.has(entry.slice(2)));
}

function toRuns(line) {
  return line.flatMap((run) => highlightPlaceholders(run.text).map((part) => ({ ...part, underline: run.changed })));
}

// Placeholders are printed in red so nobody files them by accident.
function highlightPlaceholders(text) {
  return String(text).split(/(\[[^\]]*작성 필요\])/).filter(Boolean).map((part) => (/작성 필요\]$/.test(part) ? { text: part, color: "#C00000" } : { text: part }));
}

function markdownLine(line) {
  return line.map((run) => {
    const text = run.text.replace(/\|/g, "\\|");
    return run.changed && text.trim() ? `<u>${text}</u>` : text;
  }).join("");
}
