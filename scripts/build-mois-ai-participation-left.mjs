import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MOIS_AI_PARTICIPATION_LEFT_SPEC } from "../src/mois-ai-participation-left-spec.mjs";
import { renderSinglePlateHwpx } from "../src/render-hwpx.mjs";
import {
  ORIGINAL_LEFT_STACK_SIZE,
  renderOriginalLeftStackSvg,
} from "../src/render-original-left-stack.mjs";

const outputStem = "행정안전부-인공지능정부실-참여혁신조직실-원형복원-왼쪽면-A4-세로";
const outDir = path.resolve("outputs");
const svgPath = path.join(outDir, `${outputStem}.svg`);
const pngPath = path.join(outDir, `${outputStem}.png`);
const hwpxPath = path.join(outDir, `${outputStem}.hwpx`);

const spec = MOIS_AI_PARTICIPATION_LEFT_SPEC;

await fs.mkdir(outDir, { recursive: true });
const svg = renderOriginalLeftStackSvg(spec);
await fs.writeFile(svgPath, svg, "utf8");

const pixelWidth = 2126;
const pixelHeight = Math.round(pixelWidth * ORIGINAL_LEFT_STACK_SIZE.height / ORIGINAL_LEFT_STACK_SIZE.width);
await sharp(Buffer.from(svg, "utf8"), { density: 300 })
  .flatten({ background: "#FFFFFF" })
  .resize({ width: pixelWidth, height: pixelHeight, fit: "fill" })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(pngPath);

await renderSinglePlateHwpx(svg, hwpxPath, {
  title: "행정안전부 인공지능정부실·참여혁신조직실 왼쪽면 조직도",
  paper: "a4-portrait",
  pixelWidth,
  previewText: [
    "행정안전부 인공지능정부실·참여혁신조직실 왼쪽면 조직도",
    "직제 기준 2026. 7. 21.",
    "A4 세로 1쪽 · 원형복원 왼쪽면 배치",
  ].join("\n"),
});

console.log(JSON.stringify({ svgPath, pngPath, hwpxPath, pixelWidth, pixelHeight }, null, 2));
