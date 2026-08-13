import { HWPX_TEMPLATE_BASE64 } from "./assets/hwpx-template.mjs";

const HWPX_MIMETYPE = "application/hwp+zip";
const JSZIP_ESM = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
const OVERRIDES = new Set([
  "mimetype",
  "Contents/content.hpf",
  "Contents/section0.xml",
  "Preview/PrvImage.png",
  "Preview/PrvText.txt",
  "settings.xml",
]);

export async function downloadBrowserHwpx(data, filename) {
  const bytes = await createBrowserHwpx(data);
  const blob = new Blob([bytes], { type: HWPX_MIMETYPE });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function createBrowserHwpx(data) {
  const chartSvg = buildBrowserChartSvg(data);
  const [{ default: JSZip }, chart] = await Promise.all([
    import(JSZIP_ESM),
    rasterizeSvg(chartSvg, { width: 3154, height: 2126, plate: true }),
  ]);
  const title = `${data.agency} 조직도 검토보고서`;
  const section = buildSection(data, chart, title);
  const preview = await makePreview(chart.bytes);
  const template = await JSZip.loadAsync(base64Bytes(HWPX_TEMPLATE_BASE64));
  const output = new JSZip();
  output.file("mimetype", HWPX_MIMETYPE, { compression: "STORE" });
  const entries = Object.values(template.files).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.dir || OVERRIDES.has(entry.name) || entry.name.startsWith("BinData/")) continue;
    output.file(entry.name, await entry.async("uint8array"));
  }
  output.file("Contents/content.hpf", contentHpf(title));
  output.file("Contents/section0.xml", section);
  output.file("Preview/PrvText.txt", previewText(data, title));
  output.file("Preview/PrvImage.png", preview);
  output.file("BinData/image1.png", chart.bytes);
  output.file("settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`);
  const bytes = await output.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const check = await JSZip.loadAsync(bytes);
  for (const required of ["mimetype", "Contents/header.xml", "Contents/section0.xml", "BinData/image1.png"]) {
    if (!check.file(required)) throw new Error(`HWPX 필수 항목 누락: ${required}`);
  }
  return bytes;
}

export function buildBrowserChartSvg(data) {
  const width = 756.84;
  const height = 510.24;
  const source = svgSource(data.svg || "");
  const cropTop = Math.min(60, Math.max(0, source.height - 1));
  const chartX = 13;
  const chartY = 83;
  const chartWidth = width - chartX * 2;
  const chartHeight = 381;
  const view = data.view === "operational" ? "운영상 소관형" : "법정 설치형";
  const assessment = data.assessment?.level || "warning";
  const status = assessment === "ready"
    ? { color: "#497A50", text: "● 스냅샷 기준일 일치" }
    : { color: "#9A6700", text: "△ 후속 개정 확인 필요" };
  const meta = `${formatDate(data.asOf)} 기준 · ${view}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">
  <rect width="${width}" height="${height}" fill="#FFFFFF"/>
  <text x="0" y="9" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.4" font-weight="700" letter-spacing="1.2" fill="#607086">ORGANIZATION ATLAS · 법령 기반</text>
  <text x="0" y="29" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="21.5" font-weight="700" letter-spacing="-0.7" fill="#102A43">${escapeXml(data.agency || "정부기관")}</text>
  <text x="0" y="52" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="10.5" font-weight="600" fill="#3E526A">HWPX 조직도 · 공개 스냅샷</text>
  <text x="${width}" y="9" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.6" fill="#64748B">${escapeXml(meta)}</text>
  <line x1="0" y1="64" x2="${width}" y2="64" stroke="#9CAFC3" stroke-width="0.85"/>
  <rect x="1" y="76" width="${width - 2}" height="400" rx="8" fill="#FBFCFE" stroke="#D8E0EA" stroke-width="0.85"/>
  <svg x="${chartX}" y="${chartY}" width="${chartWidth}" height="${chartHeight}" viewBox="0 ${cropTop} ${source.width} ${Math.max(1, source.height - cropTop)}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${source.body}</svg>
  <line x1="0" y1="491.04" x2="18" y2="491.04" stroke="#64748B" stroke-width="1"/><text x="23" y="493.24" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.1" fill="#556477">보조·지휘</text>
  <line x1="76" y1="491.04" x2="94" y2="491.04" stroke="#7C8797" stroke-width="1" stroke-dasharray="4 3"/><text x="99" y="493.24" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.1" fill="#556477">보좌</text>
  <rect x="132" y="484.74" width="13" height="9" rx="1.5" fill="#E1EFDF" stroke="#4B7A4E" stroke-width="0.7"/><text x="151" y="493.24" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.1" fill="#556477">소속기관</text>
  <text x="${width}" y="493.24" text-anchor="end" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="6.1" font-weight="600" fill="${status.color}">${status.text}</text>
</svg>`;
}

