# Local-government charts

## How the 조례 is read

| 조례 문형 | 그림 |
|---|---|
| 시의 행정사무를 분장하기 위하여 기획행정국, …국을 둔다 | 부시장 밑 국 |
| 기획행정국에 기획예산과, …과를 둔다 | 국 밑 과 (적힌 순서) |
| 시장 밑에 A담당관, 부시장 밑에 B담당관, C담당관을 둔다 | A는 시장, B·C는 부시장 밑 보좌기관(점선) |
| 시에 보건소를, 읍ㆍ면에 보건지소를 설치한다 | 보건소=직속기관, 보건지소=그 하부 기관 |
| 보건소장 밑에 보건행정과, …를 둔다 | 보건소 밑 과 |
| 농업기술센터 소장을 보좌하고 … 위하여 농업정책과, …를 둔다 | 농업기술센터 밑 과 |
| 센터의 소관사무를 분장하기 위하여 농민상담소를 둘 수 있다 | 농업기술센터 하부 기관 |
| 제4장 사업소 … 차량등록사업소 소장이 관장하는 사무 | 사업소 |

The government level is detected from the institution name (…시/군/구/도) plus
조례 wording; heads become 시장·부시장, 군수·부군수, 구청장·부구청장,
도지사·행정부지사.

## Page layout (A4 세로)

1. 본청 기구 — 시장 → 기관장 직속 보좌기관 → 부시장 → 부시장 보좌기관 → 국.
   Right-aligned count line ("본청 7국 4담당관 39과 · 직속기관 2 · 사업소 1")
   and a legend.
2. 본청 국별 하부조직 (n/m) — 국 groups, never split across pages, rows balanced
   across pages (e.g. 15·18·13 instead of 20·20·6); the header names the 국 range.
3. 직속기관·사업소 — each agency with its 과, then its 지소·센터·상담소 (white
   boxes, regular weight).

Header: "<기관> 조직도" 15pt, page title 11pt, "YYYY. M. D. 현재".
Footer: "근거: 「…」, 「…」" and "n / N".

## Worked example: 군산시 (조례 2025. 11. 17., 시행규칙 2026. 1. 23.)

`examples/gunsan/` holds both texts. Expected result:

- 시장 → 새만금정책담당관(보좌) / 부시장 → 감사·인구대응·디지털정보담당관(보좌), 7국
- 본청 39과: 기획행정국 7 · 안전건설국 6 · 경제산업국 4 · 문화관광국 6 ·
  교통항만수산국 5 · 복지교육국 6 · 기후환경국 5
- 보건소 4과 + 건강생활지원센터·보건지소·보건진료소, 농업기술센터 5과 + 농민상담소,
  차량등록사업소
- 5 pages; count line "본청 7국 4담당관 39과 · 직속기관 2 · 사업소 1"

Run it to confirm the skill works:

```bash
node scripts/orgchart.mjs outline \
  --input "examples/gunsan/군산시 행정기구 설치 조례.txt" \
  --input "examples/gunsan/군산시 행정기구 설치 조례 시행규칙.txt" \
  --date 2026-01-23 --out /tmp/gunsan
```
