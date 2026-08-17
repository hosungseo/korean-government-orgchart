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

test("법령 JSON에 번호가 내용과 분리되어 있어도 항·호·목 표지를 복원한다", () => {
  const text = flattenLawJson({
    법령: {
      기본정보: { 법령명_한글: "시험부 직제 시행규칙" },
      조문: {
        조문단위: [{
          조문내용: "제7조(문화정책실)",
          항: [{
            항번호: "1",
            항내용: "국제문화과장은 다음 사항을 분장한다.",
            호: [{
              호번호: "1의2",
              호내용: "해외 문화사업 지원",
              목: [
                { 목번호: "가", 목내용: "재외공관 문화행사" },
                { 목번호: "나", 목내용: "문화원 운영 지원" },
              ],
            }],
          }],
        }],
      },
    },
  });

  assert.match(text, /① 국제문화과장은/);
  assert.match(text, /1의2\. 해외 문화사업 지원/);
  assert.match(text, /가\. 재외공관 문화행사/);
  assert.match(text, /나\. 문화원 운영 지원/);
});
