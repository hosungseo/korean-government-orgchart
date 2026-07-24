# 대한민국 행정기관 직제 → 조직도

직제·직제 시행규칙의 한국어 문언을 읽어 조직 모델을 만들고, 편집 가능한 PowerPoint 조직도와 SVG·JSON을 생성하는 Node.js 프로그램입니다.

세 부처 기구도 PPTX를 분석해 다음 시각 문법을 기본값으로 삼았습니다.

- 기관장·부기관장: 파란색 가로 상자
- 실·국·관: 가로 상자
- 과·팀: 공간이 좁으면 세로 상자
- 보조·지휘 관계: 실선
- 보좌 관계: 점선
- 소속기관: 초록색
- 총액인건비·자율·평가·한시 조직: `(총)`, `(자)`, `(평)`, `(한)` 표식
- 연구직·지도직·전문직·전문경력관·특정직 보직: `(연)`, `(지)`, `(전)`, `(특)` 표식(세부 범주는 JSON 메타데이터로 구분)
- 조직 규모에 따라 한 장형 또는 개요+분할형을 자동 선택

## 빠른 실행

Codex 번들 환경에서는 먼저 artifact-tool을 연결합니다.

```bash
node /Users/seohoseong/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime/plugins/presentations/skills/presentations/container_tools/setup_artifact_tool_workspace.mjs \
  --workspace /Users/seohoseong/orgchart-generator
```

예제:

```bash
cd /Users/seohoseong/orgchart-generator
npm test
npm run demo
```

결과:

- `outputs/sample-orgchart.pptx`
- `outputs/sample-orgchart.svg`
- `outputs/sample-orgchart.json`
- `outputs/sample-preview/`

## 1. 텍스트 파일로 생성

직제와 시행규칙을 함께 넣는 것이 가장 정확합니다.

```bash
node src/cli.mjs build \
  --input 직제.txt \
  --input 시행규칙.txt \
  --date 2025-11-25 \
  --out outputs/조직도.pptx \
  --svg outputs/조직도.svg \
  --json outputs/조직도.json \
  --preview-dir outputs/preview
```

`--layout`은 `auto`, `compact`, `split` 중 하나입니다.

`--view legal`(기본)은 직제의 설치 문언을 그대로 그리고, `--view operational`은 시행규칙·공식 조직표로 확인된 `@소관` 및 `jurisdiction` 관계를 정책관·국 아래의 점선 묶음으로 추가 배치합니다. 운영형도 JSON의 법정 설치관계를 바꾸지 않습니다.

## 2. 법제처 API에서 기준일 연혁을 찾아 생성

```bash
node src/cli.mjs from-law \
  --decree "행정안전부와 그 소속기관 직제" \
  --rule "행정안전부와 그 소속기관 직제 시행규칙" \
  --date 2025-11-25 \
  --out outputs/행정안전부.pptx \
  --svg outputs/행정안전부.svg \
  --json outputs/행정안전부.json \
  --source-dir work/legal-snapshots/mois
```

인증값은 `--oc` 또는 `LAW_API_OC`로 지정합니다. 지정하지 않으면 법제처 예제 인증값 `test`를 사용합니다. 운영 서비스에서는 국가법령정보 공동활용에서 발급받은 인증값을 쓰는 것이 안전합니다.

기준일 선택 방식:

1. 현행·연혁 목록을 최대 100건 조회
2. 법령명이 정확히 일치하는 항목만 남김
3. `시행일자 <= 기준일` 중 가장 최근 항목 선택
4. 선택된 `MST`와 시행일자로 본문 조회

따라서 문체부 2025-07-01 사례처럼 직제 대통령령은 2025-02-25 시행본, 시행규칙은 2025-07-01 시행본이 선택될 수 있습니다.

## 과 단위 소관법령 지도 연결

법제처 연락부서 피벗(`부처 → 부서 → laws`)은 선택적으로 정확히 같은 이름의 조직 노드에 연결할 수 있습니다. 연결 결과는 PPT의 기본 표기를 과도하게 늘리지 않고 JSON의 `node.metadata.lawResponsibility`에 법령 수·목록·연락처로 저장합니다.

```bash
node src/cli.mjs build \
  --input 직제.txt --input 시행규칙.txt \
  --date 2026-07-24 \
  --law-map dept_map.json --law-map-date 2026-07-24 \
  --law-counts --law-appendix \
  --out outputs/소관법령-기구도.pptx \
  --json outputs/조직도.json
```

`--law-counts`는 가로 조직 상자에 `(법 n)`, 세로 과 상자 아래에 회색 숫자로 소관법령 수를 표시합니다. `--law-appendix`는 부서별 법령 수와 대표 법령 두 건을 정리한 PPTX·SVG 부록을 뒤에 붙입니다.

`--law-map-date`는 지도 생성 기준일입니다. 기구도 기준일과 다르거나 생략되면, 부서 개편에 따른 오매칭을 막기 위해 JSON `meta.warnings`에 정합성 경고를 남깁니다. 별표·부칙처럼 지도에 없는 조직 정보는 추정하지 않습니다.

## 3. 문언만 내려받기