async function rasterizeSvg(svg, { width = 1800, height, plate = false } = {}) {
  const dimensions = svgDimensions(svg);
  const targetHeight = height || Math.max(900, Math.round(width * dimensions.height / dimensions.width));
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, targetHeight);
    context.drawImage(image, 0, 0, width, targetHeight);
    const png = await canvasBlob(canvas, "image/png");
    return { bytes: new Uint8Array(await png.arrayBuffer()), width, height: targetHeight, plate };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function makePreview(pngBytes) {
  const url = URL.createObjectURL(new Blob([pngBytes], { type: "image/png" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = Math.max(180, Math.round(320 * image.height / image.width));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, "image/png");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buildSection(data, chart, title) {
  const ids = idFactory();
  const width = 84188;
  const height = 59528;
  const margin = 4252;
  const textWidth = width - margin * 2;
  const textHeight = height - margin * 2;
  const fitted = chart.plate
    ? { width: textWidth, height: textHeight }
    : fit(chart.width, chart.height, textWidth, textHeight);
  const rows = (data.nodes || [])
    .filter((node) => node.name !== data.agency)
    .map((node) => [
      node.parent || "-",
      kindLabel(node.kind),
      node.name,
      node.jurisdiction || "-",
    ]);
  const parts = [sectionProperties(ids, width, height, margin)];
  parts.push(picture(ids, fitted.width, fitted.height));
  parts.push(paragraph(title, 21, 8, ids, true));
  parts.push(paragraph(`요청 기준일 ${data.asOf || "-"}  |  ${data.view === "operational" ? "운영형" : "법정형"}  |  공개 스냅샷`, 20, 7, ids));
  parts.push(paragraph(`⇒ ${data.assessment?.message || "법제처 원문 대조 후 확정하세요."}`, 29, 17, ids));
  parts.push(heading("Ⅰ", "자동점검 요약", textWidth, ids));
  parts.push(table(
    ["점검 항목", "결과"],
    [
      ["조직·관계", `조직 ${Math.max(0, (data.nodes || []).length - 1)}개 · 법정 관계 ${(data.edges || []).length}건`],
      ["운영상 소관", `${(data.jurisdiction || []).length}건`],
      ["스냅샷 기준일", data.snapshotAsOf || "-"],
      ["날짜 판정", data.assessment?.level || "확인 필요"],
    ],
    [0.34, 0.66],
    textWidth,
    ids,
  ));
  parts.push(heading("Ⅱ", "사람 검토 체크리스트", textWidth, ids));
  for (const item of [
    "직제와 시행규칙의 기준일 연혁 일치",
    "별표·한시조직·책임운영기관 반영",
    "법정 설치관계와 운영상 소관 구분",
    "조직 명칭·상위기관·누락 여부 확인",
  ]) parts.push(paragraph(`□ ${item}`, 25, 12, ids));
  parts.push(heading("Ⅲ", "조직 관계 검토표", textWidth, ids));
  parts.push(paragraph("아래 표는 HOP·한글에서 직접 수정할 수 있습니다.", 27, 14, ids));
  parts.push(table(
    ["법정 상위", "유형", "조직", "운영상 소관"],
    rows.length ? rows : [["-", "-", "-", "-"]],
    [0.24, 0.18, 0.3, 0.28],
    textWidth,
    ids,
    true,
  ));
  parts.push(heading("Ⅳ", "출처·검토 확인", textWidth, ids));
  for (const source of data.sources || []) parts.push(paragraph(`○ ${source}`, 25, 12, ids));
  parts.push(table(
    ["검토자", "검토일", "판정"],
    [["", "", "□ 이상 없음  □ 보완 필요  □ 원문 재확인"]],
    [0.28, 0.24, 0.48],
    textWidth,
    ids,
  ));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">${parts.join("")}</hs:sec>`;
}

function sectionProperties(ids, width, height, margin) {
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${width}" height="${height}" gutterType="LEFT_ONLY"><hp:margin header="${margin}" footer="${margin}" gutter="0" left="${margin}" right="${margin}" top="${margin}" bottom="${margin}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`;
}

function picture(ids, width, height) {
  const shapeId = ids();
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:pic id="${shapeId}" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${shapeId}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${width}" height="${height}"/><hp:curSz width="${width}" height="${height}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(width / 2)}" centerY="${Math.round(height / 2)}" rotateimage="0"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${width}" y="0"/><hc:pt2 x="${width}" y="${height}"/><hc:pt3 x="0" y="${height}"/></hp:imgRect><hp:imgClip left="0" right="${width}" top="0" bottom="${height}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${width}" dimheight="${height}"/><hp:effects/><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="CENTER" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic></hp:run></hp:p>`;
}

function paragraph(text, paraPr, charPr, ids, pageBreak = false) {
  return `<hp:p id="${ids()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`;
}

function heading(number, title, width, ids) {
  const widths = [3000, 700, width - 3700];
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${ids()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="3" cellSpacing="0" borderFillIDRef="8" noAdjust="0"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="2600" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:tr>${cell(number, 0, 0, widths[0], 2600, ids, 5, 22, 9)}${cell("", 1, 0, widths[1], 2600, ids, 6, 0, 0)}${cell(title, 2, 0, widths[2], 2600, ids, 7, 23, 10)}</hp:tr></hp:tbl></hp:run></hp:p>`;
}

function table(headers, rows, fractions, width, ids, repeatHeader = false) {
  const widths = proportional(width, fractions);
  const headerHeight = 2700;
  const bodyHeight = 3000;
  const trs = [`<hp:tr>${headers.map((value, col) => cell(value, col, 0, widths[col], headerHeight, ids, 9, 28, 15, true)).join("")}</hp:tr>`];
  rows.forEach((row, rowIndex) => trs.push(`<hp:tr>${headers.map((_value, col) => cell(row[col] || "", col, rowIndex + 1, widths[col], bodyHeight, ids, 10, 28, 16)).join("")}</hp:tr>`));
  return `<hp:p id="${ids()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="${ids()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${repeatHeader ? 1 : 0}" rowCnt="${rows.length + 1}" colCnt="${headers.length}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${headerHeight + bodyHeight * rows.length}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>${trs.join("")}</hp:tbl></hp:run></hp:p>`;
}

function cell(text, col, row, width, height, ids, border, paraPr, charPr, header = false) {
  return `<hp:tc name="" header="${header ? 1 : 0}" hasMargin="1" protect="0" editable="0" dirty="1" borderFillIDRef="${border}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0" id="${ids()}"><hp:run charPrIDRef="${charPr}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${width}" height="${height}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
}

function contentHpf(title) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" version="" unique-identifier="" id=""><opf:metadata><opf:title>${escapeXml(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">korean-government-orgchart</opf:meta><opf:meta name="subject" content="text">정부 조직도 검토보고서</opf:meta><opf:meta name="description" content="text">법령 기반 정부 조직도와 편집 가능한 관계표</opf:meta><opf:meta name="lastsaveby" content="text">korean-government-orgchart</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/><opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
}

function previewText(data, title) {
  return [
    title,
    `요청 기준일: ${data.asOf || "-"}`,
    `스냅샷 기준일: ${data.snapshotAsOf || "-"}`,
    data.assessment?.message || "",
    ...(data.nodes || []).slice(0, 50).map((node) => `${node.parent || "-"} → ${node.name}`),
  ].filter(Boolean).join("\n").slice(0, 4000);
}

function kindLabel(kind) {
  return kind === "staff" ? "보좌기관" : kind === "affil" ? "소속기관" : kind === "temporary" ? "한시조직" : "보조기관";
}

function svgDimensions(svg) {
  const viewBox = svg.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  return { width: 1120, height: 760 };
}

function svgSource(svg) {
  const dimensions = svgDimensions(svg);
  let body = String(svg || "")
    .replace(/^\s*<svg\b[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "")
    .replace(/<rect\b[^>]*width=["']100%["'][^>]*height=["']100%["'][^>]*\/>/i, "");
  let removedTitles = 0;
  body = body.replace(/<text\b[\s\S]*?<\/text>/gi, (match) => {
    if (removedTitles >= 2) return match;
    removedTitles += 1;
    return "";
  });
  return { ...dimensions, body };
}

function formatDate(value) {
  const normalized = String(value || "-").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}. ${Number(match[2])}. ${Number(match[3])}.` : normalized;
}

function fit(sourceWidth, sourceHeight, maxWidth, maxHeight) {
  const ratio = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return { width: Math.round(sourceWidth * ratio), height: Math.round(sourceHeight * ratio) };
}

function proportional(total, fractions) {
  const values = fractions.map((value) => Math.floor(total * value));
  values[values.length - 1] += total - values.reduce((sum, value) => sum + value, 0);
  return values;
}

function idFactory() {
  let value = 2200000000;
  return () => value += 1;
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function canvasBlob(canvas, type) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("조직도 PNG 변환에 실패했습니다.")), type));
}
