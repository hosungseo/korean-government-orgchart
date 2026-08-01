import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReviewPack } from "../src/review-pack.mjs";

test("review-pack은 cases 파일에서 감사와 산출물을 한 번에 만든다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-review-pack-"));
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
          id: "review-local",
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

  const result = await runReviewPack({
    cases: path.join(dir, "cases.json"),
    "out-dir": path.join(dir, "pack"),
    outputs: "svg,json,audit,trace,deck",
  });

  assert.equal(result.caseCount, 1);
  assert.equal(result.audit.total, 1);
  assert.equal(result.build.total, 1);
  assert.equal(result.build.deckError, null);
  assert.match(await readFile(result.files.readme, "utf8"), /조직도 검토팩/);
  assert.match(await readFile(result.files.readme, "utf8"), /케이스별 산출물/);
  assert.ok((await stat(result.files.cases)).size > 0);
  assert.match(await readFile(result.files.audit, "utf8"), /조직도 batch audit/);
  assert.match(await readFile(result.files.manifest, "utf8"), /조직도 batch build/);
  assert.ok((await stat(result.files.auditJson)).size > 0);
  assert.ok((await stat(result.files.manifestJson)).size > 0);
  assert.ok((await stat(result.build.deck)).size > 0);
  assert.match(await readFile(result.build.cases[0].outputs.svg, "utf8"), /<svg/);
  assert.match(await readFile(result.build.cases[0].outputs.trace, "utf8"), /산업정책관/);
});
