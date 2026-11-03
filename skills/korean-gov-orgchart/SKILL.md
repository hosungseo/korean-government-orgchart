---
name: korean-gov-orgchart
description: >-
  Turn Korean government organization law text — a ministry's 직제·직제
  시행규칙 or a local government's 「○○시 행정기구 설치 조례」 and its 시행규칙 —
  into an editable 한글(HWPX) vertical organization chart (세로 조직도) and
  before/after reorganization sheets (조직개편 전·후 대비표, 2~4단). No Hangul
  install needed. Use when the user asks for a 조직도·기구도 from 직제 or 조례,
  wants to draw a 조직개편안, or needs a HWPX chart they can edit in 한글.
---

# korean-gov-orgchart

Reads the installation clauses of 직제/설치 조례 ("기획행정국에 기획예산과,
…를 둔다", "시장 밑에 ○○담당관을 둔다", "시에 보건소를 설치한다") and draws the
legal hierarchy. Output is a real HWPX document whose boxes are 한글 글상자 and
whose connectors are 선 objects, so the user edits it directly in 한글.

Everything runs through one script with plain Node ≥18 (no `npm install`):
`scripts/orgchart.mjs`.

## Workflow

1. **Get the law text as files.** Ask the user to paste the full text, or copy
   it from 국가법령정보센터(law.go.kr) / 자치법규정보시스템(elis.go.kr) — 본문 전체,
   including article headings like `제5조(기획행정국에 두는 과)`. Save it as UTF-8
   `.txt`. **File names decide the role**: a name containing `시행규칙` is read as
   the rule; anything else as the 직제/조례. Both files are needed for a complete
   chart — the 조례 installs 국·과, the 시행규칙 adds 담당관 보좌 관계, 직급 and
   직속기관 하부 과. See `references/inputs.md`.

2. **Draw the vertical chart.**

   ```bash
   node scripts/orgchart.mjs outline \
     --input "군산시 행정기구 설치 조례.txt" \
     --input "군산시 행정기구 설치 조례 시행규칙.txt" \
     --date 2026-01-23 --out out/
   ```

   Writes `out/<기관>-조직도.hwpx` and `out/preview/NN.svg` (+ `.png` when
   `rsvg-convert` exists). `--date` is the 기준일 printed as "2026. 1. 23. 현재".

3. **Check before handing it over — always.**
   - Open the preview images and read them.
   - Cross-check against the source text: every 국·과·담당관 the text installs
     should appear once, under the right parent, in the text's order. Page 1 of
     a local-government chart prints a count line such as
     `본청 7국 4담당관 39과 · 직속기관 2 · 사업소 1` — recount from the text and
     compare. Report any mismatch instead of hiding it.
   - `node scripts/orgchart.mjs check out/<파일>.hwpx` re-parses the HWPX with
     rhwp when it is installed (page count, IR round-trip).

4. **Reorganization sheets (optional).** Prepare the 개편안 text the same way
   (amended 조례·시행규칙, or the current text edited to the proposal), then:

   ```bash
   node scripts/orgchart.mjs compare \
     --stage "현행 조례.txt,현행 시행규칙.txt" \
     --stage "개편 조례.txt,개편 시행규칙.txt" \
     --stage-date 2026-01-23 --stage-date 2026-07-01 \
     --label 현행 --label 개편안 --out out/
   ```

   2 stages → A4 세로 좌우 대비, 3~4 stages → A3 가로 다단. 신설·폐지·명칭변경은
   자동 표시.

5. **Hand over** the `.hwpx` path, the preview images, the summary JSON the
   script prints (pages, warnings), and what you checked.

## Fixing a misread

If a unit is missing or drawn under the wrong parent, add directive lines at
the top of either input file and re-run:

```text
@관계: 시장 > 인구대응담당관 [보좌]
@관계: 군산시 > 상수도사업소 [소속]
@관계: 보건소 > 보건행정과
```

`@관계: 상위 > 하위` adds the relation; the chart draws a declared parent in
preference to the one read from the text. `[보좌]` = dashed staff box,
`[소속]` = subordinate agency (use the institution name as the parent), no tag =
line unit. `@기관: 이름` fixes the institution name if it is not detected.
Prefer fixing the input over editing the HWPX when the chart will be
regenerated.

## What the chart follows (local governments)

- 시장·부시장(군수·구청장·도지사) at the top; 기관장 직속 보좌기관 first, then
  the 부기관장 line; 보좌기관 in dashed boxes.
- 국·과 in ordinance order; 직속기관(보건소·농업기술센터)과 사업소 on their own
  page as "직속기관·사업소", with their 과 and 지소·상담소 below them.
- Type by rank: 기관장 12pt bold, 국·소속기관 11pt bold, 과·담당관 10pt regular
  (맑은 고딕), line weights 0.55/0.42/0.3mm so tiers survive grayscale printing.
- Footer: `근거: 「…조례」, 「…시행규칙」` and the page number.

Details and the 군산시 worked example: `references/local-government.md`.

## Limits — say so when relevant

- 읍·면·동 and 의회사무국 are set by separate ordinances and are not drawn.
- Names that exist only in HWP 별표 (보건지소 개소 수, 사업소 명단) are not read;
  a 사업소 appears only if the 조례 text names it.
- The HWPX is written directly (not by 한글). It is verified with rhwp; still ask
  the user to open it in 한글 once and report anything that looks off.
