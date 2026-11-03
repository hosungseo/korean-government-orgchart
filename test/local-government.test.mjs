import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNativeManifest } from "../desktop/ui/manifest-validation.js";
import { planPages, layoutPage } from "../src/layout.mjs";
import { inferDeputyTitle, inferHeadTitle } from "../src/model.mjs";
import { buildNativeLawWorkflow } from "../src/native-law-workflow.mjs";
import { parseOrganizationTexts } from "../src/parser.mjs";

// Trimmed from a city's 행정기구 설치 조례 and its 시행규칙 (2026 form).
const ordinance = `
제1장 총 칙
제1조(목적) 이 조례는 「지방자치법」 제125조부터 제134조까지의 규정에 의하여 시험시에 두는 행정기구와 소속기관 및 하부 행정기관의 설치ㆍ조직과 분장 사무의 대강을 규정함을 목적으로 한다.
제2조(국장 및 담당관ㆍ과장의 직급 등) ① 시험시(이하 “시”라 한다) 본청의 국장의 직급 등에 관한 사항은 규칙으로 정한다.
제2장 시 본 청
제3조(국의 설치) 시의 행정사무를 분장하기 위하여 기획행정국, 안전건설국을 둔다.
제4조(실ㆍ국에 속하지 아니하는 보조ㆍ보좌기관의 설치) 시장 밑에 새만금정책담당관, 부시장 밑에 감사담당관, 디지털정보담당관을 둔다.
제5조(기획행정국에 두는 과) ① 기획행정국에 기획예산과, 행정지원과, 회계과를 둔다.
제6조(안전건설국에 두는 과) ① 안전건설국에 안전총괄과, 도시계획과를 둔다.
제3장 직속기관
제1절 보건소ㆍ보건지소ㆍ보건진료소
제12조(설치) ① 「지역보건법」에 의하여 시에 보건소를, 읍ㆍ면에 보건지소를 설치한다.
② 의료 취약지역에 보건진료소를 설치한다.
제14조(보건진료소장 등) ① 보건진료소에 보건진료소장을 두고, 필요한 업무보조원을 둘 수 있다.
제2절 농업기술센터
제16조(설치) ① 농촌지도사업 등을 관장하게 하기 위하여 시에 농업기술센터(이하 “센터”라 한다)를 설치한다.
제19조(농민상담소의 설치) 센터의 소관사무를 분장하기 위하여 농민상담소(이하 “상담소”라 한다)를 둘 수 있다.
제4장 사 업 소
제20조(설치) ① 특정업무를 효율적으로 추진하기 위하여 시에 사업소를 둔다.
제21조(소장) 사업소에 소장을 두며, 소장은 시장의 명을 받아 업무를 통할한다.
제22조(소관사무) 차량등록사업소 소장이 관장하는 사무는 다음과 같다.
`;

const rule = `
제1장 총 칙
제1조(목적) 이 규칙은「시험시 행정기구 설치 조례」 제2조의 규정에 의하여 필요한 사항을 규정함을 목적으로 한다.
제2장 시 본 청
제1절 보좌기관
제4조(새만금정책담당관) 새만금정책담당관은 지방행정사무관으로 보하며 새만금정책업무에 관하여 시장을 보좌한다.
제5조(감사담당관) ① 감사담당관은 지방행정사무관으로 보하며 감사업무에 관하여 부시장을 보좌한다.
제3장 직속기관
제1절 보건소ㆍ보건지소ㆍ보건진료소
제15조(하부조직) ① 보건소장 밑에 보건행정과, 위생과를 둔다.
제2절 농업기술센터
제17조(하부조직) ① 농업기술센터 소장을 보좌하고 업무를 효율적으로 처리하기 위하여 농업정책과, 농촌지원과를 둔다.
`;

function parentNames(graph, name) {
  const node = graph.nodeByName(name);
  return graph.parentsOf(node.id).map(({ node: parent }) => parent.name);
}

test("지방자치단체 기관장·부기관장 직함을 기관명에서 추론한다", () => {
  assert.deepEqual([inferHeadTitle("군산시"), inferDeputyTitle("군산시")], ["시장", "부시장"]);
  assert.deepEqual([inferHeadTitle("완주군"), inferDeputyTitle("완주군")], ["군수", "부군수"]);
  assert.deepEqual([inferHeadTitle("강남구"), inferDeputyTitle("강남구")], ["구청장", "부구청장"]);
  assert.deepEqual([inferHeadTitle("전북특별자치도"), inferDeputyTitle("전북특별자치도")], ["도지사", "행정부지사"]);
  assert.deepEqual([inferHeadTitle("행정안전부"), inferDeputyTitle("행정안전부")], ["장관", "차관"]);
});

