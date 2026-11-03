---
name: korean-gov-orgchart
description: >-
  Turn Korean government organization law text — a ministry's 직제·직제
  시행규칙 or a local government's 「○○시 행정기구 설치 조례」 and its 시행규칙 —
  into an editable 한글(HWPX) vertical organization chart (세로 조직도) and
  before/after reorganization sheets (조직개편 전·후 대비표, 2~4단). Also works
  backwards for local governments: from a 개편안 org chart to the amended
  조례·시행규칙 text, 개정문 and 신구조문대비표 (HWPX), checked by redrawing it. No
  Hangul install needed. Use when the user asks for a 조직도·기구도 from 직제 or
  조례, wants to draw a 조직개편안, needs a HWPX chart they can edit in 한글, or
  has a 개편안 조직도 and needs the 개정조례안.
---

# korean-gov-orgchart

Reads the installation clauses of 직제/설치 조례 ("기획행정국에 기획예산과,
…를 둔다", "시장 밑에 ○○담당관을 둔다", "시에 보건소를 설치한다") and draws the
legal hierarchy. Output is a real HWPX document whose boxes are 한글 글상자 and
whose connectors are 선 objects, so the user edits it directly in 한글.

Everything runs through one script with plain Node ≥18 (no `npm install`):
`scripts/orgchart.mjs` (`--help` lists the commands). Run it from the user's
working folder with the script's full path; all file arguments and `--out` are
relative to the current working directory.

## Workflow

1. **Get the law text as files.** Ask the user to paste the full text, or copy
   it from 국가법령정보센터(law.go.kr) / 자치법규정보시스템(elis.go.kr) — 본문 전체,
   including article headings like `제5조(기획행정국에 두는 과)`. Save it as UTF-8
   `.txt` (files the user already has can be used as they are). Pass the 직제·조례
   with `--decree` and the 시행규칙 with `--rule`. Both are needed for a complete
   chart — the 조례 installs 국·과, the 시행규칙 adds 담당관 보좌 관계, 직급 and
   직속기관 하부 과. The script prints which file it read as which (`inputs`) —
   check it. See `references/inputs.md`.

2. **Draw the vertical chart.**

   ```bash
   node <skill>/scripts/orgchart.mjs outline \
     --decree "군산시 행정기구 설치 조례.txt" \
     --rule "군산시 행정기구 설치 조례 시행규칙.txt" \
     --date 2026-01-23 --out out/
   ```

   Writes `out/<기관>-조직도.hwpx` and `out/preview/NN.svg` (+ `.png` when
   `rsvg-convert` exists). `--date` is the 기준일 printed as "2026. 1. 23. 현재";
   `2026-01-23` and `2026. 1. 23.` both work. Use the date the user names; if
   none, the later 시행일 of the two texts (the date the drawn structure is in
   force). `--input` (twice) also works: a file counts as the rule when its name
   has `시행규칙` or its text opens with "이 규칙은".

3. **Check before handing it over — always.**
   - Open the preview images and read them.
   - Cross-check against the source text: every 국·과·담당관 the text installs
     should appear once, under the right parent, in the text's order. How to
     recount (local government): 국 = names in the "…국을 둔다" article; 과 = the
     names in each "○○국에 …과를 둔다"; 담당관 = names in "시장 밑에 / 부시장 밑에
     …담당관을 둔다"; 직속기관 = what "시에 …를 설치한다" installs in the 직속기관
     chapter (보건소·농업기술센터 — their 지소·센터·상담소 are not counted);
     사업소 = names ending in 사업소. Compare with the count line on page 1
     (e.g. `본청 7국 4담당관 39과 · 직속기관 2 · 사업소 1`). Report any mismatch
     instead of hiding it.
   - `node <skill>/scripts/orgchart.mjs check out/<파일>.hwpx` re-parses the HWPX
     with [rhwp](https://github.com/edwardkim/rhwp) when it is on PATH or in
     `~/.local/bin` (page count, IR round-trip). Without rhwp, rely on the
     preview check above and ask the user to open the file in 한글 once.

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

## Reorganization: 개편안 조직도 → 개정조례안 (local governments)

When the user has the target chart (사진·HWPX·엑셀·메모, even partial) and needs
the amended ordinance:

1. **Current outline.** `node <skill>/scripts/orgchart.mjs tree --decree 조례.txt
   --rule 시행규칙.txt --out 현행.txt` writes the current structure as an indented
   list (2 spaces per level, `[보좌]` 보좌기관, `[소속]` 직속기관·사업소·하부기관).
2. **Write the 개편안 outline.** Copy `현행.txt` to `개편안.txt` and edit it to the
   user's chart: delete lines (폐지), add lines (신설), move lines under another
   parent (이동), reorder siblings (조례 순서), and mark renames as
   `새이름 (← 옛이름)` — without the arrow a rename reads as 폐지 + 신설. Ask the
   user whenever the chart is ambiguous (rename or new unit? which 국? order?).
   Leave parts the chart does not show as they are.
3. **Draft.** `node <skill>/scripts/orgchart.mjs draft --decree 조례.txt --rule
   시행규칙.txt --target 개편안.txt --date <개편 시행 예정일> --out out/`. It edits
   the current texts in place (lists in "…에 A, B를 둔다", new 국 as 제N조의2,
   abolished 국·담당관 as "제N조 삭제", 과장 직급 clauses follow moved 과), parses
   the result again and compares it with the outline. Exit code 2 = mismatch;
   the summary lists each one.
4. **Check and hand over.** Read `out/개정안-검토.md` (개정문, 신구조문대비표,
   to-do list) and the previews. Outputs:
   `<조례> 일부개정조례안.hwpx`, `<시행규칙> 일부개정규칙안.hwpx` (개정문 + 부칙 +
   신구조문대비표 with changed words underlined), `<기관>-개편안-조직도.hwpx`,
   `<기관>-현행-개편안-대비.hwpx`, and the full amended texts in `out/개정후/`.
   Red `[분장사무 작성 필요]`·`[직급 작성 필요]` mark what the chart cannot
   decide: fill them only from what the user tells you, never invent 분장사무 or
   직급. Tell the user the drafts need their 법무 review, that 별표(사무분장) and
   the 정원 조례 are not edited, and that 부칙 says "공포한 날부터 시행한다" unless
   `--effective "2026년 7월 1일부터 시행한다"` is given.

Details: `references/reorganization.md`.

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
- Reverse drafting covers 국·과·담당관·직속기관 하부 과 in the 행정기구 설치 조례
  and its 시행규칙; it needs unique unit names in the outline and does not draft
  분장사무 or 직급.
- The HWPX is written directly (not by 한글). It is verified with rhwp; still ask
  the user to open it in 한글 once and report anything that looks off.
