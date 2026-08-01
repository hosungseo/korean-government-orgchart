import test from "node:test";
import assert from "node:assert/strict";
import { attachAnnexes, extractAnnexesFromLawJson, parseBoxTable } from "../src/annex.mjs";
import { buildAuditReport, formatAuditMarkdown } from "../src/audit.mjs";
import { planPages } from "../src/layout.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

const annexText = `
■ 시험청 직제 [별표 1]
  지방시험청의 명칭ㆍ위치 및 관할구역
┏━━━━━━━┯━━━━━┯━━━━━━━━┓
┃명칭          │위치      │관할구역        ┃
┠───────┼─────┼────────┨
┃서울지방시험청│서울특별시│서울특별시      ┃
┠───────┼─────┼────────┨
┃중부지방시험청│경기도    │경기도 수원시   ┃
┃              │          │강원특별자치도  ┃
┗━━━━━━━┷━━━━━┷━━━━━━━━┛
`;

test("법제처 별표 선그리기 표를 행 단위로 추출한다", () => {
  assert.deepEqual(parseBoxTable(annexText), [
    ["서울지방시험청", "서울특별시", "서울특별시"],
    ["중부지방시험청", "경기도", "경기도 수원시 강원특별자치도"],
  ]);
});

test("법제처 JSON에서 별표 인벤토리를 추출하고 감사 리포트에 연결한다", () => {
  const annexes = extractAnnexesFromLawJson(
    {
      법령: {
        별표: {
          별표단위: {
            별표번호: "0001",
            별표제목: "지방시험청의 명칭ㆍ위치 및 관할구역(제3조 관련)",
            별표키: "000100E",
            별표시행일자: "20260701",
            별표내용: [[annexText]],
          },
        },
      },
    },
    { source: "시험청 직제 [시행 20260701]" },
  );
  assert.equal(annexes.length, 1);
  assert.equal(annexes[0].annex, "별표 1");
  assert.equal(annexes[0].type, "jurisdiction");
  assert.equal(annexes[0].rowCount, 2);

  const graph = parseOrganizationTexts([
    `
@기관: 시험청
제2조(하부조직) 시험청에 운영지원과를 둔다.
지방시험청의 명칭ㆍ위치 및 관할구역은 별표 1과 같다.
`,
  ]);
  attachAnnexes(graph, annexes);
  const report = buildAuditReport(graph, planPages(graph, { paper: "a4-half", layout: "vertical" }));
  assert.equal(report.annexes.length, 1);
  assert.equal(report.annexRequirements[0].matchedAnnex.rowCount, 2);
  assert.match(formatAuditMarkdown(report), /별표 인벤토리/);
  assert.match(formatAuditMarkdown(report), /별표 1 · jurisdiction · 지방시험청/);
});
