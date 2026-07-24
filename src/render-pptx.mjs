import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";
import { displayDate } from "./utils.mjs";
import { displayNodeName, layoutPage, nodeStyle, SLIDE_SIZE } from "./layout.mjs";

const TYPEFACE = "맑은 고딕";

export async function renderPptx(graph, pages, outputPath, { previewDir, showLawCounts = false } = {}) {
  const presentation = Presentation.create({ slideSize: SLIDE_SIZE });
  for (const page of pages) addPage(presentation, graph, page, { showLawCounts });
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

function addPage(presentation, graph, page, { showLawCounts }) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, page.title, { left: 42, top: 22, width: 620, height: 40 }, {
    fontSize: 28,
    bold: true,
    color: "#111827",
    alignment: "left",
  }, "기관명");
  addText(slide, page.subtitle, { left: 42, top: 62, width: 620, height: 23 }, {
    fontSize: 15,
    color: "#4B5563",
    alignment: "left",
  }, "페이지 제목");
  if (graph.meta.asOf) {
    addText(
      slide,
      `< ${displayDate(graph.meta.asOf)} 기준 >`,
      { left: SLIDE_SIZE.width - 300, top: 28, width: 258, height: 22 },
      { fontSize: 13, color: "#6B7280", alignment: "right" },
      "기준일",
    );
  }
  addLine(slide, 42, 92, SLIDE_SIZE.width - 42, 92, "#9CA3AF", "solid", 1);

  if (page.kind === "law-index") {
    addLawIndex(slide, page);
    addText(
      slide,
      `${page.pageNumber} / ${page.pageCount}`,
      { left: SLIDE_SIZE.width - 105, top: 693, width: 68, height: 14 },
      { fontSize: 10, color: "#6B7280", alignment: "right" },
      "쪽번호",
    );
    return;
  }

  const layout = layoutPage(graph, page);

  for (const edge of layout.edges) addEdge(slide, edge);
  for (const entry of layout.nodes) addNode(slide, entry.node, entry.position, { showLawCounts });

  addLegend(slide, { showLawCounts, operational: graph.meta.renderView === "operational" });
  addText(
    slide,
    `${page.pageNumber} / ${page.pageCount}`,
    { left: SLIDE_SIZE.width - 105, top: 693, width: 68, height: 14 },
    { fontSize: 10, color: "#6B7280", alignment: "right" },
    "쪽번호",
  );
}

function addNode(slide, node, position, { showLawCounts }) {
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
  shape.text.style = {
    fontSize: position.vertical ? 10.6 : node.name.length > 13 ? 10.5 : 12.5,
    bold: style.bold,
    color: style.text,
    alignment: "center",
    verticalAlignment: "middle",
    autoFit: "shrinkText",
    typeface: TYPEFACE,
    lineSpacing: position.vertical ? 0.76 : 0.95,
    insets: position.vertical
      ? { top: 3, right: 2, bottom: 3, left: 2 }
      : { top: 3, right: 4, bottom: 3, left: 4 },
  };
  if (showLawCounts && position.vertical && node.metadata?.lawResponsibility?.lawCount) {
    addVerticalLawCount(slide, node.metadata.lawResponsibility.lawCount, position);
  }
}

