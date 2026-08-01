import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
  assert.deepEqual(parseOutputFormats("pptx-deck"), ["deck"]);
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

test("batch-build는 여러 케이스를 통합 PPTX deck으로 묶는다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-deck-"));
  await writeFile(
    path.join(dir, "law.txt"),
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실에 정책과 및 지원과를 둔다.
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "cases.json"),
    JSON.stringify({
      cases: [
        {
          id: "deck-a",
          institution: "시험부",
          date: "2026-07-24",
          inputs: ["law.txt"],
          paper: "a4-half",
          layout: "best",
        },
        {
          id: "deck-b",
          institution: "시험부",
          date: "2026-07-24",
          inputs: ["law.txt"],
          paper: "a4-half",
          layout: "catalog",
        },
      ],
    }),
    "utf8",
  );

  const result = await runBatchBuild({
    cases: path.join(dir, "cases.json"),
    "out-dir": path.join(dir, "out"),
    outputs: "deck",
    deck: path.join(dir, "review-deck.pptx"),
  });

  assert.equal(result.total, 2);
  assert.equal(result.deckError, null);
  assert.equal(result.deck, path.join(dir, "review-deck.pptx"));
  assert.deepEqual(result.decks.map((deck) => deck.paper), ["a4-half"]);
  assert.ok((await stat(result.deck)).size > 0);
  assert.deepEqual(result.cases.map((item) => item.status), ["built", "built"]);
  assert.deepEqual(result.cases.map((item) => item.outputs), [{}, {}]);
  const markdown = formatBatchBuildMarkdown(result);
  assert.match(markdown, /통합 PPTX deck/);
  assert.match(markdown, /deck 포함/);
});

test("batch-build 통합 deck은 용지 크기가 섞이면 파일을 자동 분리한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-deck-split-"));
  await writeFile(
    path.join(dir, "law.txt"),
    `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실에 정책과 및 지원과를 둔다.
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "cases.json"),
    JSON.stringify({
      cases: [
        {
          id: "half",
          institution: "시험부",
          date: "2026-07-24",
          inputs: ["law.txt"],
          paper: "a4-half",
          layout: "best",
        },
        {
          id: "landscape",
          institution: "시험부",
          date: "2026-07-24",
          inputs: ["law.txt"],
          paper: "a4-landscape",
          layout: "horizontal",
        },
      ],
    }),
    "utf8",
  );

  const result = await runBatchBuild({
    cases: path.join(dir, "cases.json"),
    "out-dir": path.join(dir, "out"),
    outputs: "deck",
    deck: path.join(dir, "review.pptx"),
  });

  assert.equal(result.deck, null);
  assert.equal(result.deckError, null);
  assert.deepEqual(result.decks.map((deck) => deck.paper), ["a4-half", "a4-landscape"]);
  for (const deck of result.decks) assert.ok((await stat(deck.path)).size > 0);
  assert.match(result.decks[0].path, /review-a4-half\.pptx$/);
  assert.match(result.decks[1].path, /review-a4-landscape\.pptx$/);
});
