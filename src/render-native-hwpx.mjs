import JSZip from "jszip";
import { HWPX_TEMPLATE_BASE64 } from "../docs/assets/hwpx-template.mjs";

/**
 * Write native organization-chart manifests (kr.go.mois.orgchart.hwp-native/v1)
 * straight to an HWPX package, without driving Windows Hangul over COM.
 *
 * Every manifest becomes one page. Rectangles, text boxes and lines are
 * emitted as paper-anchored drawing objects (hp:rect with hp:drawText,
 * hp:line), the same object kinds hwp-native.ps1 creates one by one, so the
 * result stays fully editable in Hangul. Element order follows what Hangul
 * itself saves for a standalone shape: shape component, outline, fill,
 * shadow, text, points, then sz/pos/outMargin.
 */

const HWPX_MIMETYPE = "application/hwp+zip";
const HWPUNIT_PER_MM = 7200 / 25.4;
const MALGUN_FONT_ID = 2; // 맑은 고딕 in every fontface block of the bundled template
const LINE_SPACING_PERCENT = 160; // Hangul default; the layout sizes boxes for it
const TEMPLATE_SKIP = new Set([
  "mimetype",
  "Contents/content.hpf",
  "Contents/header.xml",
  "Contents/section0.xml",
  "Preview/PrvImage.png",
  "Preview/PrvText.txt",
  "settings.xml",
]);
const DASH_STYLES = Object.freeze({ solid: "SOLID", dash: "DASH", dot: "DOT", none: "NONE" });
const ALIGN = Object.freeze({ left: "LEFT", center: "CENTER", right: "RIGHT" });
const VERTICAL_ALIGN = Object.freeze({ top: "TOP", center: "CENTER", bottom: "BOTTOM" });

export async function createNativeHwpxBytes(manifests, options = {}) {
  const list = Array.isArray(manifests) ? manifests : [manifests];
  if (!list.length) throw new Error("작도 명세가 없습니다.");
  const template = await JSZip.loadAsync(Buffer.from(HWPX_TEMPLATE_BASE64, "base64"));
  const headerSource = await template.file("Contents/header.xml").async("string");
  const styles = createStyleRegistry(headerSource);
  const ids = createIdFactory();

  const page = list[0].page;
  const paragraphs = list.map((manifest, index) => pageParagraph(manifest, index, { styles, ids, page }));
  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${SECTION_NAMESPACES}>${paragraphs.join("")}</hs:sec>`;
  const headerXml = styles.render();
  const title = options.title || list[0].title || "조직도";

  const output = new JSZip();
  output.file("mimetype", HWPX_MIMETYPE, { compression: "STORE" });
  for (const entry of Object.values(template.files).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.dir || TEMPLATE_SKIP.has(entry.name) || entry.name.startsWith("BinData/")) continue;
    output.file(entry.name, await entry.async("uint8array"));
  }
  output.file("Contents/content.hpf", contentHpf(title, options.creator || "조직도 생성기"));
  output.file("Contents/header.xml", headerXml);
  output.file("Contents/section0.xml", sectionXml);
  output.file("Preview/PrvText.txt", previewText(list));
  output.file(
    "settings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
  );
  return output.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
}

function pageParagraph(manifest, index, { styles, ids, page }) {
  const shapes = manifest.objects.map((object, order) => shapeXml(object, order, { styles, ids })).join("");
  const sectionRun = index === 0 ? sectionPropertiesRun(page) : "";
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="${index === 0 ? 0 : 1}" columnBreak="0" merged="0">${sectionRun}<hp:run charPrIDRef="0">${shapes}</hp:run></hp:p>`;
}

function shapeXml(object, zOrder, context) {
  if (object.type === "line") return lineXml(object, zOrder, context);
  return rectXml(object, zOrder, context);
}

