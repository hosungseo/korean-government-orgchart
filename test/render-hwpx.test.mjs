import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HwpxReader } from "@ssabrojs/hwpxjs";
import JSZip from "jszip";
import sharp from "sharp";
import { OrgGraph } from "../src/model.mjs";
import { planPages } from "../src/layout.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";
import {
  createHwpxReportBytes,
  renderHwpx,
  renderHwpxChartSvg,
  validateHwpxBytes,
} from "../src/render-hwpx.mjs";

function fixture() {
  const graph = parseOrganizationTexts([
    `
@기관: 시험부
@기준일: 2026-07-24
제2조(하부조직) 시험부에 시험실 및 운영지원과를 둔다.
시험실장 밑에 산업정책관을 둔다.
시험실에 정책과 및 지원과를 둔다.
① 정책과장은 산업정책관 내 다른 과의 주관에 속하지 아니하는 사항을 분장한다.
`,
  ], { asOf: "2026-07-24" });
  const pages = planPages(graph, { paper: "a4-landscape", mode: "compact" });
  return { graph, pages };
}

test("HWPX는 표준 패키지·조직도 그림·편집 가능한 관계표를 함께 만든다", async () => {
  const { graph, pages } = fixture();
  const bytes = await createHwpxReportBytes(graph, pages, {
    generatedAt: new Date("2026-08-13T00:00:00Z"),
  });

  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("binary"), "PK\u0003\u0004");
  assert.equal(bytes[8], 0, "첫 ZIP 항목 mimetype은 STORE 방식이어야 한다");
  assert.equal(bytes[9], 0, "첫 ZIP 항목 mimetype은 STORE 방식이어야 한다");
  const firstNameLength = bytes[26] | (bytes[27] << 8);
  assert.equal(Buffer.from(bytes.subarray(30, 30 + firstNameLength)).toString("utf8"), "mimetype");

  const zip = await JSZip.loadAsync(bytes);
  assert.equal(await zip.file("mimetype").async("string"), "application/hwp+zip");
  const section = await zip.file("Contents/section0.xml").async("string");
  assert.match(section, /<hp:pagePr[^>]+width="84188"[^>]+height="59528"/);
  assert.match(section, /<hp:pic\b/);
  assert.match(section, /<hp:orgSz width="75684" height="51024"/);
  assert.match(section, /rowCnt="\d+" colCnt="4"/);
  assert.match(section, /조직 관계 근거표/);
  const generatedTextParts = await Promise.all([
    "Contents/content.hpf",
    "Contents/section0.xml",
    "Preview/PrvText.txt",
    "settings.xml",
  ].map((name) => zip.file(name).async("string")));
  assert.doesNotMatch(generatedTextParts.join("\n"), /홍길동|디지털 전환 추진 현황|kokyu/);
  const png = await zip.file("BinData/image1.png").async("uint8array");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const pngMetadata = await sharp(png).metadata();
  assert.ok(pngMetadata.width >= 3000, "HWPX 조직도는 인쇄용 300dpi 수준이어야 한다");
  assert.ok(pngMetadata.height >= 2000, "HWPX 조직도는 인쇄용 300dpi 수준이어야 한다");

  const validation = await validateHwpxBytes(bytes, { expectedImages: 1, expectedText: "시험부" });
  assert.equal(validation.images.length, 1);
  assert.match(validation.text, /시험부 조직도 검토보고서/);
  assert.match(validation.text, /시험실/);
  assert.match(validation.text, /산업정책관/);

  const reader = new HwpxReader();
  await reader.loadFromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const info = await reader.getDocumentInfo();
  assert.equal(info.metadata.title, "시험부 조직도 검토보고서");
});

test("HWPX 전용 플레이트는 조직명·직무표식을 분리하고 본문 폭을 온전히 쓴다", () => {
  const { graph, pages } = fixture();
  graph.nodeByName("시험실").metadata.grade = "가";
  graph.nodeByName("시험실").metadata.evaluation = true;

  const plate = renderHwpxChartSvg(graph, pages[0]);

  assert.ok(plate.width > 700 && plate.height > 500);
  assert.match(plate.svg, /ORGANIZATION ATLAS/);
  assert.match(plate.svg, /fill="#FBFCFE"/);
  assert.match(plate.svg, />시험실</);
  assert.doesNotMatch(plate.svg, /시험실 \(가\)/);
  assert.match(plate.svg, />가·평</);
});

test("HWPX의 다중 소속기관 상세면은 교차선 없는 상위기관별 카드 묶음으로 전환한다", () => {
  const graph = new OrgGraph({ institution: "시험부", asOf: "2026-08-13" });
  const nodeIds = [];
  const rootIds = [];
  for (let index = 1; index <= 4; index += 1) {
    const root = graph.addNode(`제${index}소속기관`, { kind: "affiliated" });
    const child = graph.addNode(`제${index}지원과`, {
      id: `제${index}소속기관/제${index}지원과`,
      kind: "assistant",
    });
    graph.addEdge(graph.rootId, root.id, { type: "affiliated" });
    graph.addEdge(root.id, child.id, { type: "assistant" });
    rootIds.push(root.id);
    nodeIds.push(root.id, child.id);
  }
  const page = {
    paper: "a4-landscape",
    kind: "affiliate-detail",
    title: "시험부",
    subtitle: "소속기관 상세",
    rootIds,
    nodeIds,
    pageNumber: 1,
    pageCount: 1,
    layoutStyle: "two-column",
  };

  const plate = renderHwpxChartSvg(graph, page);

  assert.match(plate.svg, /소속기관별 카드 묶음/);
  assert.match(plate.svg, /하부조직 1개/);
  assert.doesNotMatch(plate.svg, /배치 확인/);
});