function addVerticalLawCount(slide, lawCount, position) {
  const width = 26;
  const left = Math.max(0, position.centerX - width / 2);
  const top = Math.min(676, position.bottom + 2);
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

function addEdge(slide, edge) {
  const color =
    edge.type === "affiliated" || edge.type === "temporary" ? "#3D8B3D" : edge.type === "jurisdiction" ? "#4F7EA8" : edge.type === "advisor" ? "#8B8B8B" : "#6B7280";
  const style = edge.type === "advisor" || edge.type === "temporary" || edge.type === "jurisdiction" ? "dashed" : "solid";
  const startX = edge.from.centerX;
  const startY = edge.from.bottom;
  const endX = edge.to.centerX;
  const endY = edge.to.top;
  const midY = startY + Math.max(10, (endY - startY) * 0.48);
  addLine(slide, startX, startY, startX, midY, color, style, 1.05);
  if (Math.abs(startX - endX) > 0.5) addLine(slide, startX, midY, endX, midY, color, style, 1.05);
  addLine(slide, endX, midY, endX, endY, color, style, 1.05);
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

function addLegend(slide, { showLawCounts, operational }) {
  addLine(slide, 42, 697, 62, 697, "#6B7280", "solid", 1);
  addText(slide, "보조·지휘", { left: 67, top: 688, width: 58, height: 16 }, { fontSize: 9.5, color: "#4B5563", alignment: "left" }, "범례-보조");
  addLine(slide, 135, 697, 155, 697, "#8B8B8B", "dashed", 1);
  addText(slide, "보좌", { left: 160, top: 688, width: 38, height: 16 }, { fontSize: 9.5, color: "#4B5563", alignment: "left" }, "범례-보좌");
  if (operational) {
    addLine(slide, 201, 697, 221, 697, "#4F7EA8", "dashed", 1);
    addText(slide, "소관 묶음", { left: 226, top: 688, width: 58, height: 16 }, { fontSize: 9.5, color: "#4B5563", alignment: "left" }, "범례-소관");
  }
  const affiliate = slide.shapes.add({
    geometry: "rect",
    name: "범례-소속기관-색",
    position: { left: operational ? 294 : 208, top: 691, width: 14, height: 10 },
    fill: "#55B947",
    line: { style: "solid", fill: "#2D7D2D", width: 0.8 },
  });
  affiliate.text = "";
  addText(slide, "소속기관", { left: operational ? 313 : 227, top: 688, width: 60, height: 16 }, { fontSize: 9.5, color: "#4B5563", alignment: "left" }, "범례-소속");
  addText(
    slide,
    `${showLawCounts ? "법령수: (법 n)·회색 숫자  " : ""}(가/나) 직무등급  (연) 연구직  (지) 지도직  (전) 전문직·전문경력관  (임) 임기제  (별) 별정직  (특) 특정직  (책) 책임운영  (총) 총액  (자) 자율  (평) 평가  (한) 한시`,
    { left: operational ? 386 : 300, top: 688, width: operational ? 484 : 570, height: 16 },
    { fontSize: 9.5, color: "#4B5563", alignment: "left" },
    "범례-표식",
  );
}

function addLawIndex(slide, page) {
  const columns = 2;
  const rows = 5;
  const columnWidth = 500;
  const columnGap = 38;
  const rowHeight = 105;
  addText(slide, "부서별 소관법령 수와 대표 법령", { left: 42, top: 112, width: 500, height: 22 }, {
    fontSize: 15,
    bold: true,
    color: "#374151",
    alignment: "left",
  }, "소관법령-안내");
  for (const [index, entry] of page.lawEntries.entries()) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const left = 42 + column * (columnWidth + columnGap);
    const top = 146 + row * rowHeight;
    addLine(slide, left, top, left + columnWidth, top, "#D1D5DB", "solid", 0.8);
    addText(slide, entry.name, { left, top: top + 10, width: columnWidth - 64, height: 22 }, {
      fontSize: 15,
      bold: true,
      color: "#111827",
      alignment: "left",
    }, "소관법령-부서");
    addText(slide, `법령 ${entry.lawCount}건`, { left: left + columnWidth - 64, top: top + 10, width: 64, height: 20 }, {
      fontSize: 12,
      bold: true,
      color: "#4B5563",
      alignment: "right",
    }, "소관법령-건수");
    const representatives = entry.laws.map((law) => `· ${law.법령명}`).join("\n");
    addText(slide, representatives || "· 연결된 법령 없음", { left, top: top + 37, width: columnWidth, height: 56 }, {
      fontSize: 11.5,
      color: "#4B5563",
      alignment: "left",
      autoFit: "shrinkText",
      lineSpacing: 0.95,
    }, "소관법령-대표법령");
  }
  addLine(slide, 42, 675, SLIDE_SIZE.width - 42, 675, "#D1D5DB", "solid", 0.8);
  addText(slide, "공동소관 법령은 담당 부서별로 중복 표기될 수 있습니다.", { left: 42, top: 680, width: 600, height: 16 }, {
    fontSize: 10,
    color: "#6B7280",
    alignment: "left",
  }, "소관법령-주석");
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}
