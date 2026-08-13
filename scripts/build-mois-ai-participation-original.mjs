import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderSinglePlateHwpx } from "../src/render-hwpx.mjs";
import {
  ORIGINAL_TWO_BRANCHES_SIZE,
  renderOriginalTwoBranchesSvg,
} from "../src/render-original-two-branches.mjs";

const outputStem = "행정안전부-인공지능정부실-참여혁신조직실-원형복원-A4-세로";
const outDir = path.resolve("outputs");
const svgPath = path.join(outDir, `${outputStem}.svg`);
const pngPath = path.join(outDir, `${outputStem}.png`);
const hwpxPath = path.join(outDir, `${outputStem}.hwpx`);

const spec = {
  title: "행정안전부 주요 실 조직도",
  asOf: "2026. 7. 21.",
  footer: "행정안전부 직제·시행규칙 [시행 2026. 7. 21.] · 실→국→과 법정 설치계선",
  branches: [
    {
      name: "인공지능정부실",
      grade: "고위 가",
      rootY: 31,
      bureaus: [
        {
          name: "인공지능정부정책국",
          y: 93,
          itemsY: 125,
          items: [
            "인공지능정부정책과",
            "공공인공지능혁신과",
            "공공데이터정책과",
            "공공데이터분석관리과",
            "인공지능정부협력과",
          ],
        },
        {
          name: "인공지능정부서비스국",
          y: 306,
          itemsY: 338,
          items: [
            "공공서비스혁신과",
            "행정정보공유과",
            "국민맞춤서비스과",
            { name: "통합포털정책과", evaluation: true },
          ],
        },
        {
          name: "인공지능정부기반국",
          grade: "고위 나",
          y: 515,
          itemsY: 547,
          items: [
            "디지털보안정책과",
            "디지털인프라혁신과",
            "지역디지털협력과",
          ],
        },
      ],
    },
    {
      name: "참여혁신조직실",
      grade: "고위 가",
      rootY: 31,
      evaluation: true,
      bureaus: [
        {
          name: "참여혁신국",
          y: 130,
          itemsY: 162,
          items: [
            "혁신기획과",
            "국민참여정책과",
            "행정제도과",
            "민원제도과",
            "정보공개제도과",
          ],
        },
        {
          name: "조직국",
          grade: "고위 나",
          y: 404,
          itemsY: 436,
          items: [
            "조직기획과",
            "조직진단과",
            "경제조직과",
            "사회조직과",
            "안전조직과",
            { name: "법사조직과", evaluation: true },
          ],
        },
      ],
    },
  ],
};

await fs.mkdir(outDir, { recursive: true });
const svg = renderOriginalTwoBranchesSvg(spec);
await fs.writeFile(svgPath, svg, "utf8");

const pixelWidth = 2126;
const pixelHeight = Math.round(pixelWidth * ORIGINAL_TWO_BRANCHES_SIZE.height / ORIGINAL_TWO_BRANCHES_SIZE.width);
await sharp(Buffer.from(svg, "utf8"), { density: 300 })
  .flatten({ background: "#FFFFFF" })
  .resize({ width: pixelWidth, height: pixelHeight, fit: "fill" })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(pngPath);

await renderSinglePlateHwpx(svg, hwpxPath, {
  title: "행정안전부 인공지능정부실·참여혁신조직실 조직도",
  paper: "a4-portrait",
  pixelWidth,
  previewText: [
    "행정안전부 인공지능정부실·참여혁신조직실 조직도",
    "직제 기준 2026. 7. 21.",
    "A4 세로 1쪽 · 원형복원 작도",
  ].join("\n"),
});

console.log(JSON.stringify({ svgPath, pngPath, hwpxPath, pixelWidth, pixelHeight }, null, 2));
