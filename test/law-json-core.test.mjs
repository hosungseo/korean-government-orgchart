import assert from "node:assert/strict";
import test from "node:test";
import { flattenLawJson } from "../src/law-json-core.mjs";

test("공식 법령 JSON의 조문·항·호 내용을 직제 파서 문언으로 평탄화한다", () => {
  const text = flattenLawJson({
    법령: {
      기본정보: { 법령명_한글: "시험부와 그 소속기관 직제" },
      조문: {
        조문단위: [{
          조문내용: "제1조(하부조직) 시험부에 정책실을 둔다.",
          항: [{ 항내용: "① 정책실장 밑에 기획과를 둔다.", 호: [{ 호내용: "1. 기획과" }] }],
        }],
      },
    },
  });

  assert.match(text, /시험부와 그 소속기관 직제/);
  assert.match(text, /제1조\(하부조직\)/);
  assert.match(text, /정책실장 밑에 기획과/);
  assert.match(text, /1\. 기획과/);
});
