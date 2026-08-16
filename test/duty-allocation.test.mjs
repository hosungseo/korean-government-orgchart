import assert from "node:assert/strict";
import test from "node:test";
import { compareDutyAllocations, formatAllocationLine, formatCompactShares } from "../src/duty-allocation.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

const beforeText = `
@기관: 시험부
시험부에 디지털정부실을 둔다.
디지털정부실에 디지털정책과를 둔다.
① 디지털정책과장은 직제 제10조제3항제1호부터 제10호까지의 사항을 분장한다.
`;

const afterText = `
@기관: 시험부
시험부에 인공지능정부실을 둔다.
인공지능정부실에 인공지능정책과ㆍ데이터정책과를 둔다.
① 인공지능정책과장은 직제 제10조제3항제1호부터 제4호까지의 사항을 분장한다.
② 데이터정책과장은 직제 제10조제3항제5호부터 제10호까지의 사항을 분장한다.
`;

test("과 분장 조문이 재인용한 직제 호를 과 메타데이터로 저장한다", () => {
  const graph = parseOrganizationTexts([beforeText]);
  const department = graph.nodeByName("디지털정책과");
  assert.equal(department.metadata.dutyItems.items.length, 10);
  assert.equal(department.metadata.dutyItems.items[0].number, 1);
  assert.equal(department.metadata.dutyItems.items.at(-1).number, 10);
  assert.match(department.metadata.dutyItems.reference, /제10조제3항/);
  assert.equal(graph.meta.dutyItemAssignments.length, 1);
});

test("한 과의 호가 둘로 갈리면 양쪽 비율을 모두 보여 준다", () => {
  const comparison = compareDutyAllocations(
    parseOrganizationTexts([beforeText]),
    parseOrganizationTexts([afterText]),
  );
  const unit = comparison.units.find((item) => item.unit === "디지털정책과");
  assert.equal(unit.itemCount, 10);
  assert.equal(unit.unmatched, 0);
  assert.deepEqual(
    unit.shares.map((share) => [share.unit, share.percent, share.count]),
    [
      ["데이터정책과", 60, 6],
      ["인공지능정책과", 40, 4],
    ],
  );
  assert.match(unit.shares[0].label, /제5~10호/);
  assert.match(unit.shares[1].label, /제1~4호/);
  assert.match(formatAllocationLine(unit), /40% → 인공지능정책과/);
  assert.match(formatAllocationLine(unit), /60% → 데이터정책과/);
  assert.equal(comparison.notable.length, 1);
});

test("재인용이 없으면 호 분할을 추정하지 않는다", () => {
  const before = parseOrganizationTexts([`
@기관: 시험부
시험부에 기획실을 둔다.
기획실에 기획과를 둔다.
① 기획과장은 다음 사항을 분장한다.
1. 기획 총괄
2. 예산
`]);
  const after = parseOrganizationTexts([`
@기관: 시험부
시험부에 기획실을 둔다.
기획실에 기획과ㆍ예산과를 둔다.
① 기획과장은 다음 사항을 분장한다.
1. 기획 총괄
② 예산과장은 다음 사항을 분장한다.
1. 예산
`]);
  const comparison = compareDutyAllocations(before, after);
  assert.equal(comparison.units.length, 0);
  assert.equal(comparison.notable.length, 0);
  assert.equal(before.nodeByName("기획과").metadata.dutyItems, undefined);
});

const decreeBefore = `
시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 디지털정부실을 둔다.
디지털정부실에 디지털정책과를 둔다.
제10조(사무분장)
③ 디지털정부실장은 다음 사항을 분장한다.
1. 인공지능 정책의 수립
2. 인공지능 서비스
3. 공공데이터 정책
4. 데이터 분석
5. 정보화 예산
6. 정보화 평가
`;

const ruleBefore = `
시험부와 그 소속기관 직제 시행규칙
제3조(디지털정부실)
① 디지털정책과장은 직제 제10조제3항제1호부터 제6호까지의 사항을 분장한다.
`;

const decreeAfterRenumbered = `
시험부와 그 소속기관 직제
제2조(하부조직) 시험부에 인공지능정부실을 둔다.
인공지능정부실에 인공지능정책과ㆍ데이터정책과를 둔다.
제12조(사무분장)
② 인공지능정부실장은 다음 사항을 분장한다.
1. 그 밖에 다른 과의 주관에 속하지 않는 사항
2. 내부 행정
3. 인공지능 정책의 수립
4. 인공지능 서비스
5. 공공데이터 정책
6. 데이터 분석
7. 정보화 예산
8. 정보화 평가
`;

const ruleAfterRenumbered = `
시험부와 그 소속기관 직제 시행규칙
제3조(인공지능정부실)
① 인공지능정책과장은 직제 제12조제2항제3호부터 제4호까지의 사항을 분장한다.
② 데이터정책과장은 직제 제12조제2항제5호부터 제8호까지의 사항을 분장한다.
`;

test("직제 호 문언을 카탈로그로 저장한다", () => {
  const graph = parseOrganizationTexts([decreeBefore, ruleBefore]);
  const catalog = graph.meta.dutyItemCatalog.filter((item) => item.refKey === "제10조제3항");
  assert.equal(catalog.length, 6);
  assert.equal(catalog[0].text, "인공지능 정책의 수립");
  assert.equal(catalog[2].number, 3);
});

test("호 번호가 바뀌어도 문언이 같으면 분할 비율을 잇는다", () => {
  const comparison = compareDutyAllocations(
    parseOrganizationTexts([decreeBefore, ruleBefore]),
    parseOrganizationTexts([decreeAfterRenumbered, ruleAfterRenumbered]),
  );
  const unit = comparison.units.find((item) => item.unit === "디지털정책과");
  assert.equal(unit.itemCount, 6);
  assert.equal(unit.unmatched, 0);
  assert.deepEqual(
    unit.shares.map((share) => [share.unit, share.percent]),
    [
      ["데이터정책과", 67],
      ["인공지능정책과", 33],
    ],
  );
  assert.match(formatCompactShares(unit), /33%→인공지능정책과/);
  assert.match(formatCompactShares(unit), /67%→데이터정책과/);
});

test("잔여호 그 밖에는 문언으로 대응하지 않는다", () => {
  const before = parseOrganizationTexts([`
시험부 직제
제2조(하부조직) 시험부에 기획실을 둔다.
기획실에 기획과를 둔다.
제8조(사무분장)
① 기획실장은 다음 사항을 분장한다.
1. 그 밖에 다른 과의 주관에 속하지 않는 사항
`, `
시험부 직제 시행규칙
① 기획과장은 직제 제8조제1항제1호의 사항을 분장한다.
`]);
  const after = parseOrganizationTexts([`
시험부 직제
제2조(하부조직) 시험부에 기획실을 둔다.
기획실에 총괄과를 둔다.
제9조(사무분장)
① 기획실장은 다음 사항을 분장한다.
1. 그 밖에 다른 과의 주관에 속하지 않는 사항
`, `
시험부 직제 시행규칙
① 총괄과장은 직제 제9조제1항제1호의 사항을 분장한다.
`]);
  const comparison = compareDutyAllocations(before, after);
  const unit = comparison.units.find((item) => item.unit === "기획과");
  assert.equal(unit.unmatched, 1);
  assert.equal(unit.shares.length, 0);
});

