import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatBatchAuditMarkdown,
  runBatchAudit,
  summarizeAuditCase,
} from "../src/batch-audit.mjs";

test("배치 감사 요약은 검토·별표·소관·배치 문제를 집계한다", () => {
  const report = {
    meta: { institution: "시험부", title: "시험부", asOf: "2026-07-24", status: "needs-correction" },
    summary: { nodes: 12, edges: 11 },
    reviewActions: [
      { priority: "high", message: "상자 겹침" },
      { priority: "medium", message: "소관 확인" },
      { priority: "low", message: "관리폭 확인" },
    ],
    validation: ["차관보 하부조직 확인"],
    warnings: ["경고"],
    annexRequirements: [{ annex: "별표 1", matchedAnnex: null }],
    annexOrganizations: [{ annex: "별표 1" }],
    jurisdictionRelations: [{ parent: "정책관", child: "정책과" }],
    jurisdictionCandidates: [{ parent: "시험실", advisor: "산업정책관", departments: ["정책과", "지원과"] }],
    jurisdictionCrosswalks: { confirmed: [{ child: "정책과" }], unresolved: [{ department: "지원과" }] },
    jurisdictionRunInferences: [{ parent: "시험실", advisor: "산업정책관", departments: ["지원과"] }],
    lawMap: { matchedInstitution: "시험부", matchedDepartments: 3, lawCount: 10, unmatchedDepartments: [{}] },
    layoutRecommendations: [{ message: "분할 권장" }],
    layoutDiagnostics: [
      { diagnostics: { overflow: [{}], overlaps: [{}, {}], edgeIssues: [{}] } },
    ],
  };

  const summary = summarizeAuditCase({
    caseSpec: { id: "case-1", paper: "a4-half", layout: "vertical", focus: "시험실" },
    report,
    view: "operational",
    pages: [
      {
        pageNumber: 1,
        pageCount: 2,
        subtitle: "시험실",
        layoutStyle: "vertical-stack",
        selectedBy: "best-fit",
        bestFit: {
          selectedLayoutStyle: "vertical-stack",
          selectionReason: "vertical-stack은 hard issue가 같고 품질 issue 0건으로 선택했습니다.",
          candidateScores: [
            { style: "vertical-stack", score: 100, diagnostics: { totalIssues: 0, pages: 1 } },
            { style: "catalog", score: 101, diagnostics: { totalIssues: 0, pages: 1 } },
          ],
        },
      },
      {
        pageNumber: 2,
        pageCount: 2,
        subtitle: "시험실 부록",
        layoutStyle: "vertical-stack",
        selectedBy: "best-fit",
      },
    ],
  });

  assert.equal(summary.status, "needs-correction");
  assert.equal(summary.reviewActions.high, 1);
  assert.equal(summary.annex.missing, 1);
  assert.equal(summary.jurisdiction.candidateDepartments, 2);
  assert.equal(summary.jurisdiction.rangeUnresolved, 1);
  assert.equal(summary.jurisdiction.orderedRunDepartments, 1);
  assert.equal(summary.layoutDiagnostics.totalIssues, 4);
  assert.equal(summary.layoutRecommendations, 1);
  assert.equal(summary.lawMap.unmatchedDepartments, 1);
  assert.deepEqual(summary.layoutSelection.selected, ["vertical-stack"]);
  assert.equal(summary.layoutSelection.bestFit.selectedLayoutStyle, "vertical-stack");
  assert.match(summary.layoutSelection.bestFit.selectionReason, /품질 issue/);
  assert.equal(summary.layoutSelection.bestFit.candidateScores.length, 2);
});

