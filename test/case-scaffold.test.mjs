import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditCaseSpecs, parseInstitutionList } from "../src/case-scaffold.mjs";

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
