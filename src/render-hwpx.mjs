import fs from "node:fs/promises";
import path from "node:path";
import { HwpxReader } from "@ssabrojs/hwpxjs";
import JSZip from "jszip";
import sharp from "sharp";
import { HWPX_TEMPLATE_BASE64 } from "../docs/assets/hwpx-template.mjs";
import { buildAuditReport } from "./audit.mjs";
import {
  diagnoseLayout,
  displayNodeName,
  layoutPage,
  nodeStyle,
  ORG_CHART_THEME,
  resolvePageSize,
} from "./layout.mjs";
import { edgeRoute, renderSvg } from "./render-svg.mjs";
import { buildTraceRows } from "./trace.mjs";
import { ensureParent, xmlEscape } from "./utils.mjs";

const HWPX_MIMETYPE = "application/hwp+zip";
const TEMPLATE_OVERRIDES = new Set([
  "mimetype",
  "Contents/content.hpf",
  "Contents/section0.xml",
  "Preview/PrvImage.png",
  "Preview/PrvText.txt",
  "settings.xml",
]);

/**
 * Build a native HWPX review report and write it to disk.
 *
 * The chart remains visually faithful as a high-resolution PNG while the
 * summary, evidence table, checklist and sign-off fields stay editable HWPX
 * text/table objects.
 */
export async function renderHwpx(graph, pages, outPath, options = {}) {
  const bytes = await createHwpxReportBytes(graph, pages, options);
  const resolved = path.resolve(outPath);
  await ensureParent(resolved);
  await fs.writeFile(resolved, bytes);
  return resolved;
}

/**
 * Write a single, full-live-area SVG plate as a one-page HWPX document.
 *
 * This is intentionally separate from renderHwpx(): comparison sheets and
 * other dense review plates sometimes need the entire A4 page and should not
 * automatically grow the normal audit/checklist appendix.
 */
export async function renderSinglePlateHwpx(svg, outPath, options = {}) {
  const bytes = await createSinglePlateHwpxBytes(svg, options);
  const resolved = path.resolve(outPath);
  await ensureParent(resolved);
  await fs.writeFile(resolved, bytes);
  return resolved;
}

