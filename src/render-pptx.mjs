import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";
import { displayDate } from "./utils.mjs";
import { displayNodeName, layoutPage, nodeStyle, resolvePageSize } from "./layout.mjs";

const TYPEFACE = "맑은 고딕";

export async function renderPptx(
  graph,
  pages,
  outputPath,
  { previewDir, showLawCounts = false, paper } = {},
) {
  const pageSize = resolvePageSize(pages[0]?.paper || paper || "slide");
  const presentation = Presentation.create({ slideSize: pageSize });
  for (const page of pages) addPage(presentation, graph, page, { showLawCounts, pageSize });
  const pptx = await PresentationFile.exportPptx(presentation);
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await pptx.save(path.resolve(outputPath));

  if (previewDir) {
    const resolvedPreviewDir = path.resolve(previewDir);
    await fs.mkdir(resolvedPreviewDir, { recursive: true });
    for (const fileName of await fs.readdir(resolvedPreviewDir)) {
      if (/^slide-\d+\.(?:png|layout\.json)$/.test(fileName) || fileName === "montage.webp") {
        await fs.rm(path.join(resolvedPreviewDir, fileName));
      }
    }
    for (const [index, slide] of presentation.slides.items.entries()) {
      const stem = `slide-${String(index + 1).padStart(2, "0")}`;
      await writeBlob(
        path.join(resolvedPreviewDir, `${stem}.png`),
        await presentation.export({ slide, format: "png", scale: 1 }),
      );
      const layout = await slide.export({ format: "layout" });
      await fs.writeFile(path.join(resolvedPreviewDir, `${stem}.layout.json`), await layout.text(), "utf8");
    }
    await writeBlob(
      path.join(resolvedPreviewDir, "montage.webp"),
      await presentation.export({ format: "webp", montage: true, scale: 1 }),
    );
  }
  return presentation;
}

function addPage(presentation, graph, page, { showLawCounts, pageSize }) {
  const portrait = pageSize.height > pageSize.width;
  const half = pageSize.width < 400;
  const margin = portrait ? (half ? 17 : 28) : 42;
  const titleSize = portrait ? (half ? 15 : 21) : 28;
  const subtitleSize = portrait ? (half ? 8 : 11) : 15;
  const headerTop = portrait ? (half ? 11 : 15) : 22;
  const subtitleTop = portrait ? (half ? 31 : 42) : 62;
  const ruleY = portrait ? (half ? 56 : 74) : 92;
  const footerTop = pageSize.height - (portrait ? 24 : 27);
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, page.title, { left: margin, top: headerTop, width: pageSize.width - margin * 2 - 80, height: portrait ? 30 : 40 }, {
    fontSize: titleSize,
    bold: true,
    color: "#111827",
    alignment: "left",
  }, "기관명");
  addText(slide, page.subtitle, { left: margin, top: subtitleTop, width: pageSize.width - margin * 2, height: 23 }, {
    fontSize: subtitleSize,
    color: "#4B5563",
    alignment: "left",
  }, "페이지 제목");
  if (graph.meta.asOf) {
    addText(
      slide,
      `< ${displayDate(graph.meta.asOf)} 기준 >`,
      { left: pageSize.width - margin - (portrait ? (half ? 90 : 130) : 300), top: headerTop + 6, width: portrait ? (half ? 90 : 130) : 258, height: 22 },
      { fontSize: portrait ? (half ? 6.5 : 9) : 13, color: "#6B7280", alignment: "right" },
      "기준일",
    );
  }
  addLine(slide, margin, ruleY, pageSize.width - margin, ruleY, "#9CA3AF", "solid", 1);

  if (page.kind === "law-index") {
    addLawIndex(slide, page, pageSize);
    addText(
      slide,
      `${page.pageNumber} / ${page.pageCount}`,
      { left: pageSize.width - margin - 68, top: footerTop, width: 68, height: 14 },
      { fontSize: 10, color: "#6B7280", alignment: "right" },
      "쪽번호",
    );
    return;
  }

  const layout = layoutPage(graph, page, { pageSize });

  for (const group of layout.groupBoxes || []) addGroupBox(slide, group);
  // Use shape-attached connectors rather than independently positioned line
  // fragments. PowerPoint then keeps every elbow joined to its two boxes
  // when it is opened, resized, or edited by the user.
  const nodeShapes = new Map();
  for (const entry of layout.nodes) {
    nodeShapes.set(entry.node.id, addNode(slide, entry.node, entry.position, { showLawCounts, pageSize }));
  }
  for (const edge of layout.edges) addEdge(slide, edge, nodeShapes);
  for (const label of layout.labels || []) addLayoutLabel(slide, label, pageSize);

  if (layout.diagnostics?.overflow?.length) {
    addText(
      slide,
      `⚠ ${layout.diagnostics.overflow.length}개 조직이 인쇄 영역을 벗어났습니다. 분할 또는 다른 작도 유형을 사용하세요.`,
      { left: margin, top: pageSize.height - (portrait ? 44 : 38), width: pageSize.width - margin * 2 - 90, height: 14 },
      { fontSize: portrait ? 7.5 : 8, color: "#B45309", alignment: "left" },
      "배치진단-넘침",
    );
  }

  addLegend(slide, { showLawCounts, operational: graph.meta.renderView === "operational", pageSize });
  addText(
    slide,
    `${page.pageNumber} / ${page.pageCount}`,
    { left: pageSize.width - margin - 68, top: footerTop, width: 68, height: 14 },
    { fontSize: 10, color: "#6B7280", alignment: "right" },
    "쪽번호",
  );
}

