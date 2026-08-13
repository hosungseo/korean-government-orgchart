import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderSinglePlateHwpx } from "../src/render-hwpx.mjs";
import {
  REORGANIZATION_SHEET_SIZES,
  renderReorganizationSheetSvg,
} from "../src/render-reorganization-sheet.mjs";

const title = "국립중앙박물관 조직개편 전후 비교";
const outputStem = "국립중앙박물관-조직개편-전후비교-A4-세로-1쪽-수정안";
const outDir = path.resolve("outputs");
const svgPath = path.join(outDir, `${outputStem}.svg`);
const pngPath = path.join(outDir, `${outputStem}.png`);
const hwpxPath = path.join(outDir, `${outputStem}.hwpx`);

const spec = {
  paper: "a4-portrait",
  title,
  subtitle: "조직 계층은 좌우에 유지하고, 기능 이관은 가운데 변경 레인으로 분리",
  footer: "제공 이미지 기반 시각 재구성 · 조직·업무 문구는 공식 원문 대조 전 검토용",
  rows: [
    {
      key: "administration",
      height: 110,
      accent: "#245E8B",
      before: {
        title: "행정운영실",
        grade: "고위 나",
        units: [
          "행정지원과",
          { name: "디지털박물관과", tone: "move" },
          "시설관리과",
          { name: "고객지원팀", tone: "move" },
        ],
        duties: "직제·예산 · 박물관 정보화 · 디지털박물관 구축",
      },
      change: {
        title: "기획·지원 기능 재편",
        items: [
          { type: "merge", text: "미래전략담당관의 기획·국회·성과 → 기획총괄과" },
          { type: "move", text: "디지털박물관과의 정보화 기능 → 기획총괄과" },
          { type: "move", text: "고객지원팀 → 교육문화교류실" },
        ],
      },
      after: {
        title: "행정운영실",
        grade: "고위 나",
        units: [
          "행정지원과",
          { name: "기획총괄과", tone: "move" },
          "시설관리과",
        ],
        duties: "직제·예산 · 기획·국회·성과 · 박물관 정보화",
      },
    },
    {
      key: "research",
      height: 170,
      accent: "#A9550A",
      before: {
        title: "학예연구실",
        grade: "고위 나",
        units: ["유물관리부", "고고역사부", "미술부", "세계문화부", "보존과학부"],
        duties: "학예연구 종합계획·학예분야 기획·예산 · 소장품·수장고 관리 · 박물관 자료수집 연구",
      },
      change: {
        title: "학예 총괄기능 강화",
        items: [
          { type: "grade", text: "학예연구실 직급 상향 · 고위 나 → 고위 가" },
          { type: "new", text: "미래전략·운영자문 기능 → 학예전략총괄부" },
          { type: "move", text: "출판물 개발 기능 → 학예전략총괄부" },
          { type: "move", text: "아카이브센터·박물관도서관 운영 → 유물관리부" },
        ],
      },
      after: {
        title: "학예연구실",
        grade: "고위 가",
        gradeTone: "grade",
        units: [
          { name: "학예전략총괄부", tone: "new" },
          "유물관리부",
          "고고역사부",
          "미술부",
          "세계문화부",
          "보존과학부",
        ],
        duties: "미래전략기획·운영자문위·박물관 출판 · 소장품 아카이브센터 · 박물관도서관 운영",
      },
    },
    {
      key: "planning",
      height: 130,
      accent: "#347A55",
      before: {
        title: "박물관기획관",
        grade: "고위 나",
        units: [{ name: "미래전략담당관", tone: "move" }],
        duties: "미래전략기획·운영자문위 · 지방박물관 브랜드·협력망 · 기록·국회·성과 · 학예사 자격제도",
      },
      change: {
        title: "기획관 기능 재구성",
        items: [
          { type: "new", text: "지방박물관 브랜드·협력망 → 지역박물관과" },
          { type: "move", text: "전시과·디자인팀 → 박물관기획관" },
          { type: "move", text: "디지털 콘텐츠 기능 → 디지털박물관팀" },
        ],
      },
      after: {
        title: "박물관기획관",
        grade: "고위 나",
        units: [
          { name: "지역박물관과", tone: "new" },
          { name: "전시과", tone: "move" },
          { name: "디자인팀", tone: "move" },
          { name: "디지털박물관팀", tone: "move" },
        ],
        duties: "지방박물관 특성화·업무조정 · 전시·공간환경 디자인 · 문화유산데이터·디지털콘텐츠",
      },
    },
    {
      key: "education",
      height: 155,
      accent: "#536A92",
      before: {
        title: "교육문화교류실",
        grade: "고위 나",
        units: [
          "문화교류홍보과",
          { name: "전시과", tone: "move" },
          "교육과",
          "어린이박물관과",
          { name: "디자인팀", tone: "move" },
        ],
        duties: "교육프로그램·교육 네트워크 · 도서관 운영 · 전시·공간 디자인 · 박물관 출판물 개발",
      },
      change: {
        title: "교육·고객 기능 정렬",
        items: [
          { type: "move", text: "행정운영실 고객지원팀 → 교육문화교류실" },
          { type: "move", text: "학예사 자격제도 → 교육과" },
          { type: "move", text: "전시과·디자인팀 → 박물관기획관" },
        ],
      },
      after: {
        title: "교육문화교류실",
        grade: "고위 나",
        units: [
          "문화교류홍보과",
          "교육과",
          "어린이박물관과",
          { name: "고객지원팀", tone: "move" },
        ],
        duties: "교육프로그램·교육 네트워크 · 학예사 자격제도 · 고객지원",
      },
    },
    {
      key: "regional-museums",
      height: 48,
      accent: "#347A55",
      before: {
        title: "지방박물관 13개관",
        compact: true,
      },
      change: {
        title: "충주박물관 신설",
        items: [],
      },
      after: {
        title: "지방박물관 14개관",
        compact: true,
      },
    },
  ],
};

await fs.mkdir(outDir, { recursive: true });
const svg = renderReorganizationSheetSvg(spec);
await fs.writeFile(svgPath, svg, "utf8");

const sheetSize = REORGANIZATION_SHEET_SIZES.portrait;
const pixelWidth = 2126;
const pixelHeight = Math.round(pixelWidth * sheetSize.height / sheetSize.width);
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
    "A4 세로 1쪽 조직개편 비교 수정안",
    "개편 전 · 변경 레인 · 개편 후",
    "제공 이미지 기반 재구성 — 공식 원문 대조 전 검토용",
  ].join("\n"),
});

console.log(JSON.stringify({ svgPath, pngPath, hwpxPath, pixelWidth, pixelHeight }, null, 2));