test("배치 감사 마크다운은 기관별 품질 매트릭스를 만든다", () => {
  const markdown = formatBatchAuditMarkdown({
    generatedAt: "2026-08-02T00:00:00.000Z",
    total: 1,
    statusCounts: { "needs-review": 1 },
    cases: [
      {
        summary: {
          id: "시험부",
          institution: "시험부",
          asOf: "2026-07-24",
          view: "operational",
          focus: "시험실",
          status: "needs-review",
          statusLabel: "검토 필요",
          nodes: 10,
          pages: 1,
          reviewActions: { high: 0, medium: 1, low: 0, total: 1 },
          annex: { requirements: 1, missing: 0 },
          jurisdiction: { relations: 2, candidateDepartments: 3, orderedRunDepartments: 0 },
          layoutDiagnostics: { totalIssues: 0 },
          layoutSelection: { selected: ["vertical-stack"] },
        },
        report: {
          reviewActions: [{ priority: "medium", message: "정책관 소관 확인" }],
        },
      },
    ],
  });

  assert.match(markdown, /# 조직도 batch audit/);
  assert.match(markdown, /\| 시험부 \| 2026-07-24 \| operational \| 시험실 \| vertical-stack \| 검토 필요/);
  assert.match(markdown, /정책관 소관 확인/);
});

test("배치 감사는 케이스 파일 기준 상대경로 입력을 읽는다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-batch-"));
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
          id: "local-case",
          institution: "시험부",
          date: "2026-07-24",
          inputs: ["law.txt"],
          paper: "a4-half",
          layout: "vertical",
          focus: "시험실",
        },
      ],
    }),
    "utf8",
  );

  const result = await runBatchAudit({ cases: path.join(dir, "cases.json") });

  assert.equal(result.total, 1);
  assert.equal(result.cases[0].summary.institution, "시험부");
  assert.equal(result.cases[0].summary.pages, 1);
  assert.deepEqual(result.cases[0].summary.layoutSelection.selected, ["vertical-stack"]);
  assert.notEqual(result.cases[0].summary.status, "error");
});

test("배치 감사는 같은 실행 안에서 동일 법령 조회를 캐시한다", async () => {
  const calls = [];
  const fetchLawAtDate = async (lawName, requestedDate) => {
    calls.push(`${lawName}:${requestedDate}`);
    return {
      lawName,
      requestedDate,
      effectiveDate: requestedDate.replaceAll("-", ""),
      mst: lawName,
      sourceUrl: "https://example.test/law",
      annexes: [],
      text: `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실에 정책과 및 지원과를 둔다.
`,
    };
  };

  const result = await runBatchAudit({
    caseSpecs: [
      { id: "a", institution: "시험부", date: "2026-07-24", layout: "best" },
      { id: "b", institution: "시험부", date: "2026-07-24", layout: "best" },
    ],
    fetchLawAtDate,
  });

  assert.equal(result.total, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [
    "시험부와 그 소속기관 직제:2026-07-24",
    "시험부와 그 소속기관 직제 시행규칙:2026-07-24",
  ]);
});

test("배치 감사는 source-dir의 법령 원문 캐시를 다음 실행에서 재사용한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgchart-source-cache-"));
  const sourceDir = path.join(dir, "sources");
  const caseSpecs = [
    { id: "cached", institution: "시험부", date: "2026-07-24", layout: "best" },
  ];
  let calls = 0;
  const fetchLawAtDate = async (lawName, requestedDate) => {
    calls += 1;
    return {
      lawName,
      requestedDate: requestedDate.replaceAll("-", ""),
      effectiveDate: requestedDate.replaceAll("-", ""),
      mst: lawName,
      sourceUrl: "https://example.test/law",
      metadata: { lawName },
      json: null,
      annexes: [],
      text: `
@기관: 시험부
제2조(하부조직) 시험부에 시험실을 둔다.
시험실에 정책과 및 지원과를 둔다.
`,
    };
  };

  const first = await runBatchAudit({ caseSpecs, "source-dir": sourceDir, fetchLawAtDate });
  assert.equal(first.cases[0].summary.status, "ready");
  assert.equal(calls, 2);

  const cachedFile = path.join(sourceDir, ".law-cache", "시험부와 그 소속기관 직제-20260724.json");
  assert.match(await readFile(cachedFile, "utf8"), /시험부와 그 소속기관 직제/);

  const second = await runBatchAudit({
    caseSpecs,
    "source-dir": sourceDir,
    fetchLawAtDate: async () => {
      throw new Error("API를 호출하면 안 됩니다.");
    },
  });

  assert.equal(second.total, 1);
  assert.equal(second.cases[0].summary.status, "ready");
});
