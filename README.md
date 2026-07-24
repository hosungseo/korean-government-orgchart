# 직제 문언 → 기구도 생성기

대한민국 행정기관의 직제(대통령령)와 직제 시행규칙(부령·총리령)을 읽어 조직 그래프를 만들고, 편집 가능한 PowerPoint·SVG·JSON으로 출력하는 도구입니다.

**[라이브 데모](https://hosungseo.github.io/korean-government-orgchart/)** · **[GitHub 저장소](https://github.com/hosungseo/korean-government-orgchart)**

## 무엇을 해결하나

법령의 조직 설치 문언과 실제 기구도는 같은 나무가 아닙니다. 이 프로젝트는 다음을 분리해서 보존합니다.

- `X에 A·B를 둔다` → 보조기관(법정 계선)
- `Y 밑에 D를 둔다`·`D는 Y를 보좌한다` → 보좌기관(참모)
- `장관 소속으로 A를 둔다` → 소속기관·책임운영기관
- `정책관 내 다른 과의 주관·소관` → 법정 설치관계와 분리한 운영상 소관
- 직무등급, 일반직·임기제·별정직, 연구직·지도직·전문직·전문경력관·특정직의 복수 보임 메타데이터

기본 `legal` 보기에서는 법령상 설치관계를 그리고, `operational` 보기에서는 출처가 확인된 정책관·국 소관 묶음을 점선으로 추가합니다. 원래 법정 그래프는 JSON에 그대로 남습니다.

## 빠른 시작

```bash
cd korean-government-orgchart
npm test
npm run demo
```

`npm run demo`는 `examples/sample-law.txt`를 읽어 다음을 생성합니다.

- `outputs/sample-orgchart.pptx` — 편집 가능한 PowerPoint
- `outputs/sample-orgchart.svg` — 검토·웹 삽입용 SVG
- `outputs/sample-orgchart.json` — 노드·관계·법적 메타데이터

### 법령 텍스트에서 생성

```bash
node src/cli.mjs build \
  --input 직제.txt \
  --input 직제시행규칙.txt \
  --date 2026-07-24 \
  --view operational \
  --out outputs/기관-운영형.pptx \
  --svg outputs/기관-운영형.svg \
  --json outputs/기관.json \
  --preview-dir outputs/기관-preview
```

### 법제처 OPEN API에서 기준일 연혁 선택

```bash
node src/cli.mjs from-law \
  --decree "행정안전부와 그 소속기관 직제" \
  --rule "행정안전부와 그 소속기관 직제 시행규칙" \
  --date 2025-11-25 \
  --source-dir work/legal-snapshots/mois \
  --out outputs/행정안전부.pptx \
  --svg outputs/행정안전부.svg \
  --json outputs/행정안전부.json
```

기준일 이전에 시행된 연혁 중 가장 최근 시행본을 직제와 시행규칙별로 선택합니다. 운영 환경에서는 `--oc` 또는 `LAW_API_OC`에 국가법령정보 공동활용 인증값을 지정하세요.

## 과 단위 소관법령 지도 연결

`lawmap.py` 등의 결과로 만든 부서 지도 JSON을 정확한 조직명에 연결할 수 있습니다.

```bash
node src/cli.mjs build \
  --input 직제.txt --input 직제시행규칙.txt \
  --date 2026-07-24 \
  --law-map dept_map.json \
  --law-map-date 2026-07-24 \
  --law-counts --law-appendix \
  --out outputs/소관법령-기구도.pptx
```

`--law-counts`는 조직 상자와 세로 과 상자에 소관법령 수를 표시하고, `--law-appendix`는 부서별 법령 수와 대표 법령을 별도 슬라이드로 추가합니다. 지도 기준일이 기구도 기준일과 다르면 JSON 경고를 남깁니다.

## 텍스트 보강 지시문

법령 문언만으로 운영상 소관이나 기관 유형이 확정되지 않을 때는 입력 텍스트에 선언을 추가할 수 있습니다.

```text
@기관: 산업통상부
@기관장: 장관
@부기관장: 차관
@기준일: 2026-07-24
@관계: 차관 > 감사관 [보좌]
@관계: 산업통상부 > 국가기술표준원 [소속]
@소관: 산업정책관 > 산업정책과ㆍ기업정책과 [공식 조직표 2026-07-24]
```

`@소관`은 법정 설치계선을 삭제하지 않습니다. 운영형 렌더링에서만 확인된 소관 묶음으로 투영됩니다.

## 출력 규칙

| 법적·운영상 의미 | 시각 표현 |
|---|---|
| 기관장·부기관장 | 파란색 기관장 상자, 세로 척추 |
| 보조기관 | 실선 계선 |
| 보좌기관 | 점선 측면 가지 |
| 소속기관 | 초록색 별도 계통 |
| 정책관·국 소관 묶음 | 운영형에서 파란 점선 |
| 일반·연구·지도·전문·임기·별정·특정직 | 복수 보임이면 `(일)`·`(연)`·`(지)`·`(전)`·`(임)`·`(별)`·`(특)` |
| 한시·자율·총액·책임운영 | 상태 표식과 존속기한 |

상단 `기구`·`정원` 집계표의 항목과 인쇄용 글꼴·색상은 별도 디자인 단계에서 교체할 수 있도록 규칙과 데이터 모델을 분리했습니다.

## 구조

```text
src/law-api.mjs       법제처 기준일 연혁 조회
src/parser.mjs        직제·시행규칙 문언 파싱
src/model.mjs         조직 그래프·법적 관계·운영형 투영
src/law-map.mjs       과 단위 소관법령 지도 병합
src/layout.mjs        한 장형·분할형 페이지 계획
src/render-pptx.mjs   편집 가능한 PowerPoint 도형 출력
src/render-svg.mjs    SVG 검토 출력
src/cli.mjs           build/from-law/fetch/inspect 명령
docs/index.html       GitHub Pages 인터랙티브 데모
```

## 검증한 자료

행정안전부·문화체육관광부·공정거래위원회 기구도와 2026년 중앙행정기관 취합본 66개 파일(195면), 별도 정부기구도 범례를 대조했습니다. 상세한 문형 사전과 조직통칙 검증 규칙은 다음 문서에 정리되어 있습니다.

- [직제 문언 → 기구도 작도 규칙집](docs/drafting-rulebook.md)
- [참조 PPT 분석과 법적 조직 모델](docs/reference-and-legal-model.md)

## 현재 한계

- 별표 매트릭스가 필요한 지방관서의 실제 편성은 별표 원문을 확보하기 전까지 추정하지 않습니다.
- 기본 렌더러는 법적 관계와 핵심 표식을 우선하며, 원본 기관별 인쇄 글꼴·상단 집계표의 완전한 복제는 후속 디자인 작업입니다.
- 생성 결과는 조직도 초안과 분석 도구이며 법률 자문이나 인사 발령의 근거가 아닙니다.

## 라이선스

프로젝트의 구체적인 공개 라이선스는 정리 중입니다. 법령 원문과 정부 기구도 원본의 저작권·이용 조건은 각 제공기관의 안내를 따르세요.
