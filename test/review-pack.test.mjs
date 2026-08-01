import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBatchAudit } from "../src/batch-audit.mjs";
import {
  buildAcceptedCasesDocument,
  buildSuggestedCasesDocument,
  formatReviewWorklistMarkdown,
  runReviewPack,
} from "../src/review-pack.mjs";

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
    "rerun-suggested": true,
  });

  assert.equal(result.caseCount, 1);
  assert.equal(result.audit.total, 1);
  assert.equal(result.build.total, 1);
  assert.equal(result.build.deckError, null);
  assert.match(await readFile(result.files.readme, "utf8"), /조직도 검토팩/);
  assert.match(await readFile(result.files.readme, "utf8"), /케이스별 산출물/);
  assert.match(await readFile(result.files.readme, "utf8"), /검토 작업목록/);
  assert.match(await readFile(result.files.readme, "utf8"), /자동 보강 재실행/);
  assert.match(await readFile(result.files.readme, "utf8"), /채택 케이스/);
  assert.match(await readFile(result.files.worklist, "utf8"), /조직도 검토 작업목록/);
  assert.match(await readFile(result.files.worklist, "utf8"), /입력에 붙여넣을 보강 지시문 후보/);
  assert.ok((await stat(result.files.cases)).size > 0);
  assert.ok((await stat(result.files.suggestedCases)).size > 0);
  assert.ok((await stat(result.files.acceptedCases)).size > 0);
  assert.match(await readFile(result.files.audit, "utf8"), /조직도 batch audit/);
  assert.match(await readFile(result.files.manifest, "utf8"), /조직도 batch build/);
  assert.ok((await stat(result.files.auditJson)).size > 0);
  assert.ok((await stat(result.files.manifestJson)).size > 0);
  assert.ok((await stat(result.build.deck)).size > 0);
  assert.match(await readFile(result.build.cases[0].outputs.svg, "utf8"), /<svg/);
  assert.match(await readFile(result.build.cases[0].outputs.trace, "utf8"), /산업정책관/);

  const suggested = JSON.parse(await readFile(result.files.suggestedCases, "utf8"));
  assert.equal(suggested.changedCases, 1);
  assert.equal(suggested.cases[0].inputs[0], "../law.txt");
  assert.match(suggested.cases[0].directives.join("\n"), /@소관: 산업정책관 > 정책과ㆍ지원과/);

  const suggestedAudit = await runBatchAudit({ cases: result.files.suggestedCases });
  assert.equal(suggestedAudit.cases[0].summary.jurisdiction.relations, 2);
  assert.equal(suggestedAudit.cases[0].summary.jurisdiction.candidateDepartments, 0);

  assert.equal(result.rerun.skipped, undefined);
  assert.equal(result.rerun.changedCases, 1);
  assert.ok((await stat(result.rerun.files.readme)).size > 0);
  assert.equal(result.rerun.comparison.before.jurisdictionCandidates, 2);
  assert.equal(result.rerun.comparison.after.jurisdictionCandidates, 0);
  assert.equal(result.rerun.comparison.delta.jurisdictionCandidates, -2);

  const accepted = JSON.parse(await readFile(result.files.acceptedCases, "utf8"));
  assert.equal(accepted.evaluated, true);
  assert.equal(accepted.acceptedCases, 1);
  assert.equal(accepted.rejectedCases, 0);
  assert.equal(accepted.cases[0].accepted.decision, "accepted");
  assert.match(accepted.cases[0].directives.join("\n"), /@소관: 산업정책관 > 정책과ㆍ지원과/);
});