test("행정기구 설치 조례를 시장·부시장 계선의 조직도로 읽는다", () => {
  const graph = parseOrganizationTexts([ordinance, rule]);
  assert.equal(graph.meta.institution, "시험시");
  assert.equal(graph.meta.governmentLevel, "local");
  assert.equal(graph.nodeByName("장관"), undefined);
  assert.equal(graph.nodeByName("차관"), undefined);
  assert.equal(graph.nodeByName("시장").kind, "head");
  assert.equal(graph.nodeByName("부시장").kind, "deputy");

  // "시장 밑에 A, 부시장 밑에 B, C를 둔다" splits into two holders.
  assert.deepEqual(parentNames(graph, "새만금정책담당관"), ["시장"]);
  assert.deepEqual(parentNames(graph, "감사담당관"), ["부시장"]);
  assert.deepEqual(parentNames(graph, "디지털정보담당관"), ["부시장"]);
  assert.equal(graph.nodeByName("실ㆍ국"), undefined);

  assert.deepEqual(parentNames(graph, "기획행정국"), ["부시장"]);
  assert.deepEqual(parentNames(graph, "회계과"), ["기획행정국"]);
});

test("직속기관·사업소를 소속기관으로, 그 하부 과와 지소를 바르게 붙인다", () => {
  const graph = parseOrganizationTexts([ordinance, rule]);
  const institution = graph.meta.institution;
  assert.equal(graph.nodeByName("보건소").metadata.affiliationType, "direct");
  assert.deepEqual(parentNames(graph, "보건소"), [institution]);
  assert.deepEqual(parentNames(graph, "보건지소"), ["보건소"]);
  assert.deepEqual(parentNames(graph, "보건진료소"), ["보건소"]);
  assert.deepEqual(parentNames(graph, "보건행정과"), ["보건소"]);
  assert.equal(graph.nodeByName("보건행정과").kind, "assistant");

  assert.deepEqual(parentNames(graph, "농업기술센터"), [institution]);
  assert.deepEqual(parentNames(graph, "농민상담소"), ["농업기술센터"]);
  assert.deepEqual(parentNames(graph, "농업정책과"), ["농업기술센터"]);

  assert.equal(graph.nodeByName("차량등록사업소").metadata.affiliationType, "business-office");
  assert.deepEqual(parentNames(graph, "차량등록사업소"), [institution]);
  assert.equal(graph.nodeByName("사업소"), undefined);
  assert.deepEqual(graph.meta.validation, []);
});

test("지방자치단체 세로 조직도는 조례 순서를 지키고 조례 명칭을 표기한다", () => {
  const workflow = buildNativeLawWorkflow({ decreeText: ordinance, ruleText: rule, asOf: "2026-01-23" });
  assert.equal(workflow.summary.institution, "시험시");
  const texts = workflow.manifests.flatMap((manifest) => manifest.objects.map((object) => object.text || ""));
  assert.ok(texts.some((text) => text.includes("조례 기준 2026. 1. 23.")));
  assert.ok(texts.some((text) => text.includes("시험시 행정기구 설치 조례")));
  assert.ok(!texts.some((text) => /직제/.test(text)));
  const order = texts.filter((text) => ["기획행정국", "안전건설국"].includes(text));
  assert.deepEqual(order.slice(0, 2), ["기획행정국", "안전건설국"]);
  for (const manifest of workflow.manifests) {
    assert.equal(analyzeNativeManifest(manifest).valid, true);
  }
});

test("두 열 배치에서 여러 상위 조직의 하위조직은 각자 상위 조직 밑에 모인다", () => {
  const graph = parseOrganizationTexts([ordinance, rule]);
  const bureauIds = ["기획행정국", "안전건설국"].map((name) => graph.nodeByName(name).id);
  const ids = new Set(bureauIds);
  for (const edge of graph.edges.values()) if (ids.has(edge.parent)) ids.add(edge.child);
  const layout = layoutPage(graph, { rootIds: bureauIds, nodeIds: [...ids], layoutStyle: "two-column" }, {});
  const x = (name) => layout.nodes.find(({ node }) => node.name === name).position.centerX;
  const middle = (x("기획행정국") + x("안전건설국")) / 2;
  for (const name of ["기획예산과", "행정지원과", "회계과"]) assert.ok(x(name) < middle, name);
  for (const name of ["안전총괄과", "도시계획과"]) assert.ok(x(name) > middle, name);
  assert.ok(x("기획예산과") < x("행정지원과") && x("행정지원과") < x("회계과"));
  assert.ok(planPages(graph).length >= 1);
});