function rectXml(object, zOrder, { styles, ids }) {
  const { x, y, width, height } = object.geometry;
  const style = object.style || {};
  const w = hwp(width);
  const h = hwp(height);
  const id = ids();
  const text = object.type === "textbox" ? drawTextXml(object, w, styles, ids) : "";
  const fill = style.fill && style.fill !== "none"
    ? `<hc:fillBrush><hc:winBrush faceColor="${style.fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush>`
    : "";
  return `<hp:rect id="${id}" zOrder="${zOrder}" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${ids()}" ratio="0">`
    + shapeComponent(w, h)
    + lineShapeXml(style)
    + fill
    + `<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>`
    + text
    + `<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/>`
    + placement(w, h, hwp(x), hwp(y))
    + `<hp:shapeComment>${xmlEscape(object.text || object.id || "사각형")}</hp:shapeComment></hp:rect>`;
}

function lineXml(object, zOrder, { ids }) {
  const { x1, y1, x2, y2 } = object.geometry;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const w = hwp(Math.abs(x2 - x1));
  const h = hwp(Math.abs(y2 - y1));
  // Lines that run right-to-left against the vertical direction need the
  // reversed flag; organization charts only draw axis-aligned segments.
  const reversed = (x2 - x1) * (y2 - y1) < 0 ? 1 : 0;
  const start = reversed ? { x: 0, y: h } : { x: 0, y: 0 };
  const end = reversed ? { x: w, y: 0 } : { x: w, y: h };
  return `<hp:line id="${ids()}" zOrder="${zOrder}" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${ids()}" isReverseHV="${reversed}">`
    + shapeComponent(w, h)
    + lineShapeXml(object.style || {})
    + `<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>`
    + `<hc:startPt x="${start.x}" y="${start.y}"/><hc:endPt x="${end.x}" y="${end.y}"/>`
    + placement(w, h, hwp(left), hwp(top))
    + `<hp:shapeComment>선입니다.</hp:shapeComment></hp:line>`;
}

function shapeComponent(w, h) {
  return `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="0" height="0"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`;
}

function lineShapeXml(style) {
  const visible = style.stroke && style.stroke !== "none" && Number(style.strokeWidthMm) > 0;
  const color = visible ? style.stroke : "#000000";
  const width = visible ? Math.max(1, hwp(style.strokeWidthMm)) : 0;
  const dash = visible ? DASH_STYLES[style.dash] || "SOLID" : "NONE";
  return `<hp:lineShape color="${color}" width="${width}" style="${dash}" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/>`;
}

function placement(w, h, horzOffset, vertOffset) {
  return `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="${vertOffset}" horzOffset="${horzOffset}"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`;
}

function drawTextXml(object, boxWidth, styles, ids) {
  const style = object.style || {};
  const paddingX = hwp(style.paddingXMm ?? style.paddingMm ?? 0);
  const paddingY = hwp(style.paddingYMm ?? style.paddingMm ?? 0);
  const charPr = styles.charPr({
    fontSizePt: Number(style.fontSizePt) || 10,
    bold: Boolean(style.bold),
    color: style.textColor || "#000000",
  });
  const paraPr = styles.paraPr(ALIGN[style.align] || "LEFT");
  const lines = String(object.text ?? "").split(/\r?\n/);
  // Hangul saves a line-layout record per paragraph; readers that do not
  // re-flow (rhwp) need it to centre the text vertically in the box.
  const textHeight = Math.round((Number(style.fontSizePt) || 10) * 100);
  const spacing = Math.round(textHeight * (LINE_SPACING_PERCENT - 100) / 100);
  const lineWidth = Math.max(0, boxWidth - paddingX * 2);
  const paragraphs = lines.map((line, index) => (
    `<hp:p id="${ids()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}">${line ? `<hp:t>${xmlEscape(line)}</hp:t>` : "<hp:t/>"}</hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="${index * (textHeight + spacing)}" vertsize="${textHeight}" textheight="${textHeight}" baseline="${Math.round(textHeight * 0.85)}" spacing="${spacing}" horzpos="0" horzsize="${lineWidth}" flags="393216"/></hp:linesegarray></hp:p>`
  )).join("");
  return `<hp:drawText lastWidth="${Math.max(0, boxWidth - paddingX * 2)}" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${VERTICAL_ALIGN[style.verticalAlign] || "CENTER"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphs}</hp:subList><hp:textMargin left="${paddingX}" right="${paddingX}" top="${paddingY}" bottom="${paddingY}"/></hp:drawText>`;
}