function addNode(slide, node, position, { showLawCounts, pageSize }) {
  const style = nodeStyle(node);
  const shape = slide.shapes.add({
    geometry: position.vertical ? "rect" : "roundRect",
    name: `조직-${node.id}`,
    position: {
      left: position.left,
      top: position.top,
      width: position.width,
      height: position.height,
    },
    fill: style.fill,
    line: { style: style.lineStyle, fill: style.line, width: 1.15 },
    borderRadius: position.vertical ? 1 : 4,
  });
  shape.text = displayNodeName(node, position.vertical, { showLawCounts });
  const verticalLines = position.vertical ? displayNodeName(node, true, { showLawCounts }).split("\n").length : 1;
  const verticalLineHeight = position.vertical
    ? Math.min(10.5, Math.max(6.8, position.height / Math.max(1, verticalLines) - 1.2))
    : 14;
  shape.text.style = {
    fontSize: position.vertical ? Math.min(10.6, Math.max(6.4, verticalLineHeight - 0.2)) : node.name.length > 13 ? 10.5 : 12.5,
    bold: style.bold,
    color: style.text,
    alignment: "center",
    verticalAlignment: "middle",
    autoFit: "shrinkText",
    typeface: TYPEFACE,
    lineSpacing: position.vertical ? Math.max(0.58, Math.min(0.76, verticalLineHeight / 13.5)) : 0.95,
    insets: position.vertical
      ? { top: 3, right: 2, bottom: 3, left: 2 }
      : { top: 3, right: 4, bottom: 3, left: 4 },
  };
  if (showLawCounts && position.vertical && node.metadata?.lawResponsibility?.lawCount) {
    addVerticalLawCount(slide, node.metadata.lawResponsibility.lawCount, position, pageSize);
  }
  return shape;
}

function addGroupBox(slide, group) {
  const shape = slide.shapes.add({
    geometry: "roundRect",
    name: `카드묶음-${group.caption || "상위조직"}`,
    position: { left: group.left, top: group.top, width: group.width, height: group.height },
    fill: "#F8FAFC",
    line: { style: "solid", fill: "#D7DEE8", width: 0.8 },
    borderRadius: 5,
  });
  shape.text = "";
  if (group.caption) {
    addText(
      slide,
      group.caption,
      { left: group.left + 8, top: group.top + 2, width: group.width - 16, height: 14 },
      { fontSize: 8.5, color: "#64748B", alignment: "left" },
      `카드묶음표식-${group.caption}`,
    );
  }
}

function addVerticalLawCount(slide, lawCount, position, pageSize) {
  const width = 26;
  const left = Math.max(0, position.centerX - width / 2);
  const top = Math.min(pageSize.height - 42, position.bottom + 2);
  const badge = slide.shapes.add({
    geometry: "roundRect",
    name: "소관법령수",
    position: { left, top, width, height: 12 },
    fill: "#E5E7EB",
    line: { style: "solid", fill: "#9CA3AF", width: 0.6 },
    borderRadius: 2,
  });
  badge.text = String(lawCount);
  badge.text.style = {
    typeface: TYPEFACE,
    fontSize: 7.5,
    bold: true,
    color: "#374151",
    alignment: "center",
    verticalAlignment: "middle",
    autoFit: "shrinkText",
    insets: { top: 0, right: 1, bottom: 0, left: 1 },
  };
}

