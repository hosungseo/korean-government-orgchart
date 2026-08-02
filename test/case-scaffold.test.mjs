import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditCaseSpecs, expandCaseSpecsByLayouts, parseInstitutionList } from "../src/case-scaffold.mjs";

test("기관명 목록은 쉼표와 줄바꿈을 모두 지원하고 중복을 제거한다", () => {
  assert.deepEqual(parseInstitutionList(["행정안전부, 산업통상부", "행정안전부\n공정거래위원회"]), [
    "행정안전부",
    "산업통상부",
    "공정거래위원회",
  ]);
});

test("기관명 목록에서 batch-audit 케이스 JSON을 만든다", () => {
  const result = buildAuditCaseSpecs({
    institutions: "행정안전부,산업통상부",
    date: "2026-07-24",
    paper: "a4-half",
    layout: "best",
    view: "operational",
  });

  assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases[0], {
    id: "행정안전부-2026-07-24",
    institution: "행정안전부",
    date: "2026-07-24",
    view: "operational",
    paper: "a4-half",
    layout: "best",
  });
});

test("기관명 케이스 생성은 여러 레이아웃 지정도 보존한다", () => {
  const result = buildAuditCaseSpecs({
    institutions: "행정안전부",
    date: "2026-07-24",
    paper: "a4-landscape",
    layouts: "horizontal,two-column,catalog",
  });

  assert.deepEqual(result.cases[0], {
    id: "행정안전부-2026-07-24",
    institution: "행정안전부",
    date: "2026-07-24",
    view: "operational",
    paper: "a4-landscape",
    layouts: "horizontal,two-column,catalog",
  });
});

test("케이스를 레이아웃별 별도 산출물로 확장한다", () => {
  const expanded = expandCaseSpecsByLayouts([
    {
      id: "sample",
      institution: "시험부",
      date: "2026-07-24",
      inputs: ["law.txt"],
      paper: "a4-half",
      focus: "정책실",
      layout: "best",
    },
  ], "vertical,catalog");

  assert.equal(expanded.expanded, true);
  assert.equal(expanded.sourceCases, 1);
  assert.equal(expanded.expandedCases, 1);
  assert.deepEqual(expanded.cases.map((item) => item.id), [
    "sample-vertical-stack",
    "sample-catalog",
  ]);
  assert.deepEqual(expanded.cases.map((item) => item.layout), ["vertical-stack", "catalog"]);
  assert.deepEqual(expanded.cases.map((item) => item.outputName), [
    "sample-vertical-stack",
    "sample-catalog",
  ]);
  assert.equal(expanded.cases[0].layoutVariantOf, "sample");
  assert.equal(expanded.cases[0].layoutVariantLabel, "세로 척추형");
  assert.equal("layouts" in expanded.cases[0], false);
});

test("make-cases는 expandLayouts 옵션으로 기관 케이스를 즉시 확장한다", () => {
  const result = buildAuditCaseSpecs({
    institutions: "행정안전부",
    date: "2026-07-24",
    paper: "a4-half",
    layout: "best",
    focus: "재난안전관리본부",
    expandLayouts: "vertical,catalog",
  });

  assert.deepEqual(result.cases.map((item) => item.id), [
    "행정안전부-2026-07-24-vertical-stack",
    "행정안전부-2026-07-24-catalog",
  ]);
  assert.equal(result.cases[0].focus, "재난안전관리본부");
  assert.equal(result.cases[0].outputName, "행정안전부-2026-07-24-vertical-stack");
});
