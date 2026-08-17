import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { analyzeNativeManifest } from "../desktop/ui/manifest-validation.js";
import { buildNativeComparisonWorkflow } from "../src/native-law-workflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const focus = [
  "해외문화홍보원",
  "해외문화홍보기획관",
  "국제문화과",
  "국제문화홍보정책실",
  "해외홍보정책관",
  "콘텐츠정책국",
  "미디어정책국",
  "저작권국",
  "문화미디어산업실",
  "관광정책국",
  "관광정책실",
].join(", ");

const snapshots = {
  "2024-02-05": {
    dir: "mcst-20240205",
    decree: "문화체육관광부와 그 소속기관 직제-20231229.txt",
    rule: "문화체육관광부와 그 소속기관 직제 시행규칙-20231229.txt",
  },
  "2024-02-06": {
    dir: "mcst-20240206",
    decree: "문화체육관광부와 그 소속기관 직제-20240206.txt",
    rule: "문화체육관광부와 그 소속기관 직제 시행규칙-20240206.txt",
  },
  "2025-12-30": {
    dir: "mcst-20251230",
    decree: "문화체육관광부와 그 소속기관 직제-20251230.txt",
    rule: "문화체육관광부와 그 소속기관 직제 시행규칙-20251230.txt",
  },
  "2026-07-28": {
    dir: "mcst-20260728",
    decree: "문화체육관광부와 그 소속기관 직제-20260721.txt",
    rule: "문화체육관광부와 그 소속기관 직제 시행규칙-20260728.txt",
  },
};

const expectedChildren = Object.freeze({
  c1: Object.freeze({
    해외문화홍보원: ["해외문화홍보기획관", "기획운영과", "해외문화홍보사업과", "해외문화홍보콘텐츠과", "외신협력과", "외신분석팀"],
    콘텐츠정책국: ["문화산업정책과", "영상콘텐츠산업과", "게임콘텐츠산업과", "대중문화산업과", "한류지원협력과"],
    미디어정책국: ["미디어정책과", "방송영상광고과", "출판인쇄독서진흥과"],
    저작권국: ["저작권정책과", "저작권산업과", "저작권보호과", "문화통상협력과"],
    관광산업정책관: ["관광산업정책과", "융합관광산업과", "관광개발과"],
    관광정책국: ["관광산업정책관", "관광정책과", "국내관광진흥과", "국제관광과", "관광기반과"],
  }),
  c2: Object.freeze({
    국제문화정책관: ["국제문화정책과", "한류지원협력과", "국제문화사업과"],
    해외홍보정책관: ["해외홍보기획과", "해외홍보콘텐츠과", "해외미디어협력과", "해외뉴스분석팀"],
    콘텐츠정책국: ["문화산업정책과", "영상콘텐츠산업과", "게임콘텐츠산업과", "대중문화산업과"],
    미디어정책국: ["미디어정책과", "방송영상광고과", "출판인쇄독서진흥과"],
    저작권국: ["저작권정책과", "저작권산업과", "저작권보호과", "문화통상협력과"],
    관광산업정책관: ["관광산업정책과", "융합관광산업과", "관광개발과"],
    관광정책국: ["관광산업정책관", "관광정책과", "국내관광진흥과", "국제관광과", "관광기반과"],
  }),
  c3: Object.freeze({
    해외홍보정책관: ["해외홍보기획과", "해외홍보콘텐츠과", "해외미디어협력과", "해외뉴스분석팀"],
    문화산업정책관: ["문화산업정책과", "문화산업기반과", "문화수출통상과"],
    콘텐츠미디어산업관: ["미디어정책과", "영상방송콘텐츠산업과", "게임콘텐츠산업과", "출판인쇄독서진흥과", "대중문화산업과"],
    저작권정책관: ["저작권정책과", "저작권산업과", "저작권보호과"],
    국제문화정책관: ["국제문화정책과", "한류지원협력과", "국제문화사업과"],
    관광정책관: ["관광정책과", "관광산업진흥과", "지역관광개발과", "국민관광진흥과"],
    국제관광정책관: ["국제관광정책과", "국제관광서비스과", "융복합관광과"],
  }),
  c4: Object.freeze({
    해외홍보정책관: ["해외홍보기획과", "해외홍보콘텐츠과", "해외미디어협력과", "해외뉴스분석팀"],
    콘텐츠산업정책관: ["콘텐츠산업정책과", "영상방송콘텐츠산업과", "게임콘텐츠산업과", "출판인쇄독서진흥과", "대중문화산업과"],
    문화산업미디어정책관: ["문화산업정책과", "미디어정책과", "문화기술과", "문화수출통상과"],
    저작권정책관: ["저작권정책과", "저작권산업과", "저작권보호과", "저작권특별사법경찰과"],
    국제문화정책관: ["국제문화정책과", "한류지원협력과", "국제문화사업과", "해외문화거점지원팀"],
    관광정책관: ["관광정책과", "관광산업진흥과", "지역관광개발과", "국민관광진흥과"],
    국제관광정책관: ["국제관광정책과", "국제관광서비스과", "융복합관광과"],
  }),
});