function sectionPropertiesRun(page = {}) {
  const widthMm = Number(page.widthMm) || 210;
  const heightMm = Number(page.heightMm) || 297;
  const margin = page.marginMm || {};
  const portrait = heightMm >= widthMm;
  const m = (value) => hwp(Number(value) || 10);
  // Hangul always stores the paper in portrait dimensions and marks the
  // orientation with the flag: WIDELY = 세로, NARROWLY = 가로 (A3 가로 is
  // width 84188 · height 119052 · NARROWLY).
  return `<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="${portrait ? "WIDELY" : "NARROWLY"}" width="${hwp(Math.min(widthMm, heightMm))}" height="${hwp(Math.max(widthMm, heightMm))}" gutterType="LEFT_ONLY"><hp:margin header="0" footer="0" gutter="0" left="${m(margin.left)}" right="${m(margin.right)}" top="${m(margin.top)}" bottom="${m(margin.bottom)}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`;
}

/**
 * Adds the character and paragraph shapes the manifest needs to the template
 * header and keeps the itemCnt attributes in step.
 */
function createStyleRegistry(headerSource) {
  const charBase = maxId(headerSource, "charPr") + 1;
  const paraBase = maxId(headerSource, "paraPr") + 1;
  const chars = new Map();
  const paras = new Map();
  return {
    charPr({ fontSizePt, bold, color }) {
      const height = Math.round(fontSizePt * 100);
      const key = `${height}|${bold ? 1 : 0}|${color.toUpperCase()}`;
      if (!chars.has(key)) chars.set(key, { id: charBase + chars.size, height, bold, color: color.toUpperCase() });
      return chars.get(key).id;
    },
    paraPr(align) {
      if (!paras.has(align)) paras.set(align, { id: paraBase + paras.size, align });
      return paras.get(align).id;
    },
    render() {
      const f = MALGUN_FONT_ID;
      const charXml = [...chars.values()].map((item) => (
        `<hh:charPr id="${item.id}" height="${item.height}" textColor="${item.color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef hangul="${f}" latin="${f}" hanja="${f}" japanese="${f}" other="${f}" symbol="${f}" user="${f}"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>${item.bold ? "<hh:bold/>" : ""}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>`
      )).join("");
      const margin = `<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${LINE_SPACING_PERCENT}" unit="HWPUNIT"/>`;
      const paraXml = [...paras.values()].map((item) => (
        // margin·lineSpacing live in both hp:case and hp:default; Hangul reads default.
        `<hh:paraPr id="${item.id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0" textDir="LTR"><hh:align horizontal="${item.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`
      )).join("");
      return headerSource
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

function contentHpf(title, creator) {
  const iso = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" version="" unique-identifier="" id=""><opf:metadata><opf:title>${xmlEscape(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">${xmlEscape(creator)}</opf:meta><opf:meta name="subject" content="text">조직도</opf:meta><opf:meta name="CreatedDate" content="text">${iso}</opf:meta><opf:meta name="ModifiedDate" content="text">${iso}</opf:meta><opf:meta name="date" content="text">${iso}</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
}

function previewText(manifests) {
  return manifests
    .map((manifest) => manifest.objects.filter((object) => object.type === "textbox" && object.text).map((object) => object.text).join(" · "))
    .join("\n")
    .slice(0, 4000);
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
  let value = 1900000000;
  return () => (value += 1);
}
