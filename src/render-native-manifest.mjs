export function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgText(object, geometry, style) {
  const padding = Number(style.paddingMm || 0);
  const fontSize = Number(style.fontSizePt || 6) * 0.352778;
  const raw = String(object.text ?? "");
  const lines = raw.split(/\r?\n/);
  const anchor = style.align === "right" ? "end" : style.align === "center" ? "middle" : "start";
  const x = style.align === "right"
    ? geometry.x + geometry.width - padding
    : style.align === "center"
      ? geometry.x + geometry.width / 2
      : geometry.x + padding;
  const lineHeight = fontSize * 1.18;
  const centerY = geometry.y + geometry.height / 2;
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines.map((line, index) => (
    `<tspan x="${x}" y="${startY + index * lineHeight}">${escapeXml(line)}</tspan>`
  )).join("");
  return `<text text-anchor="${anchor}" dominant-baseline="central" fill="${style.textColor || "#202020"}" font-family="Apple SD Gothic Neo, Malgun Gothic, sans-serif" font-size="${fontSize}" font-weight="${style.bold ? 700 : 500}">${tspans}</text>`;
}

function dashAttr(style) {
  if (style.dashArray) return `stroke-dasharray="${style.dashArray}"`;
  if (style.dash === "dash") return `stroke-dasharray="2.6 1.4"`;
  return "";
}

export function svgObject(object) {
  const style = object.style || {};
  const geometry = object.geometry || {};
  if (object.type === "line") {
    return `<line x1="${geometry.x1}" y1="${geometry.y1}" x2="${geometry.x2}" y2="${geometry.y2}" stroke="${style.stroke}" stroke-width="${style.strokeWidthMm}" stroke-linecap="square" ${dashAttr(style)}/>`;
  }
  const fill = style.fill === "none" ? "none" : style.fill;
  const stroke = style.stroke === "none" ? "none" : style.stroke;
  const rectangle = `<rect x="${geometry.x}" y="${geometry.y}" width="${geometry.width}" height="${geometry.height}" fill="${fill}" stroke="${stroke}" stroke-width="${style.strokeWidthMm || 0}" ${dashAttr(style)}/>`;
  if (object.type !== "textbox") return rectangle;
  return `${rectangle}${svgText(object, geometry, style)}`;
}

export function renderNativeManifestSvg(manifest) {
  const width = Number(manifest.page?.widthMm || 210);
  const height = Number(manifest.page?.heightMm || 297);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${(manifest.objects || []).map(svgObject).join("\n  ")}
</svg>`;
}

export function nativePreviewWidth(manifest, baseWidth = 1480) {
  const width = Number(manifest.page?.widthMm || 210);
  return Math.round(baseWidth * (width / 210));
}