async function loadStage(asOf) {
  const spec = snapshots[asOf];
  const base = path.join(root, "work/legal-snapshots", spec.dir);
  return {
    asOf,
    institution: "문화체육관광부",
    decreeText: await readFile(path.join(base, spec.decree), "utf8"),
    ruleText: await readFile(path.join(base, spec.rule), "utf8"),
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgText(object, geometry, style) {
  const padding = Number(style.paddingMm || 0.6);
  const fontSize = Number(style.fontSizePt || 6) * 0.352778;
  const lines = String(object.text ?? "").split(/\r?\n/);
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
  if (style.dash === "dash") return 'stroke-dasharray="2.6 1.4"';
  return "";
}

function svgObject(object) {
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

function organizationNodes(manifest) {
  return manifest.objects.filter((object) => object.metadata?.role === "organization-node");
}

function auditMcst(manifest, workflow, validation) {
  const nodes = organizationNodes(manifest);
  const findNode = (side, name) => nodes.find(
    (object) => object.metadata.side === side && object.metadata.nodeName === name,
  );
  const afterWraps = new Map(
    manifest.objects
      .filter((object) => object.metadata?.role === "correspondence-wrap" && object.metadata.side === "after")
      .map((object) => [`${object.metadata.unit}:${object.metadata.from || ""}`, object]),
  );
  const status = manifest.objects
    .filter((object) => object.metadata?.role === "status-label")
    .map((object) => `${object.metadata.side}:${object.metadata.unit}:${object.metadata.status}`)
    .sort();
  const expectedStatus = [
    "c3:문화산업기반과:신설",
    "c4:문화기술과:신설",
    "c4:저작권특별사법경찰과:신설",
    "c4:해외문화거점지원팀:신설",
  ].sort();
  const structureMismatches = [];
  for (const [side, parents] of Object.entries(expectedChildren)) {
    for (const [parent, expected] of Object.entries(parents)) {
      const actual = nodes
        .filter((object) => object.metadata.side === side && object.metadata.parentName === parent)
        .sort((left, right) => left.geometry.y - right.geometry.y)
        .map((object) => object.metadata.nodeName);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        structureMismatches.push({ side, parent, expected, actual });
      }
    }
  }
  const checks = {
    manifestValid: validation.valid,
    noManifestWarnings: validation.warnings.length === 0,
    noWorkflowWarnings: workflow.summary.warnings.filter(
      (warning) => !/4개 시점|작도 범위를 찾지 못해 제외했습니다/.test(warning),
    ).length === 0,
    stageDates: JSON.stringify(workflow.summary.stageAsOf) === JSON.stringify(Object.keys(snapshots)),
    planningDepartmentRestored: findNode("c1", "기획운영과")?.metadata.parentName === "해외문화홍보원",
    planningSuccession: afterWraps.has("해외홍보기획과:기획운영과"),
    contentPolicyRename: afterWraps.has("콘텐츠산업정책과:문화산업정책과"),
    culturePolicyRename: afterWraps.has("문화산업정책과:문화산업기반과"),
    internationalCultureContext: findNode("c1", "국제문화과")?.text.startsWith("문화예술정책실 › "),
    overseasPromotionDirectorGrade: findNode("c1", "해외문화홍보원")?.text.startsWith("(가)"),
    overseasPlanningAdvisorContext: findNode("c1", "해외문화홍보기획관")?.metadata.parentName === "해외문화홍보원"
      && findNode("c1", "해외문화홍보기획관")?.text.startsWith("(나)"),
    publicCommunicationContext2025: findNode("c3", "해외홍보정책관")?.text.startsWith("국민소통실 › "),
    publicCommunicationContext2026: findNode("c4", "해외홍보정책관")?.text.startsWith("국민소통실 › "),
    lifecycleLabels: JSON.stringify(status) === JSON.stringify(expectedStatus),
    allFocusedParentStructures: structureMismatches.length === 0,
  };
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    status,
    expectedStatus,
    structureMismatches,
    objectCount: manifest.objects.length,
    nodeCount: nodes.length,
    correspondenceWrapCount: manifest.objects.filter((object) => object.metadata?.role === "correspondence-wrap").length,
  };
}

const dates = Object.keys(snapshots);
const stages = [];
for (const date of dates) stages.push(await loadStage(date));
const workflow = buildNativeComparisonWorkflow({ stages, focus, onePage: true });
const manifest = workflow.manifests[0];
const validation = analyzeNativeManifest(manifest);
const audit = auditMcst(manifest, workflow, validation);
const stem = "문화체육관광부-실급조직개편-4단-관소관반영";
const outputDir = path.join(root, "outputs");
const nativePath = path.join(outputDir, `${stem}.native.json`);
const svgPath = path.join(outputDir, `${stem}.svg`);
const pngPath = path.join(outputDir, `${stem}.png`);
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${manifest.page.widthMm}mm" height="${manifest.page.heightMm}mm" viewBox="0 0 ${manifest.page.widthMm} ${manifest.page.heightMm}" shape-rendering="geometricPrecision">
  <rect width="${manifest.page.widthMm}" height="${manifest.page.heightMm}" fill="#ffffff"/>
  ${manifest.objects.map(svgObject).join("\n  ")}
</svg>`;

await writeFile(nativePath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(svgPath, svg);
await sharp(Buffer.from(svg)).png().resize({ width: 2960 }).toFile(pngPath);
for (let index = 0; index < workflow.stageSnapshots.length; index += 1) {
  const snapshot = workflow.stageSnapshots[index];
  const graph = snapshot.legalGraph || snapshot.graph;
  await writeFile(
    path.join(outputDir, `문화체육관광부-${dates[index].replaceAll("-", "")}.json`),
    `${JSON.stringify(graph, null, 2)}\n`,
  );
}

console.log(JSON.stringify({
  audit,
  validation,
  summary: workflow.summary,
  files: { nativePath, svgPath, pngPath },
}, null, 2));

if (!audit.valid) process.exitCode = 1;