export async function createSinglePlateHwpxBytes(svg, options = {}) {
  if (!String(svg || "").includes("<svg")) {
    throw new Error("단일 HWPX 플레이트에 유효한 SVG가 필요합니다.");
  }
  const page = { paper: options.paper || "a4-landscape" };
  const pageSpec = documentPageSpec(page);
  const sourceWidth = pageSpec.textWidth / 100;
  const sourceHeight = pageSpec.textHeight / 100;
  const pixelWidth = Math.max(1600, Math.min(4800, Math.round(Number(options.pixelWidth) || 3154)));
  const pixelHeight = Math.max(1000, Math.round(pixelWidth * sourceHeight / sourceWidth));
  const imageBytes = await sharp(Buffer.from(String(svg), "utf8"), {
    density: Math.max(240, Number(options.dpi) || 300),
  })
    .flatten({ background: "#ffffff" })
    .resize({ width: pixelWidth, height: pixelHeight, fit: "fill" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const image = {
    id: "image1",
    href: "BinData/image1.png",
    bytes: imageBytes,
    sourceWidth,
    sourceHeight,
  };
  const ids = createIdFactory();
  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">${sectionPictureParagraph(image, pageSpec, ids)}</hs:sec>`;
  const title = options.title || "정부 조직개편 비교도";
  const previewText = String(options.previewText || title).slice(0, 4000);
  const previewImage = await sharp(imageBytes)
    .resize({ width: 320, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const contentHpf = buildContentHpf({
    title,
    creator: options.creator || "korean-government-orgchart",
    imageCount: 1,
    now: options.generatedAt || new Date(),
  });
  const bytes = await assemblePackage({
    sectionXml,
    contentHpf,
    previewText,
    previewImage,
    images: [image],
  });
  await validateHwpxBytes(bytes, { expectedImages: 1, requireTable: false });
  return bytes;
}

export async function createHwpxReportBytes(graph, pages, options = {}) {
  if (!graph) throw new Error("HWPX 생성에 조직도 graph가 필요합니다.");
  if (!Array.isArray(pages) || !pages.length) throw new Error("HWPX 생성에 한 쪽 이상의 페이지가 필요합니다.");

  const sourceGraph = options.sourceGraph || graph;
  const title = options.title || reportTitle(graph.meta.title || graph.meta.institution || "정부기관");
  const creator = options.creator || "korean-government-orgchart";
  const images = await renderChartImages(graph, pages, options);
  const pageSpec = documentPageSpec(pages[0]);
  const audit = buildAuditReport(graph, pages);
  const traceRows = buildTraceRows(sourceGraph);
  const sectionXml = buildSectionXml({
    graph,
    pages,
    images,
    pageSpec,
    audit,
    traceRows,
    title,
  });
  const previewText = buildPreviewText({ graph, audit, traceRows, title });
  const previewImage = await sharp(images[0].bytes)
    .resize({ width: 320, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const now = options.generatedAt || new Date();
  const contentHpf = buildContentHpf({ title, creator, imageCount: images.length, now });
  const bytes = await assemblePackage({
    sectionXml,
    contentHpf,
    previewText,
    previewImage,
    images,
  });

  await validateHwpxBytes(bytes, {
    expectedImages: images.length,
    expectedText: graph.meta.institution || graph.meta.title,
  });
  return bytes;
}

export async function validateHwpxBytes(bytes, { expectedImages = 1, expectedText, requireTable = true } = {}) {
  const zip = await JSZip.loadAsync(bytes);
  for (const required of [
    "mimetype",
    "META-INF/container.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
    "Contents/section0.xml",
    "Preview/PrvText.txt",
    "Preview/PrvImage.png",
  ]) {
    if (!zip.file(required)) throw new Error(`HWPX 필수 항목이 없습니다: ${required}`);
  }
  const mime = await zip.file("mimetype").async("string");
  if (mime !== HWPX_MIMETYPE) throw new Error(`HWPX mimetype이 올바르지 않습니다: ${mime}`);
  const section = await zip.file("Contents/section0.xml").async("string");
  if (!/<hp:pagePr[^>]+width="[1-9]\d*"[^>]+height="[1-9]\d*"/.test(section)) {
    throw new Error("HWPX 쪽 크기가 0이거나 누락되었습니다.");
  }
  if (!/<hp:pic\b/.test(section)) throw new Error("HWPX 조직도 그림이 누락되었습니다.");
  if (requireTable && !/<hp:tbl\b/.test(section)) throw new Error("HWPX 편집 가능한 표가 누락되었습니다.");

  const reader = new HwpxReader();
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await reader.loadFromArrayBuffer(arrayBuffer);
  const [text, listedImages] = await Promise.all([reader.extractText(), reader.listImages()]);
  if (expectedText && !text.includes(expectedText)) {
    throw new Error(`HWPX 본문에서 기관명을 확인하지 못했습니다: ${expectedText}`);
  }
  if (listedImages.length !== expectedImages) {
    throw new Error(`HWPX 그림 수가 다릅니다: 기대 ${expectedImages}, 실제 ${listedImages.length}`);
  }
  return { text, images: listedImages };
}

async function renderChartImages(
  graph,
  pages,
  { showLawCounts = false, hwpxChartDpi = 300, hwpxChartPixelWidth } = {},
) {
  const images = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const pageSize = resolvePageSize(page.paper || "slide");
    const pageSpec = documentPageSpec(page);
    const isolatedPage = {
      ...page,
      pageNumber: page.pageNumber || index + 1,
      pageCount: page.pageCount || pages.length,
    };
    const plate = renderHwpxChartSvg(graph, isolatedPage, {
      showLawCounts,
      pageSize,
      pageSpec,
    });
    const targetWidth = Number.isFinite(Number(hwpxChartPixelWidth))
      ? Math.max(1600, Math.min(4800, Math.round(Number(hwpxChartPixelWidth))))
      : Math.max(
          2200,
          Math.min(3800, Math.round((plate.width / 72) * Math.max(240, Number(hwpxChartDpi) || 300))),
        );
    const bytes = await sharp(Buffer.from(plate.svg, "utf8"), { density: hwpxChartDpi })
      .flatten({ background: "#ffffff" })
      .resize({ width: targetWidth })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    images.push({
      id: `image${index + 1}`,
      href: `BinData/image${index + 1}.png`,
      bytes,
      sourceWidth: plate.width,
      sourceHeight: plate.height,
    });
  }
  return images;
}

/**
 * HWPX has a smaller live area than the source SVG page.  Embedding that full
 * page creates a second margin and makes an otherwise clean chart look like a
 * screenshot pasted into a report.  This renderer composes an HWPX-only chart
 * plate at the document's exact live-area ratio, then refits the legal layout
 * into a dedicated chart surface.  Node metadata is separated from the unit
 * name so grades and staffing marks no longer turn into long vertical labels.
 */
export function renderHwpxChartSvg(
  graph,
  page,
  { showLawCounts = false, pageSize = resolvePageSize(page?.paper || "slide"), pageSpec = documentPageSpec(page) } = {},
) {
  if (page.kind === "law-index" || page.kind === "comparison-report") {
    return {
      svg: renderSvg(graph, [page], { showLawCounts, paper: page.paper }),
      width: pageSize.width,
      height: pageSize.height,
    };
  }

  const width = pageSpec.textWidth / 100;
  const height = pageSpec.textHeight / 100;
  const portrait = height > width;
  const colors = ORG_CHART_THEME.colors;
  const renderPage = hwpxPageForRendering(page);
  const baseLayout = layoutPage(graph, renderPage, { pageSize });
  const layout = renderPage.hwpxLayoutOverride === "affiliated-cards"
    ? hwpxAffiliatedCardsLayout(graph, page, baseLayout.frame)
    : renderPage.hwpxLayoutOverride === "forest"
      ? hwpxForestLayout(graph, page, baseLayout.frame, pageSize)
      : baseLayout;
  const outer = portrait
    ? { x: 1, y: 94, width: width - 2, height: height - 130 }
    : { x: 1, y: 78, width: width - 2, height: height - 112 };
  const chartRect = {
    x: outer.x + (portrait ? 11 : 13),
    y: outer.y + (portrait ? 13 : 11),
    width: outer.width - (portrait ? 22 : 26),
    height: outer.height - (portrait ? 26 : 22),
  };
  const transform = chartTransform(layout, chartRect);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" shape-rendering="geometricPrecision">`);
  parts.push(hwpxChartDefs(colors));
  parts.push(`<rect width="${round(width)}" height="${round(height)}" fill="#FFFFFF"/>`);
  parts.push(hwpxPlateHeader(graph, page, { width, portrait, colors }));
  parts.push(`<rect x="${round(outer.x)}" y="${round(outer.y)}" width="${round(outer.width)}" height="${round(outer.height)}" rx="8" fill="#FBFCFE" stroke="#D8E0EA" stroke-width="0.85"/>`);

  for (const group of layout.groupBoxes || []) {
    parts.push(hwpxGroupBox(group, transform));
  }
  for (const connector of layout.implicitConnectors || []) {
    parts.push(hwpxImplicitConnector(connector, transform, colors));
  }
  parts.push(hwpxConnectorLayer(layout, transform, colors));
  for (const label of layout.labels || []) {
    parts.push(hwpxLayoutLabel(label, transform));
  }
  for (const entry of layout.nodes || []) {
    parts.push(hwpxNode(entry.node, transform.position(entry.position), {
      showLawCounts,
      colors,
    }));
  }
  parts.push(hwpxPlateLegend(graph, page, layout, { width, height, portrait, colors }));
  parts.push(`</svg>`);
  return { svg: parts.join("\n"), width, height, diagnostics: layout.diagnostics };
}

function hwpxPageForRendering(page) {
  // A multi-root affiliated-institution detail page is the one place where a
  // conventional tree is visually misleading: many independent roots and
  // their children force long shared buses and crossing stems.  HWPX is a
  // review document, so group those branches into explicit legal-parent cards
  // and omit the decorative connector web.  Other renderers keep the caller's
  // layout unchanged.
  if (page.kind === "affiliate-detail" && (page.rootIds?.length || 0) >= 3) {
    return { ...page, layoutStyle: "catalog", hwpxLayoutOverride: "affiliated-cards" };
  }
  if (page.kind === "affiliates" && (page.rootIds?.length || 0) >= 2) {
    return { ...page, hwpxLayoutOverride: "forest" };
  }
  if (page.kind === "branch" && (page.rootIds?.length || 0) >= 2) {
    return { ...page, hwpxLayoutOverride: "forest" };
  }
  return page;
}

function hwpxForestLayout(graph, page, sourceFrame, pageSize) {
  const selected = new Set(page.nodeIds || []);
  const children = selectedChildren(graph, selected);
  const rootGroups = (page.rootIds || [])
    .filter((id) => selected.has(id) && graph.nodes.has(id))
    .map((rootId) => ({ rootId, nodeIds: subtreeNodeIds(rootId, children, selected) }));
  if (rootGroups.length < 2) return layoutPage(graph, page, { pageSize });

  const sorted = rootGroups
    .map((group, index) => ({ ...group, index }))
    .sort((left, right) => right.nodeIds.length - left.nodeIds.length || left.index - right.index);
  const largest = sorted[0];
  const remaining = sorted.slice(1);
  const total = sorted.reduce((sum, group) => sum + group.nodeIds.length, 0);
  const panels = [];
  const gap = 14;
  if (remaining.length && largest.nodeIds.length / Math.max(1, total) >= 0.5) {
    const mainWidth = sourceFrame.width * 0.68;
    panels.push({ group: largest, left: sourceFrame.left, top: sourceFrame.top, width: mainWidth - gap / 2, height: sourceFrame.height });
    const sideLeft = sourceFrame.left + mainWidth + gap / 2;
    const sideWidth = sourceFrame.width - mainWidth - gap / 2;
    const availableHeight = sourceFrame.height - gap * Math.max(0, remaining.length - 1);
    const minimums = remaining.map((group) => group.nodeIds.length <= 1 ? 90 : group.nodeIds.length <= 3 ? 145 : 175);
    const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
    const weights = remaining.map((group) => Math.sqrt(Math.max(1, group.nodeIds.length)));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const extra = Math.max(0, availableHeight - minimumTotal);
    let sideTop = sourceFrame.top;
    remaining.forEach((group, index) => {
      const height = minimumTotal <= availableHeight
        ? minimums[index] + extra * (weights[index] / weightTotal)
        : availableHeight * (weights[index] / weightTotal);
      panels.push({ group, left: sideLeft, top: sideTop, width: sideWidth, height });
      sideTop += height + gap;
    });
  } else {
    const columns = Math.min(3, sorted.length);
    const rows = Math.ceil(sorted.length / columns);
    const width = (sourceFrame.width - gap * (columns - 1)) / columns;
    const height = (sourceFrame.height - gap * (rows - 1)) / rows;
    sorted.forEach((group, index) => panels.push({
      group,
      left: sourceFrame.left + (index % columns) * (width + gap),
      top: sourceFrame.top + Math.floor(index / columns) * (height + gap),
      width,
      height,
    }));
  }

  const nodes = [];
  const edges = [];
  const groupBoxes = [];
  const labels = [];
  const implicitConnectors = [];
  let maxDepth = 0;
  for (const panel of panels) {
    const inner = {
      left: panel.left + 12,
      top: panel.top + 20,
      width: Math.max(80, panel.width - 24),
      height: Math.max(90, panel.height - 30),
    };
    const subLayout = page.kind === "affiliates"
      ? hwpxTieredSubtreeLayout(graph, panel.group.rootId, panel.group.nodeIds, inner)
      : layoutPage(graph, {
          ...page,
          rootIds: [panel.group.rootId],
          nodeIds: panel.group.nodeIds,
          layoutStyle: panel.group.nodeIds.length <= 4 ? "horizontal-bus" : "two-column",
        }, { pageSize, ...inner });
    nodes.push(...(subLayout.nodes || []));
    edges.push(...(subLayout.edges || []));
    implicitConnectors.push(...(subLayout.implicitConnectors || []));
    labels.push(...(subLayout.labels || []));
    maxDepth = Math.max(maxDepth, subLayout.maxDepth || 0);
    groupBoxes.push({
      left: panel.left,
      top: panel.top,
      width: panel.width,
      height: panel.height,
      caption: hwpxForestCaption(graph.nodes.get(panel.group.rootId)),
    });
  }
  const layout = {
    frame: sourceFrame,
    nodes,
    edges,
    roots: rootGroups.map((group) => group.rootId),
    maxDepth,
    verticalLeaves: false,
    implicitConnectors,
    groupBoxes,
    labels,
  };
  return { ...layout, diagnostics: diagnoseLayout(layout) };
}

function hwpxTieredSubtreeLayout(graph, rootId, nodeIds, frame) {
  const selected = new Set(nodeIds || []);
  const children = selectedChildren(graph, selected);
  const positions = new Map();
  const root = graph.nodes.get(rootId);
  if (!root) {
    return { frame, nodes: [], edges: [], roots: [], maxDepth: 0, verticalLeaves: false };
  }

  const rootWidth = Math.min(170, Math.max(92, frame.width * 0.38));
  positions.set(rootId, hwpxBoxPosition(frame.left + frame.width / 2, frame.top, rootWidth, 32, {
    depth: 0,
    spanLeft: frame.left,
    spanWidth: frame.width,
  }));
  const firstLevel = (children.get(rootId) || []).filter((id) => selected.has(id));
  if (!firstLevel.length) {
    const layout = {
      frame,
      nodes: [{ node: root, position: positions.get(rootId) }],
      edges: [],
      roots: [rootId],
      maxDepth: 0,
      verticalLeaves: false,
    };
    return { ...layout, diagnostics: diagnoseLayout(layout) };
  }

  const hasSecondLevel = firstLevel.some((id) => (children.get(id) || []).some((childId) => selected.has(childId)));
  const firstTop = frame.top + (hasSecondLevel ? Math.min(96, Math.max(62, frame.height * 0.25)) : Math.min(82, Math.max(54, frame.height - 66)));
  const laneWidth = frame.width / firstLevel.length;
  firstLevel.forEach((id, index) => {
    const width = Math.min(158, Math.max(66, laneWidth - 22));
    positions.set(id, hwpxBoxPosition(frame.left + laneWidth * (index + 0.5), firstTop, width, 30, {
      depth: 1,
      spanLeft: frame.left + laneWidth * index,
      spanWidth: laneWidth,
    }));
  });

  let maxDepth = 1;
  if (hasSecondLevel) {
    const secondTop = firstTop + Math.min(105, Math.max(66, frame.height * 0.25));
    firstLevel.forEach((parentId, laneIndex) => {
      const leafIds = (children.get(parentId) || []).filter((id) => selected.has(id));
      if (!leafIds.length) return;
      maxDepth = 2;
      const slotWidth = laneWidth / leafIds.length;
      leafIds.forEach((id, index) => {
        const node = graph.nodes.get(id);
        if (!node) return;
        const vertical = slotWidth < 70 || [...node.name].length > 8;
        const width = vertical
          ? Math.min(34, Math.max(24, slotWidth * 0.66))
          : Math.min(142, Math.max(62, slotWidth - 16));
        const height = vertical
          ? Math.min(104, Math.max(52, frame.top + frame.height - secondTop - 4))
          : 27;
        const laneLeft = frame.left + laneWidth * laneIndex;
        positions.set(id, hwpxBoxPosition(laneLeft + slotWidth * (index + 0.5), secondTop, width, height, {
          depth: 2,
          vertical,
          spanLeft: laneLeft + slotWidth * index,
          spanWidth: slotWidth,
        }));
      });
    });
  }

  // Preserve any deeper or disconnected selected node instead of dropping it.
  const represented = new Set(positions.keys());
  const missing = [...selected].filter((id) => !represented.has(id));
  if (missing.length) {
    const slotWidth = frame.width / missing.length;
    const top = frame.top + frame.height - 34;
    missing.forEach((id, index) => positions.set(id, hwpxBoxPosition(
      frame.left + slotWidth * (index + 0.5),
      top,
      Math.min(120, Math.max(54, slotWidth - 12)),
      27,
      { depth: 3, spanLeft: frame.left + slotWidth * index, spanWidth: slotWidth },
    )));
    maxDepth = 3;
  }

  const edgeByPair = new Map([...graph.edges.values()].map((edge) => [`${edge.parent}>${edge.child}`, edge]));
  const edges = [];
  for (const [parentId, childIds] of children.entries()) {
    const from = positions.get(parentId);
    if (!from) continue;
    for (const childId of childIds) {
      const to = positions.get(childId);
      if (!to) continue;
      const source = edgeByPair.get(`${parentId}>${childId}`) || {
        id: `hwpx-${parentId}-${childId}`,
        parent: parentId,
        child: childId,
        type: "assistant",
      };
      edges.push({ ...source, from, to });
    }
  }
  const nodes = [...positions.entries()]
    .map(([id, position]) => ({ node: graph.nodes.get(id), position }))
    .filter((entry) => entry.node);
  const layout = {
    frame,
    nodes,
    edges,
    roots: [rootId],
    maxDepth,
    verticalLeaves: hasSecondLevel,
  };
  return { ...layout, diagnostics: diagnoseLayout(layout) };
}

function hwpxForestCaption(node) {
  if (node?.kind === "advisor") return "보좌기관 계선";
  if (node?.kind === "affiliated") return "소속기관 계선";
  return "보조기관 계선";
}

function selectedChildren(graph, selected) {
  const children = new Map();
  for (const edge of graph.edges.values()) {
    if (!selected.has(edge.parent) || !selected.has(edge.child)) continue;
    if (!children.has(edge.parent)) children.set(edge.parent, []);
    children.get(edge.parent).push(edge.child);
  }
  return children;
}

function subtreeNodeIds(rootId, children, selected) {
  const result = [];
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !selected.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(children.get(id) || []));
  }
  return result;
}

function hwpxAffiliatedCardsLayout(graph, page, sourceFrame) {
  const selected = new Set(page.nodeIds || []);
  const rootIds = (page.rootIds || []).filter((id) => selected.has(id) && graph.nodes.has(id));
  const children = new Map();
  for (const edge of graph.edges.values()) {
    if (!selected.has(edge.parent) || !selected.has(edge.child)) continue;
    if (!children.has(edge.parent)) children.set(edge.parent, []);
    children.get(edge.parent).push(edge.child);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => {
      const left = graph.nodes.get(a);
      const right = graph.nodes.get(b);
      return (left?.rank ?? 9) - (right?.rank ?? 9) || left?.name.localeCompare(right?.name, "ko");
    });
  }

  const claimed = new Set(rootIds);
  const groups = rootIds.map((rootId) => {
    const descendants = [];
    const levels = new Map([[rootId, 0]]);
    const queue = [...(children.get(rootId) || [])].map((id) => ({ id, level: 1 }));
    while (queue.length) {
      const current = queue.shift();
      if (claimed.has(current.id) || levels.has(current.id)) continue;
      claimed.add(current.id);
      levels.set(current.id, current.level);
      descendants.push(current.id);
      for (const childId of children.get(current.id) || []) {
        queue.push({ id: childId, level: current.level + 1 });
      }
    }
    return { rootId, descendants, levels };
  });

  const orphanIds = [...selected].filter((id) => !claimed.has(id));
  if (orphanIds.length) {
    groups.push({ rootId: null, descendants: orphanIds, levels: new Map(orphanIds.map((id) => [id, 1])) });
  }

  const columns = Math.max(1, Math.min(4, groups.length || 1));
  const columnWidth = sourceFrame.width / columns;
  const columnTops = Array.from({ length: columns }, () => sourceFrame.top + 26);
  const positions = new Map();
  const groupBoxes = [];
  let maxDepth = 0;

  for (const group of groups) {
    const childCount = group.descendants.length;
    const span = columns > 1 && childCount > 4 ? Math.min(2, columns) : 1;
    let column = 0;
    let top = Infinity;
    for (let candidate = 0; candidate <= columns - span; candidate += 1) {
      const candidateTop = Math.max(...columnTops.slice(candidate, candidate + span));
      if (candidateTop < top) {
        top = candidateTop;
        column = candidate;
      }
    }
    const left = sourceFrame.left + column * columnWidth + 6;
    const groupWidth = columnWidth * span - 12;
    const captionHeight = 17;
    const rootHeight = group.rootId ? 31 : 0;
    const childColumns = span > 1 ? 2 : 1;
    const childRows = Math.ceil(childCount / childColumns);
    const rowGap = 31;
    const groupHeight = captionHeight + rootHeight + (childCount ? 8 + childRows * rowGap : 8) + 8;
    const caption = group.rootId
      ? childCount
        ? `하부조직 ${childCount}개`
        : "단독 소속기관"
      : "관계 확인 필요";
    groupBoxes.push({ left, top, width: groupWidth, height: groupHeight, caption });

    let cursorTop = top + captionHeight;
    if (group.rootId) {
      const rootWidth = Math.min(span > 1 ? 214 : 168, Math.max(82, groupWidth - 22));
      positions.set(group.rootId, hwpxBoxPosition(left + groupWidth / 2, cursorTop, rootWidth, 29, {
        depth: 0,
        spanLeft: left,
        spanWidth: groupWidth,
      }));
      cursorTop += rootHeight + 7;
    }

    const childColumnWidth = groupWidth / childColumns;
    group.descendants.forEach((id, index) => {
      const node = graph.nodes.get(id);
      if (!node) return;
      const childColumn = index % childColumns;
      const row = Math.floor(index / childColumns);
      const childLeft = left + childColumn * childColumnWidth;
      const width = Math.min(166, Math.max(64, childColumnWidth - 24));
      const depth = group.levels.get(id) || 1;
      maxDepth = Math.max(maxDepth, depth);
      positions.set(id, hwpxBoxPosition(childLeft + childColumnWidth / 2, cursorTop + row * rowGap, width, 25, {
        depth,
        spanLeft: childLeft,
        spanWidth: childColumnWidth,
      }));
    });

    const bottom = top + groupHeight + 9;
    for (let index = column; index < column + span; index += 1) columnTops[index] = bottom;
  }

  const bottom = Math.max(sourceFrame.top + sourceFrame.height, ...columnTops) - 9;
  const frame = { ...sourceFrame, height: Math.max(sourceFrame.height, bottom - sourceFrame.top) };
  const nodes = [...positions.entries()]
    .map(([id, position]) => ({ node: graph.nodes.get(id), position }))
    .filter((entry) => entry.node);
  const layout = {
    frame,
    nodes,
    edges: [],
    roots: rootIds,
    maxDepth,
    verticalLeaves: false,
    edgeMode: "none",
    groupBoxes,
    labels: [{
      text: "소속기관별 카드 묶음 · 기관과 하부조직을 같은 경계 안에 표시",
      x: sourceFrame.left,
      y: sourceFrame.top + 3,
      align: "start",
    }],
  };
  return { ...layout, diagnostics: diagnoseLayout(layout) };
}

function hwpxBoxPosition(centerX, top, width, height, extras = {}) {
  const left = centerX - width / 2;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    centerX,
    centerY: top + height / 2,
    ...extras,
  };
}

function hwpxChartDefs(colors) {
  return `<defs>
    <marker id="hwpx-arrow-main" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${colors.edge}"/></marker>
    <marker id="hwpx-arrow-staff" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${colors.edgeStaff}"/></marker>
    <marker id="hwpx-arrow-affiliate" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${colors.edgeAffiliate}"/></marker>
    <marker id="hwpx-arrow-jurisdiction" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${colors.edgeJurisdiction}"/></marker>
  </defs>`;
}

function hwpxPlateHeader(graph, page, { width, portrait, colors }) {
  const institution = graph.meta.institution || page.title || graph.meta.title || "정부기관";
  const subtitle = page.subtitle || "조직도";
  const view = graph.meta.renderView === "operational" ? "운영상 소관형" : "법정 설치형";
  const meta = [graph.meta.asOf ? `${formatKoreanDate(graph.meta.asOf)} 기준` : "기준일 미기재", view]
    .filter(Boolean)
    .join(" · ");
  const titleY = portrait ? 34 : 29;
  const subtitleY = portrait ? 58 : 52;
  const pillWidth = portrait ? 53 : 58;
  const pillX = width - pillWidth;
  const pageLabel = `${page.pageNumber || 1} / ${page.pageCount || 1}`;
  return [
    `<text x="0" y="9" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.4" font-weight="700" letter-spacing="1.2" fill="#607086">ORGANIZATION ATLAS · 법령 기반</text>`,
    `<text x="0" y="${titleY}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${portrait ? 20 : 21.5}" font-weight="700" letter-spacing="-0.7" fill="${colors.headText}">${xmlEscape(institution)}</text>`,
    `<text x="0" y="${subtitleY}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${portrait ? 10 : 10.5}" font-weight="600" fill="#3E526A">${xmlEscape(subtitle)}</text>`,
    `<text x="${round(pillX - 8)}" y="9" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.6" fill="#64748B">${xmlEscape(meta)}</text>`,
    `<rect x="${round(pillX)}" y="${portrait ? 24 : 21}" width="${pillWidth}" height="20" rx="10" fill="#EEF3F8" stroke="#CBD6E2" stroke-width="0.7"/>`,
    `<text x="${round(pillX + pillWidth / 2)}" y="${portrait ? 37.5 : 34.5}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7.2" font-weight="700" fill="#39536F">${pageLabel}</text>`,
    `<line x1="0" y1="${portrait ? 76 : 64}" x2="${round(width)}" y2="${portrait ? 76 : 64}" stroke="#9CAFC3" stroke-width="0.85"/>`,
  ].join("");
}

function chartTransform(layout, target) {
  const bounds = layoutContentBounds(layout);
  const safeWidth = Math.max(1, bounds.right - bounds.left);
  const safeHeight = Math.max(1, bounds.bottom - bounds.top);
  const nodeCount = layout.nodes?.length || 0;
  const maximumScale = nodeCount <= 4 ? 1.24 : nodeCount <= 10 ? 1.38 : 1.5;
  const scale = Math.max(0.2, Math.min(maximumScale, target.width / safeWidth, target.height / safeHeight));
  const renderedWidth = safeWidth * scale;
  const renderedHeight = safeHeight * scale;
  const offsetX = target.x + (target.width - renderedWidth) / 2 - bounds.left * scale;
  const offsetY = target.y + (target.height - renderedHeight) / 2 - bounds.top * scale;
  const x = (value) => value * scale + offsetX;
  const y = (value) => value * scale + offsetY;
  const position = (source = {}) => {
    const width = (source.width || 0) * scale;
    const height = (source.height || 0) * scale;
    const left = x(source.left || 0);
    const top = y(source.top || 0);
    return {
      ...source,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      centerX: left + width / 2,
      centerY: top + height / 2,
    };
  };
  return {
    scale,
    x,
    y,
    position,
    point: (point) => ({ x: x(point.x), y: y(point.y) }),
  };
}

function layoutContentBounds(layout) {
  const xs = [];
  const ys = [];
  const add = (x, y) => {
    if (Number.isFinite(x)) xs.push(x);
    if (Number.isFinite(y)) ys.push(y);
  };
  for (const { position } of layout.nodes || []) {
    add(position.left, position.top);
    add(position.right ?? position.left + position.width, position.bottom ?? position.top + position.height);
  }
  for (const edge of layout.edges || []) {
    for (const point of edge.routePoints || []) add(point.x, point.y);
  }
  for (const line of layout.implicitConnectors || []) {
    add(line.x1, line.y1);
    add(line.x2, line.y2);
  }
  for (const group of layout.groupBoxes || []) {
    add(group.left, group.top);
    add(group.left + group.width, group.top + group.height);
  }
  if (!xs.length || !ys.length) {
    const frame = layout.frame || { left: 0, top: 0, width: 100, height: 100 };
    return {
      left: frame.left,
      top: frame.top,
      right: frame.left + frame.width,
      bottom: frame.top + frame.height,
    };
  }
  const padding = 7;
  return {
    left: Math.min(...xs) - padding,
    top: Math.min(...ys) - padding,
    right: Math.max(...xs) + padding,
    bottom: Math.max(...ys) + padding,
  };
}

function hwpxConnectorLayer(layout, transform, colors) {
  const edges = layout.edges || [];
  if (!edges.length) return "";
  const verticalGroups = new Map();
  const fallback = [];
  for (const edge of edges) {
    if (!edge.from || !edge.to || edge.orientation === "horizontal") {
      fallback.push(edge);
      continue;
    }
    const from = transform.position(edge.from);
    const to = transform.position(edge.to);
    if (to.top < from.bottom + 2) {
      fallback.push(edge);
      continue;
    }
    const styleKey = connectorStyleKey(edge.type);
    const rowKey = Math.round(to.top / 4);
    const key = `${edge.parent || "-"}|${styleKey}|${rowKey}`;
    if (!verticalGroups.has(key)) verticalGroups.set(key, []);
    verticalGroups.get(key).push({ edge, from, to });
  }
  const parts = [];
  for (const group of verticalGroups.values()) parts.push(hwpxBusConnector(group, colors));
  for (const edge of fallback) parts.push(hwpxEdge(edge, transform, colors));
  return parts.join("");
}

function hwpxBusConnector(group, colors) {
  const first = group[0];
  const style = connectorStyle(first.edge.type, colors);
  const parentX = first.from.centerX;
  const parentY = first.from.bottom - 0.85;
  const childTop = Math.min(...group.map(({ to }) => to.top));
  const gap = Math.max(4, childTop - first.from.bottom);
  const busY = first.from.bottom + Math.max(5, Math.min(24, gap * 0.5));
  const childXs = group.map(({ to }) => to.centerX);
  const minX = Math.min(parentX, ...childXs);
  const maxX = Math.max(parentX, ...childXs);
  const paths = [`M ${round(parentX)} ${round(parentY)} V ${round(busY)}`];
  if (Math.abs(maxX - minX) > 0.15) paths.push(`M ${round(minX)} ${round(busY)} H ${round(maxX)}`);
  for (const { to } of group) {
    paths.push(`M ${round(to.centerX)} ${round(busY)} V ${round(to.top + 0.85)}`);
  }
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
  const path = `<path d="${paths.join(" ")}" fill="none" stroke="${style.color}" stroke-width="${style.width}" stroke-linecap="square" stroke-linejoin="miter" vector-effect="non-scaling-stroke"${dash}/>`;
  const junctions = [...new Set([parentX, ...childXs].map((value) => round(value)))]
    .map((x) => `<circle cx="${x}" cy="${round(busY)}" r="0.82" fill="${style.color}"/>`)
    .join("");
  return `<g data-connector-parent="${xmlEscape(first.edge.parent || "")}" data-connector-kind="${connectorStyleKey(first.edge.type)}">${path}${junctions}</g>`;
}

function connectorStyleKey(type) {
  if (type === "affiliated" || type === "temporary") return "affiliate";
  if (type === "jurisdiction") return "jurisdiction";
  if (type === "advisor") return "staff";
  return "main";
}

function connectorStyle(type, colors) {
  const key = connectorStyleKey(type);
  if (key === "affiliate") return { color: colors.edgeAffiliate, width: 1.05, dash: "5 4" };
  if (key === "jurisdiction") return { color: colors.edgeJurisdiction, width: 1.05, dash: "5 4" };
  if (key === "staff") return { color: colors.edgeStaff, width: 1.05, dash: "5 4" };
  return { color: colors.edge, width: 1.05, dash: "" };
}

function hwpxEdge(edge, transform, colors) {
  const type = edge.type || "assistant";
  const color = type === "affiliated" || type === "temporary"
    ? colors.edgeAffiliate
    : type === "jurisdiction"
      ? colors.edgeJurisdiction
      : type === "advisor"
        ? colors.edgeStaff
        : colors.edge;
  const dash = ["advisor", "temporary", "jurisdiction"].includes(type) ? ` stroke-dasharray="5 4"` : "";
  const marker = edge.orientation === "horizontal"
    ? ` marker-end="url(#${type === "affiliated" || type === "temporary" ? "hwpx-arrow-affiliate" : type === "jurisdiction" ? "hwpx-arrow-jurisdiction" : type === "advisor" ? "hwpx-arrow-staff" : "hwpx-arrow-main"})"`
    : "";
  const transformed = {
    ...edge,
    from: transform.position(edge.from),
    to: transform.position(edge.to),
    routePoints: (edge.routePoints || []).map(transform.point),
  };
  return `<path d="${edgeRoute(transformed)}" fill="none" stroke="${color}" stroke-width="1.05" stroke-linecap="square" stroke-linejoin="round" vector-effect="non-scaling-stroke"${dash}${marker}/>`;
}

function hwpxImplicitConnector(connector, transform, colors) {
  return `<line x1="${round(transform.x(connector.x1))}" y1="${round(transform.y(connector.y1))}" x2="${round(transform.x(connector.x2))}" y2="${round(transform.y(connector.y2))}" stroke="${colors.cardSoftLine}" stroke-width="0.9" stroke-linecap="square" vector-effect="non-scaling-stroke"/>`;
}

function hwpxGroupBox(group, transform) {
  const position = transform.position(group);
  const caption = group.caption
    ? `<text x="${round(position.left + 7)}" y="${round(position.top + 11)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="7" font-weight="600" fill="#64748B">${xmlEscape(group.caption)}</text>`
    : "";
  return `<g><rect x="${round(position.left)}" y="${round(position.top)}" width="${round(position.width)}" height="${round(position.height)}" rx="5" fill="#F6F8FB" stroke="#D2DAE5" stroke-width="0.8"/>${caption}</g>`;
}

function hwpxLayoutLabel(label, transform) {
  return `<text x="${round(transform.x(label.x))}" y="${round(transform.y(label.y))}" text-anchor="${label.align || "start"}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${label.muted ? 6.4 : 7.2}" font-weight="${label.muted ? 400 : 600}" fill="${label.muted ? "#94A3B8" : "#64748B"}">${xmlEscape(label.text)}</text>`;
}

function hwpxNode(node, position, { showLawCounts, colors }) {
  const style = nodeStyle(node);
  const markerText = compactNodeMarkers(node, { showLawCounts });
  const vertical = Boolean(position.vertical && position.width < 48);
  const strokeWidth = node.kind === "head" || node.kind === "deputy" ? 1.35 : 1.05;
  const dash = style.lineStyle === "dashed" ? ` stroke-dasharray="4 3"` : "";
  const rect = `<rect x="${round(position.left)}" y="${round(position.top)}" width="${round(position.width)}" height="${round(position.height)}" rx="${vertical ? 2 : 4}" fill="${style.fill}" stroke="${style.line}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"${dash}/>`;
  const accent = node.kind === "head" || node.kind === "deputy" || node.metadata?.unitRole === "headquarters"
    ? `<line x1="${round(position.left + 5)}" y1="${round(position.top + 2.3)}" x2="${round(position.right - 5)}" y2="${round(position.top + 2.3)}" stroke="${style.line}" stroke-width="1.25" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
    : "";
  const label = vertical
    ? hwpxVerticalNodeLabel(node.name, markerText, position, style)
    : hwpxHorizontalNodeLabel(node.name, markerText, position, style);
  const responsibility = node.metadata?.responsible
    ? `<circle cx="${round(position.right - 5)}" cy="${round(position.top + 5)}" r="2.2" fill="${colors.affiliateLine}"/>`
    : "";
  return `<g>${rect}${accent}${responsibility}${label}</g>`;
}

function hwpxVerticalNodeLabel(name, markers, position, style) {
  const markerHeight = markers ? 11 : 0;
  const characters = [...String(name || "")];
  const availableHeight = Math.max(12, position.height - 8 - markerHeight);
  const lineHeight = Math.min(10.2, Math.max(5.6, availableHeight / Math.max(1, characters.length)));
  const fontSize = Math.min(9.5, Math.max(5.4, lineHeight - 0.35));
  const totalHeight = characters.length * lineHeight;
  const startY = position.top + 4 + Math.max(0, (availableHeight - totalHeight) / 2) + lineHeight * 0.8;
  const text = characters.map((character, index) => `<tspan x="${round(position.centerX)}" y="${round(startY + index * lineHeight)}">${xmlEscape(character)}</tspan>`).join("");
  const marker = markers
    ? `<text x="${round(position.centerX)}" y="${round(position.bottom - 3.2)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.2" font-weight="600" fill="#53657A">${xmlEscape(markers)}</text>`
    : "";
  return `<text text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${round(fontSize)}" font-weight="${style.bold ? 700 : 500}" fill="${style.text}">${text}</text>${marker}`;
}

function hwpxHorizontalNodeLabel(name, markers, position, style) {
  const markerHeight = markers ? 9.5 : 0;
  const fontSize = position.height >= 42 ? 8.9 : position.width >= 110 ? 9.3 : 8.4;
  const maxChars = Math.max(3, Math.floor((position.width - 9) / (fontSize * 0.82)));
  const maxLines = position.height >= 42 ? (markers ? 2 : 3) : markers ? 2 : 2;
  const lines = balancedLabelLines(name, maxChars, maxLines);
  const lineHeight = fontSize + 1.25;
  const contentHeight = position.height - markerHeight;
  const totalHeight = lines.length * lineHeight;
  const startY = position.top + Math.max(2, (contentHeight - totalHeight) / 2) + lineHeight * 0.78;
  const text = lines.map((line, index) => `<tspan x="${round(position.centerX)}" y="${round(startY + index * lineHeight)}">${xmlEscape(line)}</tspan>`).join("");
  const marker = markers
    ? `<text x="${round(position.centerX)}" y="${round(position.bottom - 2.8)}" text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="5.6" font-weight="600" letter-spacing="0.15" fill="#53657A">${xmlEscape(markers)}</text>`
    : "";
  return `<text text-anchor="middle" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${round(fontSize)}" font-weight="${style.bold ? 700 : 500}" fill="${style.text}">${text}</text>${marker}`;
}

function balancedLabelLines(value, maxChars, maxLines) {
  const characters = [...String(value || "")];
  if (characters.length <= maxChars) return [characters.join("")];
  const lineCount = Math.min(maxLines, Math.ceil(characters.length / maxChars));
  const capacity = maxChars * lineCount;
  const visible = characters.length > capacity
    ? [...characters.slice(0, Math.max(1, capacity - 1)), "…"]
    : characters;
  const size = Math.ceil(visible.length / lineCount);
  const lines = [];
  for (let index = 0; index < visible.length; index += size) {
    lines.push(visible.slice(index, index + size).join(""));
  }
  return lines.slice(0, maxLines);
}

function compactNodeMarkers(node, { showLawCounts = false } = {}) {
  const displayed = displayNodeName(node, false, { showLawCounts });
  const suffix = displayed.startsWith(node.name) ? displayed.slice(node.name.length) : "";
  const markers = [...suffix.matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .filter((marker) => !["소속", "부속", "특지"].includes(marker));
  return [...new Set(markers)].join("·");
}

function hwpxPlateLegend(graph, page, layout, { width, height, portrait, colors }) {
  const y = height - (portrait ? 19 : 17);
  const fontSize = portrait ? 5.8 : 6.1;
  const markerLegend = markerLegendForPage(graph, page);
  const actionableQualityIssues = (layout.diagnostics?.qualityIssues || [])
    .filter((issue) => issue.reason !== "unbalanced-columns");
  const warningCount = actionableQualityIssues.length +
    (layout.diagnostics?.overflow?.length || 0) +
    (layout.diagnostics?.overlaps?.length || 0) +
    (layout.diagnostics?.edgeIssues?.length || 0);
  const status = warningCount
    ? `<text x="${round(width)}" y="${round(y)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" font-weight="600" fill="#9A6700">△ 배치 확인 ${warningCount}</text>`
    : `<text x="${round(width)}" y="${round(y)}" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" font-weight="600" fill="#497A50">● 배치 점검 완료</text>`;
  return [
    `<line x1="0" y1="${round(y - 2.2)}" x2="18" y2="${round(y - 2.2)}" stroke="${colors.edge}" stroke-width="1"/><text x="23" y="${round(y)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" fill="#556477">보조·지휘</text>`,
    `<line x1="76" y1="${round(y - 2.2)}" x2="94" y2="${round(y - 2.2)}" stroke="${colors.edgeStaff}" stroke-width="1" stroke-dasharray="4 3"/><text x="99" y="${round(y)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" fill="#556477">보좌</text>`,
    `<rect x="132" y="${round(y - 8.5)}" width="13" height="9" rx="1.5" fill="${colors.affiliateFill}" stroke="${colors.affiliateLine}" stroke-width="0.7"/><text x="151" y="${round(y)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" fill="#556477">소속기관</text>`,
    markerLegend ? `<text x="205" y="${round(y)}" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="${fontSize}" fill="#7A8798">표식 ${xmlEscape(markerLegend)}</text>` : "",
    status,
  ].join("");
}

function markerLegendForPage(graph, page) {
  const definitions = {
    가: "가급", 나: "나급", 연: "연구직", 지: "지도직", 전: "전문직", 임: "임기제",
    별: "별정직", 특: "특정직", 책: "책임운영", 총: "총액", 자: "자율", 평: "평가", 한: "한시",
  };
  const used = [];
  for (const id of page.nodeIds || []) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    for (const marker of compactNodeMarkers(node).split("·").filter(Boolean)) {
      if (definitions[marker] && !used.includes(marker)) used.push(marker);
    }
  }
  return used.slice(0, 7).map((marker) => `${marker} ${definitions[marker]}`).join(" · ");
}

function formatKoreanDate(value) {
  const normalized = String(value || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}. ${Number(match[2])}. ${Number(match[3])}.` : String(value || "");
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function assemblePackage({ sectionXml, contentHpf, previewText, previewImage, images }) {
  const template = await JSZip.loadAsync(Buffer.from(HWPX_TEMPLATE_BASE64, "base64"));
  const output = new JSZip();
  output.file("mimetype", HWPX_MIMETYPE, { compression: "STORE" });

  const entries = Object.values(template.files).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.dir || TEMPLATE_OVERRIDES.has(entry.name) || entry.name.startsWith("BinData/")) continue;
    output.file(entry.name, await entry.async("uint8array"));
  }
  output.file("Contents/content.hpf", contentHpf);
  output.file("Contents/section0.xml", sectionXml);
  output.file("Preview/PrvText.txt", previewText);
  output.file("Preview/PrvImage.png", previewImage);
  output.file(
    "settings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
  );
  for (const image of images) output.file(image.href, image.bytes);

  return output.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
}

function buildSectionXml({ graph, pages, images, pageSpec, audit, traceRows, title }) {
  const ids = createIdFactory();
  const body = [];
  body.push(sectionPictureParagraph(images[0], pageSpec, ids));
  for (let index = 1; index < images.length; index += 1) {
    body.push(pictureParagraph(images[index], pageSpec, ids, { pageBreak: true }));
  }

  body.push(textParagraph(title, 21, 8, ids, { pageBreak: true }));
  body.push(textParagraph(
    [
      graph.meta.asOf ? `기준일 ${graph.meta.asOf}` : "기준일 미기재",
      graph.meta.renderView === "operational" ? "운영상 소관형" : "법정 설치형",
      `조직 ${audit.summary.nodes}개 · 관계 ${audit.summary.edges}건`,
    ].join("  |  "),
    20,
    7,
    ids,
  ));
  body.push(textParagraph(statusMessage(audit), 29, 17, ids));
  body.push(sectionHeading("Ⅰ", "자동점검 요약", pageSpec.textWidth, ids));
  body.push(buildTable(
    ["점검 항목", "결과"],
    summaryRows(audit, pages, traceRows),
    [0.34, 0.66],
    pageSpec.textWidth,
    ids,
  ));

  body.push(sectionHeading("Ⅱ", "사람 검토 체크리스트", pageSpec.textWidth, ids));
  for (const item of checklistRows(audit)) body.push(textParagraph(`□ ${item}`, 25, 12, ids));

  body.push(sectionHeading("Ⅲ", "조직 관계 근거표", pageSpec.textWidth, ids));
  body.push(textParagraph(
    "상위조직·관계·하위조직·근거는 한글/HOP에서 직접 수정할 수 있습니다.",
    27,
    14,
    ids,
  ));
  body.push(buildTable(
    ["상위조직", "관계", "하위조직", "근거·출처"],
    relationshipRows(traceRows),
    [0.18, 0.14, 0.2, 0.48],
    pageSpec.textWidth,
    ids,
    { repeatHeader: true },
  ));

  body.push(sectionHeading("Ⅳ", "출처·검토 확인", pageSpec.textWidth, ids));
  const sources = normalizeSources(graph.meta.sourceInventory?.length ? graph.meta.sourceInventory : graph.meta.sources);
  for (const source of sources.length ? sources : ["입력 출처가 기록되지 않았습니다."]) {
    body.push(textParagraph(`○ ${source}`, 25, 12, ids));
  }
  body.push(buildTable(
    ["검토자", "검토일", "판정"],
    [["", "", "□ 이상 없음  □ 보완 필요  □ 원문 재확인"]],
    [0.28, 0.24, 0.48],
    pageSpec.textWidth,
    ids,
  ));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">${body.join("")}</hs:sec>`;
}

function sectionPropertiesParagraph(spec, ids) {
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${sectionPropertiesRun(spec)}<hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`;
}

function sectionPictureParagraph(image, spec, ids) {
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${sectionPropertiesRun(spec)}${pictureRun(image, spec, ids)}</hp:p>`;
}

function sectionPropertiesRun(spec) {
  return `<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="${spec.landscape ? "WIDELY" : "NARROWLY"}" width="${spec.pageWidth}" height="${spec.pageHeight}" gutterType="LEFT_ONLY"><hp:margin header="${spec.margin}" footer="${spec.margin}" gutter="0" left="${spec.margin}" right="${spec.margin}" top="${spec.margin}" bottom="${spec.margin}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`;
}

function pictureParagraph(image, spec, ids, { pageBreak = false } = {}) {
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${pictureRun(image, spec, ids)}</hp:p>`;
}

function pictureRun(image, spec, ids) {
  const fitted = fitImage(image.sourceWidth, image.sourceHeight, spec.textWidth, spec.textHeight);
  const width = fitted.width;
  const height = fitted.height;
  const shapeId = ids();
  return `<hp:run charPrIDRef="0"><hp:pic id="${shapeId}" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${shapeId}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${width}" height="${height}"/><hp:curSz width="${width}" height="${height}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(width / 2)}" centerY="${Math.round(height / 2)}" rotateimage="0"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="${image.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${width}" y="0"/><hc:pt2 x="${width}" y="${height}"/><hc:pt3 x="0" y="${height}"/></hp:imgRect><hp:imgClip left="0" right="${width}" top="0" bottom="${height}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${width}" dimheight="${height}"/><hp:effects/><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="CENTER" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic></hp:run>`;
}

function textParagraph(text, paraPr, charPr, ids, { pageBreak = false } = {}) {
  return `<hp:p id="${ids()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${xmlEscape(text)}</hp:t></hp:run></hp:p>`;
}

function sectionHeading(number, title, width, ids) {
  const numWidth = 3000;
  const gapWidth = 700;
  const titleWidth = width - numWidth - gapWidth;
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${ids()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="3" cellSpacing="0" borderFillIDRef="8" noAdjust="0"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="2600" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:tr>${tableCell(number, 0, 0, numWidth, 2600, ids, { border: 5, paraPr: 22, charPr: 9 })}${tableCell("", 1, 0, gapWidth, 2600, ids, { border: 6, paraPr: 0, charPr: 0 })}${tableCell(title, 2, 0, titleWidth, 2600, ids, { border: 7, paraPr: 23, charPr: 10 })}</hp:tr></hp:tbl></hp:run></hp:p>`;
}

function buildTable(headers, rows, fractions, width, ids, { repeatHeader = false } = {}) {
  const widths = proportionalWidths(width, fractions);
  const headerHeight = 2700;
  const bodyHeights = rows.map((row) => estimateRowHeight(row, widths));
  const totalHeight = headerHeight + bodyHeights.reduce((sum, value) => sum + value, 0);
  const tr = [];
  tr.push(`<hp:tr>${headers.map((text, col) => tableCell(text, col, 0, widths[col], headerHeight, ids, { header: true, border: 9, paraPr: 28, charPr: 15 })).join("")}</hp:tr>`);
  rows.forEach((row, rowIndex) => {
    tr.push(`<hp:tr>${headers.map((_header, col) => tableCell(row[col] ?? "", col, rowIndex + 1, widths[col], bodyHeights[rowIndex], ids, { border: 10, paraPr: 28, charPr: 16 })).join("")}</hp:tr>`);
  });
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${ids()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${repeatHeader ? 1 : 0}" rowCnt="${rows.length + 1}" colCnt="${headers.length}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${totalHeight}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>${tr.join("")}</hp:tbl></hp:run></hp:p>`;
}

function tableCell(text, col, row, width, height, ids, options = {}) {
  const header = options.header ? 1 : 0;
  const border = options.border ?? (header ? 9 : 10);
  const paraPr = options.paraPr ?? 28;
  const charPr = options.charPr ?? (header ? 15 : 16);
  return `<hp:tc name="" header="${header}" hasMargin="1" protect="0" editable="0" dirty="1" borderFillIDRef="${border}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0" id="${ids()}"><hp:run charPrIDRef="${charPr}"><hp:t>${xmlEscape(text)}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${width}" height="${height}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
}

function documentPageSpec(page) {
  const source = resolvePageSize(page?.paper || "slide");
  const landscape = source.width > source.height;
  const pageWidth = landscape ? 84188 : 59528;
  const pageHeight = landscape ? 59528 : 84188;
  const margin = landscape ? 4252 : 4252;
  return {
    landscape,
    pageWidth,
    pageHeight,
    margin,
    textWidth: pageWidth - margin * 2,
    textHeight: pageHeight - margin * 2,
  };
}

function fitImage(sourceWidth, sourceHeight, maxWidth, maxHeight) {
  const ratio = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * ratio)),
    height: Math.max(1, Math.round(sourceHeight * ratio)),
  };
}

function summaryRows(audit, pages, traceRows) {
  return [
    ["문서 상태", statusLabel(audit.meta.status)],
    ["조직·관계", `조직 ${audit.summary.nodes}개 · 관계 ${audit.summary.edges}건 · 근거표 ${traceRows.length}행`],
    ["조직도 쪽", `${pages.length}쪽`],
    ["우선 확인", audit.reviewActions.length ? `${audit.reviewActions.length}건` : "없음"],
    ["파서 경고", audit.warnings.length ? `${audit.warnings.length}건` : "없음"],
  ];
}

function checklistRows(audit) {
  const base = [
    "직제와 시행규칙의 기준일 연혁이 일치하는지 확인",
    "별표·한시조직·책임운영기관이 빠짐없이 반영되었는지 확인",
    "법정 설치관계와 운영상 소관관계가 구분되었는지 확인",
    "조직 명칭·상위기관·근거 조문과 원문을 대조",
  ];
  for (const action of audit.reviewActions.slice(0, 8)) base.push(action.message);
  return [...new Set(base)];
}

function relationshipRows(traceRows) {
  if (!traceRows.length) return [["-", "-", "-", "관계 근거가 없습니다."]];
  return traceRows.map((row) => [
    row.parent,
    row.relation,
    row.child,
    compactText([
      row.article,
      row.legalBasis,
      row.evidenceText,
      row.edgeSource,
      row.flags,
    ].filter(Boolean).join(" · "), 220),
  ]);
}

function normalizeSources(sources) {
  return (sources || []).map((source) => {
    if (typeof source === "string") return source;
    if (!source || typeof source !== "object") return String(source || "");
    return [source.lawName || source.name || source.title || source.source, source.effectiveDate || source.date, source.role]
      .filter(Boolean)
      .join(" · ");
  }).filter(Boolean);
}

function statusMessage(audit) {
  if (audit.meta.status === "ready") return "⇒ 자동점검상 즉시 수정이 필요한 신호는 없습니다. 원문 대조 후 확정하세요.";
  if (audit.meta.status === "needs-correction") return `⇒ 우선 수정·확인이 필요한 항목이 ${audit.reviewActions.length}건 있습니다.`;
  return `⇒ 사람 검토가 필요한 항목이 ${audit.reviewActions.length}건 있습니다.`;
}

function statusLabel(status) {
  return {
    ready: "자동점검 이상 없음",
    "needs-review": "사람 검토 필요",
    "needs-correction": "수정·원문 확인 필요",
  }[status] || status || "미정";
}

function reportTitle(value) {
  const base = String(value || "정부기관").trim();
  if (/조직도\s*검토보고서$/.test(base)) return base;
  if (/조직도$/.test(base)) return `${base} 검토보고서`;
  return `${base} 조직도 검토보고서`;
}

function estimateRowHeight(row, widths) {
  let lines = 1;
  row.forEach((cell, index) => {
    const approxChars = Math.max(5, Math.floor(widths[index] / 700));
    lines = Math.max(lines, Math.ceil(String(cell ?? "").length / approxChars));
  });
  return Math.min(9200, Math.max(2500, 1150 + lines * 1150));
}

function proportionalWidths(total, fractions) {
  const widths = fractions.map((fraction) => Math.floor(total * fraction));
  widths[widths.length - 1] += total - widths.reduce((sum, value) => sum + value, 0);
  return widths;
}

function buildContentHpf({ title, creator, imageCount, now }) {
  const date = now instanceof Date ? now : new Date(now);
  const iso = Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
  const imageItems = Array.from({ length: imageCount }, (_item, index) => `<opf:item id="image${index + 1}" href="BinData/image${index + 1}.png" media-type="image/png" isEmbeded="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" version="" unique-identifier="" id=""><opf:metadata><opf:title>${xmlEscape(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">${xmlEscape(creator)}</opf:meta><opf:meta name="subject" content="text">정부 조직도 검토보고서</opf:meta><opf:meta name="description" content="text">법령 기반 정부 조직도와 편집 가능한 근거표</opf:meta><opf:meta name="lastsaveby" content="text">${xmlEscape(creator)}</opf:meta><opf:meta name="CreatedDate" content="text">${iso}</opf:meta><opf:meta name="ModifiedDate" content="text">${iso}</opf:meta><opf:meta name="date" content="text">${iso}</opf:meta><opf:meta name="keyword" content="text">조직도,직제,시행규칙</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/>${imageItems}</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
}

function buildPreviewText({ graph, audit, traceRows, title }) {
  return [
    title,
    graph.meta.asOf ? `기준일: ${graph.meta.asOf}` : "",
    `조직 ${audit.summary.nodes}개 · 관계 ${audit.summary.edges}건`,
    statusMessage(audit),
    "",
    ...traceRows.slice(0, 30).map((row) => `${row.parent} -[${row.relation}]-> ${row.child}`),
  ].filter(Boolean).join("\n").slice(0, 4000);
}

function compactText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function createIdFactory() {
  let value = 2100000000;
  return () => value += 1;
}