function addEdge(slide, edge, nodeShapes) {
  const color =
    edge.type === "affiliated" || edge.type === "temporary" ? "#3D8B3D" : edge.type === "jurisdiction" ? "#4F7EA8" : edge.type === "advisor" ? "#8B8B8B" : "#6B7280";
  const style = edge.type === "advisor" || edge.type === "temporary" || edge.type === "jurisdiction" ? "dashed" : "solid";
  const fromShape = nodeShapes.get(edge.parent);
  const toShape = nodeShapes.get(edge.child);
  if (!fromShape || !toShape) return;
  const horizontal = edge.orientation === "horizontal";
  slide.shapes.connect(fromShape, toShape, {
    kind: "elbow",
    fromSide: horizontal ? "right" : "bottom",
    toSide: horizontal ? "left" : "top",
    line: { style, fill: color, width: 1.1 },
    cap: "round",
    join: "round",
    // Artifact Tool's PPTX connector geometry uses `tail` for the visual end
    // of a left-to-right route.  Keeping it here (rather than `head`) makes
    // the arrow point toward the receiving unit in exported PowerPoint.
    ...(horizontal ? { tail: { type: "arrow", width: "sm", length: "sm" } } : {}),
  });
}

function addLayoutLabel(slide, label, pageSize) {
  const portrait = pageSize.height > pageSize.width;
  addText(
    slide,
    label.text,
    { left: label.x - (label.align === "middle" ? 80 : 0), top: label.y - 12, width: label.align === "middle" ? 160 : 220, height: 14 },
    { fontSize: label.muted ? (portrait ? 7.5 : 8.5) : (portrait ? 8.5 : 10), bold: !label.muted, color: label.muted ? "#94A3B8" : "#6B7280", alignment: label.align === "middle" ? "center" : "left" },
    `레이아웃표식-${label.text}`,
  );
}

function addLine(slide, x1, y1, x2, y2, color, style = "solid", width = 1) {
  slide.shapes.add({
    geometry: "line",
    name: "조직연결선",
    position: {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    },
    fill: "none",
    line: { style, fill: color, width },
  });
}

function addText(slide, text, position, style, name) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    typeface: TYPEFACE,
    verticalAlignment: "middle",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...style,
  };
  return shape;
}

