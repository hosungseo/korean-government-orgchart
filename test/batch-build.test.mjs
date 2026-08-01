import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatBatchBuildMarkdown,
  parseOutputFormats,
  runBatchBuild,
} from "../src/batch-build.mjs";

test("batch-build 출력 형식 별칭을 해석한다", () => {
  assert.deepEqual(parseOutputFormats("svg,json,md"), ["svg", "json", "audit"]);
  assert.deepEqual(parseOutputFormats("all"), ["svg", "json", "audit", "pptx"]);
  assert.throws(() => parseOutputFormats("docx"), /지원하지 않는/);
});

test("batch-build는 로컬 케이스에서 SVG·JSON·감사리포트를 일괄 생성한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-build-"));
  await writeFile(
    path.join(dir, "law.txt"),
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실장 밑에 산업정책관을 둔다.
시험실에 정책과 및 지원과를 둔다.
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "cases.json"),
    JSON.stringify({
      cases: [
        {
          id: "local-build",
          institution: "시험부",
          date: "2026-07-24",
          inputs: ["law.txt"],
          view: "operational",
          paper: "a4-half",
          layout: "best",
          focus: "시험실",
        },
      ],
    }),
    "utf8",
  );

  const result = await runBatchBuild({
    cases: path.join(dir, "cases.json"),
    "out-dir": path.join(dir, "out"),
    outputs: "svg,json,audit",
  });

  assert.equal(result.total, 1);
  assert.equal(result.cases[0].status, "built");
  assert.match(await readFile(result.cases[0].outputs.svg, "utf8"), /<svg/);
  assert.match(await readFile(result.cases[0].outputs.json, "utf8"), /"institution": "시험부"/);
  assert.match(await readFile(result.cases[0].outputs.audit, "utf8"), /조직도 감사 리포트/);
  assert.deepEqual(result.cases[0].summary.layoutSelection.selected, ["vertical-stack"]);
  const markdown = formatBatchBuildMarkdown(result);
  assert.match(markdown, /조직도 batch build/);
  assert.match(markdown, /vertical-stack/);
});
