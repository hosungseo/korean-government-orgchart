# 개편안 조직도 → 개정조례안

## Outline format

```text
군산시
  시장
    부시장
      감사담당관 [보좌]
      디지털혁신담당관 [보좌] (← 디지털정보담당관)
      청년정책담당관 [보좌]
      기획행정국
        기획예산과
      미래산업국
        신성장산업과
        이차전지산업과
    새만금정책담당관 [보좌]
  보건소 [소속]
    식품위생과 (← 위생과)
    보건지소 [소속]
```

- One unit per line, 2 spaces per level; the first line is the institution.
- `[보좌]` 보좌기관 (dashed), `[소속]` 직속기관·사업소·하부기관; no tag = line unit.
  Names ending in 담당관 are 보좌 even without the tag.
- `새이름 (← 옛이름)` renames (`(<- 옛이름)`, `(구 옛이름)` also work). Without it a
  changed name is read as 폐지 + 신설.
- Sibling order = 조례 order. Names must be unique.

## What `draft` edits

| 개편 | 조례 | 시행규칙 |
|---|---|---|
| 명칭 변경 | every mention (조 제목·과장 포함) | same |
| 과 신설·폐지·이동, 순서 | the "○○국에 A, B를 둔다" list | 과장 직급 clause leaves the old 국 article and joins the new one with the same 직급 (new 과 → `[직급 작성 필요]`) |
| 국 신설 | 제3조 list + new "제N조의2(○○국에 두는 과)" with `[분장사무 작성 필요]` | new 제N절의2 + 직급 article |
| 국 폐지 | 제3조 list + "제N조 삭제" | "제N조 삭제", 절 → "제N절 삭제" |
| 담당관 신설·폐지 | "시장 밑에 …, 부시장 밑에 …" | new 담당관 article with placeholders / "제N조 삭제" |
| 직속기관 하부 과 | — | "보건소장 밑에 …를 둔다" list + 직급 clause |

Then it parses the amended texts with the same engine and compares every unit's
parent and sibling order with the outline (`verification`).

## 개정문 style

Generated sentences follow 일부개정 drafting: `제5조제1항 중 “회계과, 세무과”를
“세무과”로 한다.`, `제7조의2를 다음과 같이 신설한다.`, `제2장에 제4절의2(제9조의2)를
다음과 같이 신설한다.`, `제11조를 삭제한다.`; heavy changes become `제N조를 다음과
같이 한다.` Quoted text is widened until it occurs once in the 항, and 조사
(을/를, 으로/로) follow the final syllable, digits read as numbers.

It is a draft for the 조직·법무 담당 to review — check especially 부칙(시행일·경과조치),
별표 1 사무분장 (HWP attachment, not edited), the 정원 조례, and the wording of
new 분장사무.
