import JSZip from "jszip";
import { HWPX_TEMPLATE_BASE64 } from "../docs/assets/hwpx-template.mjs";

/**
 * Write a text document — 개정문 and 신구조문대비표 — as HWPX: flowing paragraphs
 * and a two-column table whose changed words are underlined, on A4 portrait.
 *
 *   createAmendmentHwpxBytes({ title, blocks: [
 *     { type: "title", text },
 *     { type: "paragraph", runs: [{ text, bold, underline }], align, indentMm },
 *     { type: "table", columns: ["현 행", "개 정 안"], rows: [[cellLines, cellLines]] },
 *     { type: "pageBreak" },
 *   ] })
 *
 * A cell is a list of lines; a line is a list of runs ({ text, underline }).
 */

const HWPX_MIMETYPE = "application/hwp+zip";
const HWPUNIT_PER_MM = 7200 / 25.4;
const BODY_FONT_ID = 1; // 함초롬바탕 in the bundled template
const TITLE_FONT_ID = 3; // HY헤드라인M
const PAGE = { widthMm: 210, heightMm: 297, left: 20, right: 20, top: 15, bottom: 15 };
const BODY_WIDTH_MM = PAGE.widthMm - PAGE.left - PAGE.right;
const TEMPLATE_SKIP = new Set([
  "mimetype",
  "Contents/content.hpf",
  "Contents/header.xml",
  "Contents/section0.xml",
  "Preview/PrvImage.png",
  "Preview/PrvText.txt",
  "settings.xml",
]);
const ALIGN = Object.freeze({ left: "JUSTIFY", flush: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFY" });

export async function createAmendmentHwpxBytes(doc, options = {}) {
  const template = await JSZip.loadAsync(Buffer.from(HWPX_TEMPLATE_BASE64, "base64"));
  const headerSource = await template.file("Contents/header.xml").async("string");
  const styles = createStyleRegistry(headerSource);
  const ids = createIdFactory();
  const context = { styles, ids };

  const body = [];
  let pendingBreak = false;
  for (const block of doc.blocks || []) {
    if (block.type === "pageBreak") {
      pendingBreak = true;
      continue;
    }
    body.push(blockXml(block, context, { pageBreak: pendingBreak }));
    pendingBreak = false;
  }
  if (!body.length) body.push(paragraphXml([{ text: "" }], context));
  // The section properties ride on the first paragraph.
  body[0] = body[0].replace(/(<hp:p [^>]*>)/, `$1${sectionPropertiesRun()}`);
  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${SECTION_NAMESPACES}>${body.join("")}</hs:sec>`;
  const title = options.title || doc.title || "개정안";

  const output = new JSZip();
  output.file("mimetype", HWPX_MIMETYPE, { compression: "STORE" });
  for (const entry of Object.values(template.files).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.dir || TEMPLATE_SKIP.has(entry.name) || entry.name.startsWith("BinData/")) continue;
    output.file(entry.name, await entry.async("uint8array"));
  }
  output.file("Contents/content.hpf", contentHpf(title, options.creator || "조직도 생성기"));
  output.file("Contents/header.xml", styles.render());
  output.file("Contents/section0.xml", sectionXml);
  output.file("Preview/PrvText.txt", previewText(doc).slice(0, 4000));
  output.file(
    "settings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
  );
  return output.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
}

function blockXml(block, context, { pageBreak }) {
  if (block.type === "title") {
    return paragraphXml([{ text: block.text, bold: true, sizePt: 15, font: TITLE_FONT_ID }], context, { align: "center", pageBreak, after: 6 });
  }
  if (block.type === "heading") {
    return paragraphXml([{ text: block.text, bold: true, sizePt: 12 }], context, { align: "left", pageBreak, before: 4, after: 2 });
  }
  if (block.type === "table") return tableXml(block, context, { pageBreak });
  const runs = trimRuns(block.runs || [{ text: block.text || "" }]);
  return paragraphXml(runs, context, { align: block.align || "left", indentMm: block.indentMm, pageBreak, sizePt: block.sizePt });
}

function paragraphXml(runs, { styles, ids }, { align = "left", indentMm = 0, pageBreak = false, before = 0, after = 0, sizePt } = {}) {
  const paraPr = styles.paraPr({ align: ALIGN[align] || "JUSTIFY", indent: hwp(indentMm || 0), before: hwp(before), after: hwp(after) });
  const runXml = (runs.length ? runs : [{ text: "" }]).map((run) => {
    const charPr = styles.charPr({ sizePt: run.sizePt || sizePt || 11, bold: Boolean(run.bold), underline: Boolean(run.underline), font: run.font ?? BODY_FONT_ID, color: run.color || "#000000" });
    return `<hp:run charPrIDRef="${charPr}">${run.text ? `<hp:t>${xmlEscape(run.text)}</hp:t>` : "<hp:t/>"}</hp:run>`;
  }).join("");
  return `<hp:p id="${ids()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${runXml}</hp:p>`;
}

function tableXml(block, context, { pageBreak }) {
  const { styles, ids } = context;
  const columns = block.columns || ["현 행", "개 정 안"];
  const widths = columns.map(() => Math.floor(hwp(BODY_WIDTH_MM) / columns.length));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  const margin = { left: hwp(1.8), right: hwp(1.8), top: hwp(1), bottom: hwp(1) };
  const rows = [columns.map((label) => [[{ text: label, bold: true }]]), ...block.rows];
  const rowHeights = rows.map((cells) => Math.max(...cells.map((lines) => estimateHeight(lines, widths[0] - margin.left - margin.right))));
  const trs = rows.map((cells, rowIndex) => {
    const header = rowIndex === 0;
    const tcs = cells.map((lines, colIndex) => {
      const paragraphs = (lines.length ? lines : [[{ text: "" }]]).map((line) => paragraphXml(trimRuns(line), context, { align: header ? "center" : "flush", sizePt: 10 })).join("");
      return `<hp:tc name="" header="${header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${header ? styles.headerCellBorder : styles.cellBorder}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${header ? "CENTER" : "TOP"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphs}</hp:subList><hp:cellAddr colAddr="${colIndex}" rowAddr="${rowIndex}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${widths[colIndex]}" height="${rowHeights[rowIndex]}"/><hp:cellMargin left="${margin.left}" right="${margin.right}" top="${margin.top}" bottom="${margin.bottom}"/></hp:tc>`;
    }).join("");
    return `<hp:tr>${tcs}</hp:tr>`;
  }).join("");
  const height = rowHeights.reduce((sum, value) => sum + value, 0);
  const table = `<hp:tbl id="${ids()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${columns.length}" cellSpacing="0" borderFillIDRef="${styles.cellBorder}" noAdjust="0"><hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="${margin.left}" right="${margin.right}" top="${margin.top}" bottom="${margin.bottom}"/>${trs}</hp:tbl>`;
  const paraPr = styles.paraPr({ align: "LEFT", indent: 0, before: 0, after: hwp(3) });
  const charPr = styles.charPr({ sizePt: 10, bold: false, underline: false, font: BODY_FONT_ID, color: "#000000" });
  return `<hp:p id="${ids()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}">${table}<hp:t/></hp:run></hp:p>`;
}

function trimRuns(line) {
  const runs = line.map((run) => ({ ...run }));
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");
  return runs;
}

// Rough cell height so the table opens with sensible row sizes (Hangul re-flows anyway).
function estimateHeight(lines, innerWidth) {
  const lineHeight = hwp(10 * 0.3528 * 1.6);
  const charsPerLine = Math.max(8, Math.floor(innerWidth / hwp(10 * 0.3528)));
  const count = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.map((run) => run.text).join("").length / charsPerLine)), 0);
  return Math.max(hwp(8), count * lineHeight + hwp(2));
}

