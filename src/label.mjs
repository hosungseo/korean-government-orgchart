import { displayNodeName } from "./layout.mjs";

/**
 * Renderers need identical line breaks so that SVG review output and editable
 * PPTX output do not diverge.  Vertical department boxes are still rendered
 * one character per line; horizontal boxes wrap only when the box width cannot
 * carry a readable single line.
 */
export function nodeLabelLines(node, position, { showLawCounts = false } = {}) {
  if (position?.vertical) return displayNodeName(node, true, { showLawCounts }).split("\n");
  return wrapHorizontalLabel(displayNodeName(node, false, { showLawCounts }), position);
}

export function nodeLabelMetrics(_node, position, lines) {
  const lineCount = Math.max(1, lines?.length || 1);
  if (position?.vertical) {
    const lineHeight = Math.min(10.5, Math.max(6.8, position.height / lineCount - 1.2));
    return {
      lineHeight,
      fontSize: Math.min(10.8, Math.max(6.4, lineHeight - 0.2)),
    };
  }
  const lineHeight = Math.min(14, Math.max(8.6, (position.height - 4) / lineCount));
  const longest = Math.max(1, ...lines.map((line) => [...line].length));
  const widthFit = (position.width - 10) / longest / 0.86;
  return {
    lineHeight,
    fontSize: Math.min(lineCount > 1 ? 10.8 : 12.5, Math.max(7.2, Math.min(lineHeight - 0.6, widthFit))),
  };
}

export function wrapHorizontalLabel(label, position = {}) {
  const text = String(label ?? "").trim();
  if (!text) return [""];
  const maxChars = Math.max(4, Math.floor(((position.width || 80) - 10) / 8.5));
  const maxLines = Math.max(1, Math.min(3, Math.floor(((position.height || 32) - 5) / 10)));
  if ([...text].length <= maxChars) return [text];

  const chunks = tokenAwareChunks(text, maxChars);
  if (chunks.length <= maxLines) return chunks;
  const visible = chunks.slice(0, maxLines - 1);
  visible.push(ellipsize(chunks.slice(maxLines - 1).join(""), maxChars));
  return visible;
}

function tokenAwareChunks(text, maxChars) {
  const tokens = text.split(/(\s+)/).filter((token) => token.trim());
  if (tokens.length <= 1 || tokens.some((token) => [...token].length > maxChars)) {
    return characterChunks(text, maxChars);
  }
  const lines = [];
  let current = "";
  for (const token of tokens) {
    const next = current ? `${current} ${token}` : token;
    if ([...next].length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = token;
  }
  if (current) lines.push(current);
  return lines;
}

function characterChunks(text, maxChars) {
  const characters = [...text];
  const chunks = [];
  for (let index = 0; index < characters.length; index += maxChars) {
    chunks.push(characters.slice(index, index + maxChars).join(""));
  }
  return chunks;
}

function ellipsize(text, maxChars) {
  const characters = [...text];
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}
