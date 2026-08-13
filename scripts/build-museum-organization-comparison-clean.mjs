import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderSinglePlateHwpx } from "../src/render-hwpx.mjs";
import {
  ORGANIZATION_COMPARISON_SHEET_SIZE,
  renderOrganizationComparisonSheetSvg,
} from "../src/render-organization-comparison-sheet.mjs";

const title = "국립중앙박물관 조직체계 전후 비교";
const outputStem = "국립중앙박물관-조직체계-전후비교-변경선제외-A4-세로-1쪽";
const outDir = path.resolve("outputs");
const svgPath = path.join(outDir, `${outputStem}.svg`);
const pngPath = path.join(outDir, `${outputStem}.png`);
const hwpxPath = path.join(outDir, `${outputStem}.hwpx`);

const rows = [
  {
    key: "administration",
    height: 110,
    before: {
      title: "행정운영실",
      grade: "고위 나",
      units: ["행정지원과", "디지털박물관과", "시설관리과", "고객지원팀"],
      duties: "직제·예산 · 박물관 정보화 · 디지털박물관 구축",
    },
    after: {
      title: "행정운영실",
      grade: "고위 나",
      units: ["행정지원과", "기획총괄과", "시설관리과"],
      duties: "직제·예산 · 기획·국회·성과 · 박물관 정보화",
    },
  },
  {
    key: "research",
    height: 170,
    before: {
      title: "학예연구실",
      grade: "고위 나",
      units: ["유물관리부", "고고역사부", "미술부", "세계문화부", "보존과학부"],
      duties: "학예연구 종합계획·학예분야 기획·예산 · 소장품·수장고 관리 · 박물관 자료수집 연구",
    },
    after: {
      title: "학예연구실",
      grade: "고위 가",
      units: ["학예전략총괄부", "유물관리부", "고고역사부", "미술부", "세계문화부", "보존과학부"],
      duties: "미래전략기획·운영자문위·박물관 출판 · 소장품 아카이브센터 · 박물관도서관 운영",
    },
  },
  {
    key: "planning",
    height: 130,
    before: {
      title: "박물관기획관",
      grade: "고위 나",
      units: ["미래전략담당관"],
      duties: "미래전략기획·운영자문위 · 지방박물관 브랜드·협력망 · 기록·국회·성과 · 학예사 자격제도",
    },
    after: {
      title: "박물관기획관",
      grade: "고위 나",
      units: ["지역박물관과", "전시과", "디자인팀", "디지털박물관팀"],
      duties: "지방박물관 특성화·업무조정 · 전시·공간환경 디자인 · 문화유산데이터·디지털콘텐츠",
    },
  },
  {
    key: "education",
    height: 155,
    before: {
      title: "교육문화교류실",
      grade: "고위 나",
      units: ["문화교류홍보과", "전시과", "교육과", "어린이박물관과", "디자인팀"],
      duties: "교육프로그램·교육 네트워크 · 도서관 운영 · 전시·공간 디자인 · 박물관 출판물 개발",
    },
    after: {
      title: "교육문화교류실",
      grade: "고위 나",
      units: ["문화교류홍보과", "교육과", "어린이박물관과", "고객지원팀"],
      duties: "교육프로그램·교육 네트워크 · 학예사 자격제도 · 고객지원",
    },
  },
  {
    key: "regional-museums",
    height: 48,
    before: { title: "지방박물관 13개관", compact: true },
    after: { title: "지방박물관 14개관", compact: true },
  },
];

const spec = {
  title,
  subtitle: "변경선을 제외하고 개편 전·후 설치관계와 하부조직만 정렬",
  footer: "제공 이미지 기반 재작도 · 변경선·변경주석 제외 · 공식 원문 대조 전 검토용",
  rows,
};

await fs.mkdir(outDir, { recursive: true });
const svg = renderOrganizationComparisonSheetSvg(spec);
await fs.writeFile(svgPath, svg, "utf8");

const pixelWidth = 2126;
const pixelHeight = Math.round(pixelWidth * ORGANIZATION_COMPARISON_SHEET_SIZE.height / ORGANIZATION_COMPARISON_SHEET_SIZE.width);
await sharp(Buffer.from(svg, "utf8"), { density: 300 })
  .flatten({ background: "#ffffff" })
  .resize({ width: pixelWidth, height: pixelHeight, fit: "fill" })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(pngPath);

await renderSinglePlateHwpx(svg, hwpxPath, {
  title,
  paper: "a4-portrait",
  pixelWidth,
  previewText: [
    title,
    "A4 세로 1쪽 · 변경선 없는 조직체계 비교도",
    "개편 전 · 개편 후",
    "제공 이미지 기반 재구성 — 공식 원문 대조 전 검토용",
  ].join("\n"),
});

console.log(JSON.stringify({ svgPath, pngPath, hwpxPath, pixelWidth, pixelHeight }, null, 2));
