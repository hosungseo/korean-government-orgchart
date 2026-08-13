import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderSinglePlateHwpx } from "../src/render-hwpx.mjs";
import {
  ORIGINAL_COMPARISON_SIZE,
  renderOriginalOrganizationComparisonSvg,
} from "../src/render-original-organization-comparison.mjs";

const outputStem = "국립중앙박물관-조직개편도-원형복원-변경선제외-A4-세로";
const outDir = path.resolve("outputs");
const svgPath = path.join(outDir, `${outputStem}.svg`);
const pngPath = path.join(outDir, `${outputStem}.png`);
const hwpxPath = path.join(outDir, `${outputStem}.hwpx`);

const spec = {
  before: {
    groups: [
      {
        y: 31,
        title: "박물관기획관",
        grade: "고위 나",
        tone: "yellow",
        outlineTone: "magenta",
        items: [
          {
            name: "미래전략담당관",
            tone: "green",
            notes: [
              "미래전략기획, 박물관운영자문위",
              "지방박물관브랜드, 박물관협력망",
              "기록·국회·성과, 학예사자격제도",
            ],
          },
        ],
      },
      {
        y: 126,
        title: "행정운영실",
        grade: "고위 나",
        items: [
          { name: "행정지원과" },
          {
            name: "디지털박물관과",
            tone: "purple",
            notes: ["직제, 예산     박물관정보화", "디지털박물관구축"],
          },
          { name: "시설관리과" },
          { name: "고객지원팀", tone: "purple" },
        ],
      },
      {
        y: 279,
        title: "학예연구실",
        grade: "고위 나",
        outlineTone: "red",
        items: [
          {
            name: "유물관리부",
            notes: [
              "학예연구 종합계획, 학예분야 기획·예산",
              "소장품, 수장고 관리  박물관 자료수집 연구",
            ],
          },
          { name: "고고역사부" },
          { name: "미술부" },
          { name: "세계문화부" },
          { name: "보존과학부" },
        ],
      },
      {
        y: 460,
        title: "교육문화교류실",
        grade: "고위 나",
        items: [
          { name: "문화교류홍보과" },
          { name: "전시과" },
          {
            name: "교육과",
            notes: ["박물관 교육프로그램 운영(전시연계, 온라인)", "박물관 교육 네트워크 구축  도서관 운영"],
          },
          { name: "어린이박물관과" },
          {
            name: "디자인팀",
            tone: "purple",
            notes: ["박물관 전시 디자인    공간환경 디자인", "박물관 출판물 개발"],
          },
        ],
      },
      {
        y: 711,
        title: "지방박물관(13개관)",
        tone: "default",
        headerWidth: 132,
        headerHeight: 20,
        items: [],
      },
    ],
  },
  after: {
    groups: [
      {
        y: 31,
        title: "행정운영실",
        grade: "고위 나",
        items: [
          { name: "행정지원과" },
          {
            name: "기획총괄과",
            outlineTone: "blue",
            notes: ["직제, 예산      기획·국회·성과", "박물관정보화"],
          },
          { name: "시설관리과" },
        ],
      },
      {
        y: 150,
        title: "학예연구실",
        grade: "고위 가",
        tone: "orange",
        outlineTone: "red",
        items: [
          {
            name: "학예전략총괄부",
            tone: "green",
            outlineTone: "green",
            notes: [
              "학예연구 종합계획  학예분야 기획, 예산",
              "미래전략기획, 박물관운영자문위",
              "박물관 출판물 개발",
            ],
          },
          {
            name: "유물관리부",
            notes: ["소장품, 수장고관리  자료수집 연구", "소장품 아카이브센터  박물관도서관 운영"],
          },
          { name: "고고역사부" },
          { name: "미술부" },
          { name: "세계문화부" },
          { name: "보존과학부" },
        ],
      },
      {
        y: 365,
        title: "박물관기획관",
        grade: "고위 나",
        outlineTone: "magenta",
        items: [
          {
            name: "지역박물관과",
            tone: "green",
            outlineTone: "green",
            notes: [
              "지방박물관브랜드, 박물관협력망",
              "지방박물관 특성화 종합계획 수립",
              "소속 지방박물관 업무 조정 및 관리",
            ],
          },
          { name: "전시과" },
          { name: "디자인팀", notes: ["박물관 전시 디자인    공간환경 디자인"] },
          {
            name: "디지털박물관팀",
            tone: "purple",
            outlineTone: "blue",
            notes: ["문화유산데이터생성  디지털콘텐츠"],
          },
        ],
      },
      {
        y: 568,
        title: "교육문화교류실",
        grade: "고위 나",
        items: [
          { name: "문화교류홍보과" },
          {
            name: "교육과",
            notes: ["박물관 교육프로그램 운영(전시연계, 온라인)", "박물관 교육 네트워크   학예사자격제도"],
          },
          { name: "어린이박물관과" },
          { name: "고객지원팀", tone: "purple" },
        ],
      },
      {
        y: 711,
        title: "지방박물관(14개관)",
        tone: "default",
        headerWidth: 132,
        headerHeight: 20,
        items: [],
        notes: ["충주박물관 신설"],
        noteX: 425,
        noteY: 723,
      },
    ],
  },
};

await fs.mkdir(outDir, { recursive: true });
const svg = renderOriginalOrganizationComparisonSvg(spec);
await fs.writeFile(svgPath, svg, "utf8");

const pixelWidth = 2126;
const pixelHeight = Math.round(pixelWidth * ORIGINAL_COMPARISON_SIZE.height / ORIGINAL_COMPARISON_SIZE.width);
await sharp(Buffer.from(svg, "utf8"), { density: 300 })
  .flatten({ background: "#FFFFFF" })
  .resize({ width: pixelWidth, height: pixelHeight, fit: "fill" })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(pngPath);

await renderSinglePlateHwpx(svg, hwpxPath, {
  title: "국립중앙박물관 조직개편도 원형 복원판",
  paper: "a4-portrait",
  pixelWidth,
  previewText: [
    "국립중앙박물관 조직개편도 원형 복원판",
    "A4 세로 1쪽 · 좌우 변경선 제외",
    "제공 이미지 기반 재구성 — 공식 원문 대조 전 검토용",
  ].join("\n"),
});

console.log(JSON.stringify({ svgPath, pngPath, hwpxPath, pixelWidth, pixelHeight }, null, 2));
