<p align="center">
  <img src="assets/readme/orgchart-hero.svg" alt="법령의 문장을 정부 조직의 지도로" width="100%" />
</p>

<p align="center">
  <a href="https://hosungseo.github.io/korean-government-orgchart/"><strong>라이브 데모</strong></a>
  &nbsp;·&nbsp;
  <a href="#빠른-시작"><strong>빠른 시작</strong></a>
  &nbsp;·&nbsp;
  <a href="#무엇을-다르게-읽나"><strong>모델 보기</strong></a>
</p>

> **법령에 적힌 조직 설치 문언을 읽어, 편집 가능한 기구도(PPTX)·검토용 SVG·분석용 JSON으로 만듭니다.**
>
> 조직도는 직함의 목록이 아니라, 행정의 의사결정이 어디서 보좌되고 어떤 계선을 통해 집행되는지를 읽는 지도입니다.

## 이 도구가 만드는 것

| 입력 | 해석 | 결과 |
| --- | --- | --- |
| 직제·시행규칙 원문 또는 법제처 기준일 연혁 | 설치 문형, 기관 유형, 소관관계, 보직·한시 표식 | **PPTX**(편집) · **SVG**(검토·웹) · **JSON**(재사용) |

```text
“장관 소속으로 A를 둔다”        → 소속기관
“X에 A·B를 둔다”               → 보조기관(법정 계선)
“D는 Y를 보좌한다”              → 보좌기관(참모)
“정책관 내 다른 과의 주관·소관” → 운영상 소관(별도 투영)
```

<p align="center">
  <a href="outputs/행정안전부-20251125.svg">행정안전부 예시</a>
  &nbsp;·&nbsp;
  <a href="outputs/산업통상부-20260724-운영형.svg">산업통상부 운영형 예시</a>
  &nbsp;·&nbsp;
  <a href="outputs/행정안전부-20251125-소관법령.svg">소관법령 결합 예시</a>
</p>

## 무엇을 다르게 읽나

법령의 조직 설치관계와 실제 업무의 소관관계를 하나의 선으로 섞으면, “누가 법적으로 설치됐는가”와 “누가 실무를 맡는가”를 동시에 잃게 됩니다. 이 프로젝트는 두 층을 분리해 보존합니다.

| 보기 | 보여주는 것 | 표현 |
| --- | --- | --- |
| `legal` | 법령상 설치관계 | 보조기관 실선, 보좌기관 점선, 소속기관 별도 계통 |
| `operational` | 출처가 확인된 정책관·국의 업무 소관 | 법정 그래프는 유지하고, 운영상 묶음만 점선으로 덧그림 |

원래 법정 그래프와 검증 메타데이터는 JSON에 그대로 남습니다. 따라서 발표용 그림을 만들면서 근거관계가 사라지지 않습니다.

## 빠른 시작

```bash
git clone https://github.com/hosungseo/korean-government-orgchart.git
cd korean-government-orgchart
npm test
npm run demo
```

샘플은 `examples/sample-law.txt`를 읽어 아래 파일을 만듭니다.

```text
outputs/sample-orgchart.pptx  # 편집 가능한 PowerPoint
outputs/sample-orgchart.svg   # 검토·웹 삽입용 SVG
outputs/sample-orgchart.json  # 노드·관계·법적 메타데이터
```

### 기준일의 법령에서 만들기

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

기준일 이전에 시행된 연혁 가운데 가장 최근 시행본을 직제와 시행규칙별로 선택합니다. 운영 환경에서는 `--oc` 또는 `LAW_API_OC`에 국가법령정보 공동활용 인증값을 지정하세요.

### 확인된 운영상 소관을 보강하기

법령 문언만으로 확정할 수 없는 운영상 관계는 추정하지 않고, 출처가 있는 선언으로만 덧붙입니다.

```text
@기관: 산업통상부
@기관장: 장관
@부기관장: 차관
@기준일: 2026-07-24
@관계: 차관 > 감사관 [보좌]
@관계: 산업통상부 > 국가기술표준원 [소속]
@소관: 산업정책관 > 산업정책과ㆍ기업정책과 [공식 조직표 2026-07-24]
```

```bash
node src/cli.mjs build \
  --input 직제.txt --input 직제시행규칙.txt \
  --date 2026-07-24 --view operational \
  --out outputs/기관-운영형.pptx \
  --svg outputs/기관-운영형.svg \
  --json outputs/기관.json
```

## 읽을 수 있는 신호

| 의미 | 시각 표현 |
| --- | --- |
| 기관장·부기관장 | 파란 기관장 상자와 세로 척추 |
| 보조기관 | 실선 계선 |
| 보좌기관 | 점선 측면 가지 |
| 소속·책임운영기관 | 초록 별도 계통 |
| 정책관·국 소관 묶음 | 운영형의 파란 점선 |
| 복수 보임 | `(일)`·`(연)`·`(지)`·`(전)`·`(임)`·`(별)`·`(특)` 표식 |
| 한시·자율·총액·책임운영 | 상태 표식과 존속기한 |

### 과 단위 소관법령 지도 결합

부서별 법령 수·대표 법령도 조직 노드에 연결할 수 있습니다. 기준일이 다르면 JSON 경고를 남깁니다.

```bash
node src/cli.mjs build \
  --input 직제.txt --input 직제시행규칙.txt \
  --date 2026-07-24 \
  --law-map dept_map.json --law-map-date 2026-07-24 \
  --law-counts --law-appendix \
  --out outputs/소관법령-기구도.pptx
```

### A4에 맞춘 여러 작도 유형

검토서에서 반복되는 세로 척추형·가로 버스형·반쪽 면 조직도에 맞춰 출력 용지와 작도 방향을 선택할 수 있습니다.

```bash
# 한 장짜리 A4 세로 조직도
node src/cli.mjs build --input 직제.txt --paper a4-portrait --layout vertical \
  --out outputs/기관-a4.pptx --svg outputs/기관-a4.svg

# A4 세로의 한 쪽 폭만 사용하는 조직도(두 개를 2-up 조판할 때 유용)
node src/cli.mjs build --input 직제.txt --paper a4-half --layout vertical \
  --focus 산업정책실 \
  --out outputs/기관-반쪽.pptx --svg outputs/기관-반쪽.svg

# 가로 검토서형
node src/cli.mjs build --input 직제.txt --paper a4-landscape --layout horizontal \
  --out outputs/기관-가로.pptx
```

신설·폐지·명칭변경·이체를 검토서처럼 표시하려면 입력에 다음 지시문을 덧붙입니다.

```text
@변경: 신설과 = 신설
@변경: 기존과 = 이체
```

HWPX 취합본에서 확인한 유형과 대표 표본은 [HWPX 취합본 분석](docs/hwpx-corpus-analysis.md)에 정리했습니다.

## 근거와 한계

행정안전부·문화체육관광부·공정거래위원회 기구도, 2026년 중앙행정기관 취합본 66개 파일(195면), 정부기구도 범례를 대조했습니다.

- [직제 문언 → 기구도 작도 규칙집](docs/drafting-rulebook.md)
- [참조 PPT 분석과 법적 조직 모델](docs/reference-and-legal-model.md)

별표 매트릭스가 필요한 지방관서의 실제 편성은 원문 확보 전까지 추정하지 않습니다. 생성 결과는 조직도 초안과 분석 도구이며, 법률 자문·인사 발령의 근거가 아닙니다.

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

## 라이선스

공개 라이선스는 정리 중입니다. 법령 원문과 정부 기구도 원본의 저작권·이용 조건은 각 제공기관의 안내를 따릅니다.