function addLegend(slide, { showLawCounts, operational, pageSize }) {
  const portrait = pageSize.height > pageSize.width;
  if (portrait) {
    const half = pageSize.width < 400;
    const margin = half ? 17 : 28;
    const fontSize = half ? 6.4 : 8.2;
    addLine(slide, margin, pageSize.height - 31, margin + 17, pageSize.height - 31, "#6B7280", "solid", 1);
    addText(slide, "계선", { left: margin + 21, top: pageSize.height - 39, width: 25, height: 14 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-계선");
    addLine(slide, margin + 59, pageSize.height - 31, margin + 76, pageSize.height - 31, "#8B8B8B", "dashed", 1);
    addText(slide, "보좌", { left: margin + 80, top: pageSize.height - 39, width: 25, height: 14 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-보좌");
    const affiliate = slide.shapes.add({
      geometry: "rect",
      name: "범례-소속기관-색",
      position: { left: margin + 115, top: pageSize.height - 38, width: 12, height: 9 },
      fill: "#55B947",
      line: { style: "solid", fill: "#2D7D2D", width: 0.8 },
    });
    affiliate.text = "";
    addText(slide, "소속기관", { left: margin + 132, top: pageSize.height - 39, width: 42, height: 14 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-소속");
    addText(slide, half ? "(가/나) · (책) · (한) · (임)" : "(가/나) 직무등급 · (책) 책임운영 · (한) 한시 · (임) 임기제", { left: half ? margin : 198, top: pageSize.height - (half ? 24 : 39), width: half ? pageSize.width - margin * 2 : pageSize.width - 226, height: 14 }, { fontSize, color: "#4B5563", alignment: "left", autoFit: "shrinkText" }, "범례-표식");
    return;
  }
  const compact = pageSize.width < 1000;
  const legendY = pageSize.height - 23;
  const textTop = legendY - 9;
  const fontSize = compact ? 7.2 : 9.5;
  addLine(slide, 42, legendY, 62, legendY, "#6B7280", "solid", 1);
  addText(slide, "보조·지휘", { left: 67, top: textTop, width: 58, height: 16 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-보조");
  addLine(slide, 135, legendY, 155, legendY, "#8B8B8B", "dashed", 1);
  addText(slide, "보좌", { left: 160, top: textTop, width: 38, height: 16 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-보좌");
  if (operational) {
    addLine(slide, 201, legendY, 221, legendY, "#4F7EA8", "dashed", 1);
    addText(slide, "소관 묶음", { left: 226, top: textTop, width: 58, height: 16 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-소관");
  }
  const affiliateLeft = operational ? 294 : 208;
  const affiliate = slide.shapes.add({
    geometry: "rect",
    name: "범례-소속기관-색",
    position: { left: affiliateLeft, top: legendY - 6, width: 14, height: 10 },
    fill: "#55B947",
    line: { style: "solid", fill: "#2D7D2D", width: 0.8 },
  });
  affiliate.text = "";
  addText(slide, "소속기관", { left: affiliateLeft + 19, top: textTop, width: 60, height: 16 }, { fontSize, color: "#4B5563", alignment: "left" }, "범례-소속");
  const markerLeft = operational ? 386 : 300;
  addText(
    slide,
    `${showLawCounts ? "법령수: (법 n)·회색 숫자  " : ""}(가/나) 직무등급  (연) 연구직  (지) 지도직  (전) 전문직·전문경력관  (임) 임기제  (별) 별정직  (특) 특정직  (책) 책임운영  (총) 총액  (자) 자율  (평) 평가  (한) 한시`,
    { left: markerLeft, top: textTop, width: Math.max(160, pageSize.width - markerLeft - 42), height: 16 },
    { fontSize, color: "#4B5563", alignment: "left", autoFit: "shrinkText" },
    "범례-표식",
  );
}

function addLawIndex(slide, page, pageSize) {
  const portrait = pageSize.height > pageSize.width;
  const margin = portrait ? 28 : 42;
  const footer = pageSize.height - (portrait ? 46 : 45);
  const columns = 2;
  const rows = 5;
  const columnWidth = 500;
  const columnGap = 38;
  const rowHeight = 105;
  const effectiveColumnWidth = portrait ? pageSize.width - margin * 2 : columnWidth;
  const effectiveRowHeight = portrait ? 115 : rowHeight;
  addText(slide, "부서별 소관법령 수와 대표 법령", { left: margin, top: portrait ? 86 : 112, width: effectiveColumnWidth, height: 22 }, {
    fontSize: portrait ? 12 : 15,
    bold: true,
    color: "#374151",
    alignment: "left",
  }, "소관법령-안내");
  for (const [index, entry] of page.lawEntries.entries()) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const left = margin + column * (effectiveColumnWidth + (portrait ? 0 : columnGap));
    const top = (portrait ? 102 : 146) + row * effectiveRowHeight;
    addLine(slide, left, top, left + effectiveColumnWidth, top, "#D1D5DB", "solid", 0.8);
    addText(slide, entry.name, { left, top: top + 10, width: effectiveColumnWidth - 64, height: 22 }, {
      fontSize: portrait ? 11 : 15,
      bold: true,
      color: "#111827",
      alignment: "left",
    }, "소관법령-부서");
    addText(slide, `법령 ${entry.lawCount}건`, { left: left + effectiveColumnWidth - 64, top: top + 10, width: 64, height: 20 }, {
      fontSize: portrait ? 9 : 12,
      bold: true,
      color: "#4B5563",
      alignment: "right",
    }, "소관법령-건수");
    const representatives = entry.laws.map((law) => `· ${law.법령명}`).join("\n");
    addText(slide, representatives || "· 연결된 법령 없음", { left, top: top + 37, width: effectiveColumnWidth, height: 56 }, {
      fontSize: portrait ? 8.5 : 11.5,
      color: "#4B5563",
      alignment: "left",
      autoFit: "shrinkText",
      lineSpacing: 0.95,
    }, "소관법령-대표법령");
  }
  addLine(slide, margin, footer, pageSize.width - margin, footer, "#D1D5DB", "solid", 0.8);
  addText(slide, "공동소관 법령은 담당 부서별로 중복 표기될 수 있습니다.", { left: margin, top: footer + 5, width: effectiveColumnWidth, height: 16 }, {
    fontSize: portrait ? 8 : 10,
    color: "#6B7280",
    alignment: "left",
  }, "소관법령-주석");
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}