test("review-pack 작업목록은 지시문·별표·레이아웃·소관법령 문제를 요약한다", () => {
  const markdown = formatReviewWorklistMarkdown({
    generatedAt: "2026-08-02T00:00:00.000Z",
    caseCount: 1,
    exportedCases: [
      {
        id: "case-a",
        institution: "시험부",
        layout: "vertical",
        layouts: "vertical,catalog",
        paper: "a4-half",
      },
    ],
    audit: {
      cases: [
        {
          summary: {
            id: "case-a",
            institution: "시험부",
            asOf: "2026-07-24",
            focus: "정책실",
            paper: "a4-half",
            layoutDiagnostics: {
              totalIssues: 1,
              qualityIssues: 3,
            },
            lawMap: {
              unmatchedDepartments: 2,
              ambiguousDepartments: 1,
            },
          },
          report: {
            jurisdictionCandidates: [
              {
                parent: "정책실",
                advisor: "산업정책관",
                departments: ["정책과", "지원과"],
                directive: "@소관: 산업정책관 > 정책과ㆍ지원과 [시행규칙 분장사무 확인 필요]",
              },
              {
                parent: "정책실",
                advisor: "제도정책관ㆍ현장지원관",
                departments: ["제도과"],
                directive: null,
              },
            ],
            jurisdictionCrosswalks: {
              unresolved: [
                {
                  department: "제도과",
                  reference: "제10조제3항 제4호",
                  advisors: ["제도정책관", "현장지원관"],
                },
              ],
            },
            annexRequirements: [
              {
                annex: "별표 5",
                description: "세부 기관 확인",
                source: "직제 시행규칙",
              },
            ],
          },
        },
      ],
    },
    build: { cases: [] },
    files: {},
  });

  assert.match(markdown, /@소관: 산업정책관 > 정책과ㆍ지원과/);
  assert.match(markdown, /복수 보좌기관/);
  assert.match(markdown, /별표 5/);
  assert.match(markdown, /cases\.json 보정 예/);
  assert.match(markdown, /미매칭/);
  assert.match(markdown, /중복 후보/);
});

test("review-pack 자동 보강 케이스는 단일 @소관 후보와 layout 패치를 반영한다", () => {
  const suggested = buildSuggestedCasesDocument({
    generatedAt: "2026-08-02T00:00:00.000Z",
    exportedCases: [
      {
        id: "case-a",
        institution: "시험부",
        layout: "vertical",
        layouts: "vertical,catalog",
        paper: "a4-half",
        directives: ["@유형: 시험부 = 기관장"],
      },
    ],
    audit: {
      cases: [
        {
          summary: {
            id: "case-a",
            institution: "시험부",
            paper: "a4-half",
            layoutDiagnostics: {
              totalIssues: 2,
              qualityIssues: 1,
            },
          },
          report: {
            jurisdictionCandidates: [
              {
                confidence: "single-advisor-container",
                directive: "@소관: 산업정책관 > 정책과ㆍ지원과 [시행규칙 분장사무 확인 필요]",
              },
              {
                confidence: "multiple-advisors-need-range-crosswalk",
                directive: null,
              },
            ],
          },
        },
      ],
    },
  });

  assert.equal(suggested.changedCases, 1);
  assert.equal(suggested.cases[0].layout, "catalog");
  assert.equal(suggested.cases[0].paper, "a4-portrait");
  assert.equal(suggested.cases[0].maxNodes, 14);
  assert.equal("layouts" in suggested.cases[0], false);
  assert.deepEqual(suggested.cases[0].directives, [
    "@유형: 시험부 = 기관장",
    "@소관: 산업정책관 > 정책과ㆍ지원과 [시행규칙 분장사무 확인 필요]",
  ]);
  assert.equal(suggested.cases[0].suggested.changes.length, 2);
});

test("review-pack 채택 케이스는 악화된 자동 보강안을 거절한다", () => {
  const originalCase = {
    id: "case-a",
    institution: "시험부",
    paper: "a4-half",
    layout: "best",
  };
  const suggestedCase = {
    ...originalCase,
    layout: "catalog",
    suggested: {
      source: "review-pack",
      changes: [{ type: "layout", patch: { layout: "catalog" } }],
    },
  };
  const accepted = buildAcceptedCasesDocument({
    generatedAt: "2026-08-02T00:00:00.000Z",
    exportedCases: [originalCase],
    suggestedCases: {
      cases: [suggestedCase],
    },
    audit: {
      cases: [
        {
          summary: {
            id: "case-a",
            institution: "시험부",
            reviewActions: { high: 0, medium: 0, low: 1 },
            layoutDiagnostics: { totalIssues: 0, qualityIssues: 1 },
            jurisdiction: { candidateDepartments: 0 },
            annex: { missing: 0 },
          },
        },
      ],
    },
    rerun: {
      audit: {
        cases: [
          {
            summary: {
              id: "case-a",
              institution: "시험부",
              reviewActions: { high: 1, medium: 0, low: 0 },
              layoutDiagnostics: { totalIssues: 0, qualityIssues: 0 },
              jurisdiction: { candidateDepartments: 0 },
              annex: { missing: 0 },
            },
          },
        ],
      },
    },
  });

  assert.equal(accepted.acceptedCases, 0);
  assert.equal(accepted.rejectedCases, 1);
  assert.equal(accepted.decisions[0].decision, "rejected");
  assert.equal(accepted.decisions[0].selected, "original");
  assert.equal(accepted.cases[0].layout, "best");
  assert.equal(accepted.cases[0].accepted.decision, "rejected");
});
