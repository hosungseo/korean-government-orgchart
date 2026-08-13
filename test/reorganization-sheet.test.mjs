import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import sharp from "sharp";
import { createSinglePlateHwpxBytes } from "../src/render-hwpx.mjs";
import { renderReorganizationSheetSvg } from "../src/render-reorganization-sheet.mjs";

function fixture() {
  return {
    title: "시험기관 조직개편 전후 비교",
    rows: [
      {
        key: "planning",
        height: 75,
        before: {
          title: "정책실",
          grade: "고위 나",
          units: ["정책과", { name: "디지털과", tone: "move" }],
          duties: "정책기획 · 디지털 업무",
        },
        change: {
          title: "기능 재편",
          items: [
            { type: "move", text: "디지털과 → 디지털팀" },
            { type: "new", text: "전략총괄부 신설" },
          ],
        },
        after: {
          title: "정책실",
          grade: "고위 가",
          gradeTone: "grade",
          status: "직급 상향",
          units: ["정책과", { name: "디지털팀", tone: "new" }],
          duties: "정책기획 · 디지털콘텐츠",
        },
      },
      {
        key: "branches",
        height: 37,
        before: { title: "소속기관 13개", compact: true },
        change: { title: "소속기관 신설", items: [] },
        after: { title: "소속기관 14개", compact: true },
      },
    ],
  };
}

test("조직개편 비교도는 전·변경·후를 교차 없는 수평 레인으로 그린다", () => {
  const svg = renderReorganizationSheetSvg(fixture());

  assert.match(svg, /viewBox="0 0 756\.84 510\.24"/);
  assert.equal((svg.match(/data-row="/g) || []).length, 2);
  assert.equal((svg.match(/marker-end="url\(#row-arrow\)"/g) || []).length, 2);
  assert.doesNotMatch(svg, /stroke-dasharray/);
  assert.doesNotMatch(svg, /NaN|undefined/);
  assert.match(svg, /디지털과 → 디지털팀/);
  assert.match(svg, /직급 상향/);
});

test("A4 세로 비교도는 좁은 좌우 열과 긴 변경 레인을 한 쪽 안에 유지한다", () => {
  const source = fixture();
  const svg = renderReorganizationSheetSvg({
    ...source,
    paper: "a4-portrait",
    rows: source.rows.map((row, index) => ({ ...row, height: index ? 55 : 90 })),
  });

  assert.match(svg, /viewBox="0 0 510\.24 756\.84"/);
  assert.match(svg, /A4 세로 · 1쪽/);
  assert.equal((svg.match(/data-row="/g) || []).length, 2);
  assert.equal((svg.match(/marker-end="url\(#row-arrow\)"/g) || []).length, 2);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test("단일 플레이트 HWPX는 A4 가로 한 쪽과 300dpi 조직도 그림만 담는다", async () => {
  const svg = renderReorganizationSheetSvg(fixture());
  const bytes = await createSinglePlateHwpxBytes(svg, {
    title: "시험기관 조직개편 전후 비교",
    generatedAt: new Date("2026-08-13T00:00:00Z"),
  });
  const zip = await JSZip.loadAsync(bytes);
  const section = await zip.file("Contents/section0.xml").async("string");
  const png = await zip.file("BinData/image1.png").async("uint8array");
  const metadata = await sharp(png).metadata();

  assert.match(section, /<hp:pagePr[^>]+width="84188"[^>]+height="59528"/);
  assert.equal((section.match(/<hp:pic\b/g) || []).length, 1);
  assert.equal((section.match(/<hp:p\b/g) || []).length, 1, "secPr와 첫 그림은 같은 첫 문단이어야 한다");
  assert.match(section, /<hp:p[^>]*>[\s\S]*<hp:secPr[\s\S]*<hp:pic/);
  assert.equal((section.match(/pageBreak="1"/g) || []).length, 0);
  assert.doesNotMatch(section, /<hp:tbl\b/);
  assert.equal(metadata.width, 3154);
  assert.equal(metadata.height, 2126);
});

test("단일 플레이트 HWPX는 A4 세로 본문에 300dpi 비교도를 정확히 맞춘다", async () => {
  const svg = renderReorganizationSheetSvg({ ...fixture(), paper: "a4-portrait" });
  const bytes = await createSinglePlateHwpxBytes(svg, {
    title: "시험기관 조직개편 전후 비교",
    paper: "a4-portrait",
    pixelWidth: 2126,
    generatedAt: new Date("2026-08-13T00:00:00Z"),
  });
  const zip = await JSZip.loadAsync(bytes);
  const section = await zip.file("Contents/section0.xml").async("string");
  const png = await zip.file("BinData/image1.png").async("uint8array");
  const metadata = await sharp(png).metadata();

  assert.match(section, /<hp:pagePr[^>]+width="59528"[^>]+height="84188"/);
  assert.match(section, /<hp:orgSz width="51024" height="75684"/);
  assert.equal((section.match(/<hp:pic\b/g) || []).length, 1);
  assert.equal((section.match(/<hp:p\b/g) || []).length, 1, "독립 조판기에서도 빈 첫 쪽이 생기지 않아야 한다");
  assert.equal((section.match(/pageBreak="1"/g) || []).length, 0);
  assert.equal(metadata.width, 2126);
  assert.equal(metadata.height, 3154);
});
