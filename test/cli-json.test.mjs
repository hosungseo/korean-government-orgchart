import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseOrganizationTexts } from "../src/parser.mjs";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src/cli.mjs");

test("render-json은 기존 조직도 JSON을 다시 배치해 SVG와 JSON을 생성한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-render-json-"));
  const graph = parseOrganizationTexts(
    [
      `
@기관: 시험부
@기준일: 2026-07-24
제2조(하부조직) 시험부에 시험실 및 운영지원과를 둔다.
시험실장 밑에 산업정책관을 둔다.
시험실에 정책과ㆍ지원과ㆍ협력팀을 둔다.
`,
    ],
    { asOf: "2026-07-24" },
  );
  const graphPath = path.join(dir, "graph.json");
  const svgPath = path.join(dir, "relayout.svg");
  const jsonPath = path.join(dir, "relayout.json");
  await writeFile(graphPath, JSON.stringify(graph.toJSON(), null, 2), "utf8");

  const { stdout } = await run(process.execPath, [
    CLI,
    "render-json",
    "--graph",
    graphPath,
    "--paper",
    "a4-half",
    "--layout",
    "best",
    "--focus",
    "시험실",
    "--title",
    "시험부 재배치",
    "--svg",
    svgPath,
    "--json",
    jsonPath,
  ]);
  const summary = JSON.parse(stdout);
  const outputJson = JSON.parse(await readFile(jsonPath, "utf8"));
  const svg = await readFile(svgPath, "utf8");

  assert.equal(summary.institution, "시험부");
  assert.equal(summary.asOf, "2026-07-24");
  assert.equal(summary.pages, 1);
  assert.equal(outputJson.meta.title, "시험부 재배치");
  assert.equal(outputJson.nodes.length, graph.nodes.size);
  assert.ok(outputJson.nodes.some((node) => node.name === "산업정책관"));
  assert.ok((await stat(svgPath)).size > 0);
  assert.match(svg, /시험부 재배치/);
  assert.match(svg, /stroke-dasharray="5 4"/);
});