function sectionPropertiesRun() {
  const m = (value) => hwp(value);
  return `<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${hwp(PAGE.widthMm)}" height="${hwp(PAGE.heightMm)}" gutterType="LEFT_ONLY"><hp:margin header="0" footer="0" gutter="0" left="${m(PAGE.left)}" right="${m(PAGE.right)}" top="${m(PAGE.top)}" bottom="${m(PAGE.bottom)}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`;
}

function createStyleRegistry(headerSource) {
  const charBase = maxId(headerSource, "charPr") + 1;
  const paraBase = maxId(headerSource, "paraPr") + 1;
  const borderBase = maxId(headerSource, "borderFill") + 1;
  const chars = new Map();
  const paras = new Map();
  const borders = [
    { id: borderBase, fill: "none" },
    { id: borderBase + 1, fill: "#E8E8E8" },
  ];
  return {
    cellBorder: borders[0].id,
    headerCellBorder: borders[1].id,
    charPr({ sizePt, bold, underline, font, color }) {
      const height = Math.round(sizePt * 100);
      const key = `${height}|${bold ? 1 : 0}|${underline ? 1 : 0}|${font}|${color}`;
      if (!chars.has(key)) chars.set(key, { id: charBase + chars.size, height, bold, underline, font, color });
      return chars.get(key).id;
    },
    paraPr({ align, indent, before, after }) {
      const key = `${align}|${indent}|${before}|${after}`;
      if (!paras.has(key)) paras.set(key, { id: paraBase + paras.size, align, indent, before, after });
      return paras.get(key).id;
    },
    render() {
      const charXml = [...chars.values()].map((item) => {
        const f = item.font;
        return `<hh:charPr id="${item.id}" height="${item.height}" textColor="${item.color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef hangul="${f}" latin="${f}" hanja="${f}" japanese="${f}" other="${f}" symbol="${f}" user="${f}"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>${item.bold ? "<hh:bold/>" : ""}<hh:underline type="${item.underline ? "BOTTOM" : "NONE"}" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>`;
      }).join("");
      const paraXml = [...paras.values()].map((item) => {
        const margin = `<hh:margin><hc:intent value="${item.indent}" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${item.before}" unit="HWPUNIT"/><hc:next value="${item.after}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>`;
        return `<hh:paraPr id="${item.id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0" textDir="LTR"><hh:align horizontal="${item.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
      }).join("");
      const borderXml = borders.map((item) => {
        const side = (name) => `<hh:${name} type="SOLID" width="0.12 mm" color="#000000"/>`;
        return `<hh:borderFill id="${item.id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${side("leftBorder")}${side("rightBorder")}${side("topBorder")}${side("bottomBorder")}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="${item.fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush></hh:borderFill>`;
      }).join("");
      return headerSource
        .replace(/<hh:borderFills itemCnt="(\d+)">/, (_m, count) => `<hh:borderFills itemCnt="${Number(count) + borders.length}">`)
        .replace("</hh:borderFills>", `${borderXml}</hh:borderFills>`)
        .replace(/<hh:charProperties itemCnt="(\d+)">/, (_m, count) => `<hh:charProperties itemCnt="${Number(count) + chars.size}">`)
        .replace("</hh:charProperties>", `${charXml}</hh:charProperties>`)
        .replace(/<hh:paraProperties itemCnt="(\d+)">/, (_m, count) => `<hh:paraProperties itemCnt="${Number(count) + paras.size}">`)
        .replace("</hh:paraProperties>", `${paraXml}</hh:paraProperties>`);
    },
  };
}

function maxId(xml, tag) {
  const values = [...xml.matchAll(new RegExp(`<hh:${tag} id="(\\d+)"`, "g"))].map((match) => Number(match[1]));
  return values.length ? Math.max(...values) : -1;
}

function previewText(doc) {
  return (doc.blocks || []).map((block) => {
    if (block.type === "table") return block.rows.map((row) => row.map((cell) => cell.map((line) => line.map((run) => run.text).join("")).join(" ")).join(" | ")).join("\n");
    return block.text || (block.runs || []).map((run) => run.text).join("");
  }).join("\n");
}

function contentHpf(title, creator) {
  const iso = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" version="" unique-identifier="" id=""><opf:metadata><opf:title>${xmlEscape(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">${xmlEscape(creator)}</opf:meta><opf:meta name="subject" content="text">개정안</opf:meta><opf:meta name="CreatedDate" content="text">${iso}</opf:meta><opf:meta name="ModifiedDate" content="text">${iso}</opf:meta><opf:meta name="date" content="text">${iso}</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
}

const SECTION_NAMESPACES = [
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history"',
  'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page"',
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:opf="http://www.idpf.org/2007/opf/"',
  'xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"',
  'xmlns:epub="http://www.idpf.org/2007/ops"',
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"',
].join(" ");

function hwp(mm) {
  return Math.round(Number(mm) * HWPUNIT_PER_MM);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createIdFactory() {
  let value = 1800000000;
  return () => (value += 1);
}