```bash
node src/cli.mjs fetch \
  --law "공정거래위원회와 그 소속기관 직제" \
  --law "공정거래위원회와 그 소속기관 직제 시행규칙" \
  --date 2025-10-13 \
  --out work/ftc-20251013.txt
```

## 텍스트 지시문

법령 문언만으로 모호한 부분은 같은 텍스트 안에서 보정할 수 있습니다.

```text
@기관: 행정안전부
@기관장: 장관
@부기관장: 차관
@기준일: 2025-11-25
@유형: 감사관 = 보좌기관
@관계: 차관 > 감사관 [보좌]
@관계: 행정안전부 > 국가기록원 [소속]
@소관: 산업정책관 > 산업정책과ㆍ산업일자리혁신과 [공식 조직표 2026-07-24]
```

지원 관계 표기:

- `[보좌]`: 점선
- `[소속]`: 소속기관
- `[한시]`: 한시조직
- 생략: 보조·지휘 관계

`@소관`은 법정 설치계선을 바꾸지 않는 운영상 소관 묶음입니다. 시행규칙의 `○○정책관 내 다른 과` 문언이나 기준일이 확인된 공식 조직표·인사발령을 근거로 과를 정책관 또는 국 아래에 묶고 싶을 때 사용합니다. 출처는 대괄호에 남깁니다.

## 문언 해석 규칙

- `A에 B·C를 둔다` → `A > B`, `A > C`
- `A 밑에 B를 둔다` → `A > B`
- `A 밑에 두는 보좌기관은 B로 한다` → 점선 보좌 관계
- `B는 A를 보좌한다` → `A > B` 보좌 관계
- `A과 … B정책관 내 다른 과의 주관/소관` → `B정책관 ⇢ A과` 소관 메타데이터(법정 `실 > A과` 설치계선은 유지)
- `장관 소속으로 B를 둔다` → 소속기관
- `YYYY년 M월 D일까지 존속하는 한시조직으로 B를 둔다` → 한시조직과 만료일
- `실장·국장·과장·팀장` → 조직명 `실·국·과·팀`으로 정규화
- `이하 "약칭"이라 한다` → 약칭과 정식 명칭 병합

직제는 주로 기관장·차관·실·국·소속기관을, 시행규칙은 과·팀과 구체적인 보좌기관을 정하므로 두 문서를 병합합니다.

## 구조

```text
src/
  law-api.mjs       기준일 연혁 조회와 법령 JSON 평문 변환
  parser.mjs        한국어 직제 문언 파서
  model.mjs         조직 그래프와 법적 관계
  layout.mjs        한 장형·분할형 페이지 계획과 좌표 계산
  render-pptx.mjs   네이티브 PowerPoint 도형 생성
  render-svg.mjs    검토용 SVG 생성
  cli.mjs           명령행 인터페이스
```

상세한 PPT 분석과 법적 모델은 [docs/reference-and-legal-model.md](docs/reference-and-legal-model.md)를 참고하세요.
8개 기관 유형을 교차 검증한 구현 규칙은 [docs/drafting-rulebook.md](docs/drafting-rulebook.md)에 정리했습니다.

## 현재 범위

- 책임운영기관의 세부 하부조직이 기본운영규정에만 있으면 직제·시행규칙만으로는 복원할 수 없습니다.
- 평가대상·총액인건비·자율기구 표식은 문언에 조직명이 명시되거나 텍스트 지시문이 있을 때 확정합니다.
- 같은 이름의 과가 여러 지방사무소에 반복되는 경우 JSON에는 다중 부모 관계를 보존하고, 각 페이지에서는 해당 소속기관 문맥으로 배치합니다.
- 세무서처럼 본문이 과명 풀만 제시하고 실제 편성을 별표 매트릭스에 위임하는 경우, 별표가 없으면 확정 조직을 추정하지 않습니다. 필요한 별표는 `meta.annexRequirements`에 남깁니다.
- 2026년 취합본의 기구표·정원표 집계 항목은 분석 문서와 메타데이터 설계에 반영했으며, 상단 인쇄 표 레이아웃은 디자인 단계에서 추가합니다.

## 법적 판정의 핵심

- `X에 A를 둔다`는 보조기관, `Y 밑에 D를 둔다`는 보좌기관으로 판정합니다.
- 접미사보다 문형을 우선하므로 `차관 밑에 기획조정실장`은 법적으로 보좌기관입니다.
- 복수차관은 `제N차관은 …의 소관업무에 관하여 장관을 보조한다`는 열거로 소관을 나눕니다.
- `관장 사무 지원`, `소관 사무 분장`, `책임운영기관`을 각각 부속기관·특별지방행정기관·책임운영기관으로 구분합니다.
- 한시조직은 조직 노드와 존속기한으로, 한시정원은 `meta.temporaryHeadcounts`로 분리합니다.
- 직무등급, 임기제·별정직, 특정직 계급, 합의제 위원 수, 겸직을 JSON 메타데이터와 PPT 약호에 반영합니다.
- 시행규칙의 `대변인 밑에 담당관·팀을 둔다`는 보좌기관 하부조직으로, 직렬·계급이 섞인 보직은 `gradeRange`와 `mixedAppointment`로, 상호이체·`다만` 단서는 별도 예외 메타데이터로 보존합니다.
- 통칙상 계층 위반은 `meta.validation`에 남깁니다.