test("HWPX 연결선은 부모별 단일 버스로 묶여 카드 중심축에 접속한다", () => {
  const graph = new OrgGraph({ institution: "시험부", asOf: "2026-08-13" });
  const parent = graph.addNode("정책실", { kind: "assistant" });
  graph.addEdge(graph.rootId, parent.id, { type: "assistant" });
  const children = ["제도과", "지원과", "협력과"].map((name) => graph.addNode(name, { kind: "assistant" }));
  children.forEach((child) => graph.addEdge(parent.id, child.id, { type: "assistant" }));
  const page = {
    paper: "a4-landscape",
    kind: "branch",
    title: "시험부",
    subtitle: "연결선 정렬 검수",
    rootIds: [parent.id],
    nodeIds: [parent.id, ...children.map((child) => child.id)],
    pageNumber: 1,
    pageCount: 1,
    layoutStyle: "two-column",
  };

  const plate = renderHwpxChartSvg(graph, page);
  const parentConnectors = plate.svg.match(new RegExp(`data-connector-parent="${parent.id}"`, "g")) || [];

  assert.equal(parentConnectors.length, 1, "부모 하나에는 겹친 개별 선 대신 공통 버스 하나만 있어야 한다");
  assert.match(plate.svg, /data-connector-kind="main"/);
  assert.ok((plate.svg.match(/<circle cx=/g) || []).length >= 4, "부모와 자식 접점에 정렬 표식이 있어야 한다");
});

test("HWPX 다중 상위조직은 독립 계선 패널과 별도 버스를 사용한다", () => {
  const graph = new OrgGraph({ institution: "시험부", asOf: "2026-08-13" });
  const lineRoot = graph.addNode("정책실", { kind: "assistant" });
  const staffRoot = graph.addNode("감사관", { kind: "advisor" });
  const lineChild = graph.addNode("정책과", { kind: "assistant" });
  const staffChild = graph.addNode("감사담당관", { kind: "advisor" });
  graph.addEdge(lineRoot.id, lineChild.id, { type: "assistant" });
  graph.addEdge(staffRoot.id, staffChild.id, { type: "advisor" });
  const page = {
    paper: "a4-landscape",
    kind: "branch",
    title: "시험부",
    subtitle: "복수 계선 검수",
    rootIds: [lineRoot.id, staffRoot.id],
    nodeIds: [lineRoot.id, lineChild.id, staffRoot.id, staffChild.id],
    pageNumber: 1,
    pageCount: 1,
    layoutStyle: "two-column",
  };

  const plate = renderHwpxChartSvg(graph, page);

  assert.match(plate.svg, /보조기관 계선/);
  assert.match(plate.svg, /보좌기관 계선/);
  assert.equal((plate.svg.match(/data-connector-parent=/g) || []).length, 2);
  assert.doesNotMatch(plate.svg, /배치 확인/);
});

test("HWPX 소속기관 개요는 큰 기관 계선과 단독 기관을 독립 패널로 나눈다", () => {
  const graph = new OrgGraph({ institution: "시험부", asOf: "2026-08-13" });
  const archive = graph.addNode("국가기록원", { kind: "affiliated" });
  const branchA = graph.addNode("제1관리소", { kind: "affiliated" });
  const branchB = graph.addNode("제2관리소", { kind: "affiliated" });
  const bureau = graph.addNode("기록관리부", { kind: "assistant" });
  graph.addEdge(archive.id, bureau.id, { type: "assistant" });
  const nodeIds = [archive.id, branchA.id, branchB.id, bureau.id];
  for (let index = 1; index <= 6; index += 1) {
    const child = graph.addNode(`제${index}기록과`, { kind: "assistant" });
    graph.addEdge(bureau.id, child.id, { type: "assistant" });
    nodeIds.push(child.id);
  }
  const page = {
    paper: "a4-landscape",
    kind: "affiliates",
    title: "시험부",
    subtitle: "소속기관",
    rootIds: [branchA.id, archive.id, branchB.id],
    nodeIds,
    pageNumber: 1,
    pageCount: 1,
    layoutStyle: "two-column",
  };

  const plate = renderHwpxChartSvg(graph, page);

  assert.equal((plate.svg.match(/소속기관 계선/g) || []).length, 3);
  assert.match(plate.svg, /data-connector-parent=/);
  assert.doesNotMatch(plate.svg, /배치 확인/);
});

test("renderHwpx는 부모 폴더를 만들고 .hwpx 파일을 쓴다", async () => {
  const { graph, pages } = fixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-hwpx-"));
  const out = path.join(dir, "nested", "시험부.hwpx");
  assert.equal(await renderHwpx(graph, pages, out), out);
  assert.ok((await stat(out)).size > 10_000);
  const bytes = new Uint8Array(await readFile(out));
  await validateHwpxBytes(bytes, { expectedImages: 1, expectedText: "시험부" });
});
