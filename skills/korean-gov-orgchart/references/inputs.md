# Getting the law text

## What to collect

| 기관 | 첫째 파일 (직제·조례) | 둘째 파일 (시행규칙) |
|---|---|---|
| 중앙부처 | 「○○부와 그 소속기관 직제」 (대통령령) | 「○○부와 그 소속기관 직제 시행규칙」 (부령) |
| 시·군·구·도 | 「○○시 행정기구 설치 조례」 | 「○○시 행정기구 설치 조례 시행규칙」 |

Both are needed. The 조례 installs 국 and 과; the 시행규칙 states which 담당관
assists the 시장 or 부시장, the 직급, and the 과 of 직속기관 (보건소장 밑에 …과).

## Where to copy from

- 자치법규: 자치법규정보시스템 <https://www.elis.go.kr> or 국가법령정보센터
  <https://www.law.go.kr> → 자치법규 → search "군산시 행정기구 설치 조례" → 본문.
- 법령: <https://www.law.go.kr> → 법령명 검색 → 본문.

Copy the whole body including chapter/section lines (`제3장 직속기관`,
`제2절 농업기술센터`) — the parser uses them to tell 직속기관·사업소 apart from 본청.
별표 are HWP attachments; they are not needed for the chart.

## File naming

Save as UTF-8 `.txt`. Any name containing `시행규칙` is treated as the rule; the
other file as the 직제/조례. Example:

```
군산시 행정기구 설치 조례.txt
군산시 행정기구 설치 조례 시행규칙.txt
```

## Through the Open API (when network and a key are available)

국가법령정보센터 OPEN API needs the user's own OC key (never use a shared one):

```
https://www.law.go.kr/DRF/lawSearch.do?OC=<OC>&target=ordin&type=XML&query=군산시 행정기구 설치
https://www.law.go.kr/DRF/lawService.do?OC=<OC>&target=ordin&type=XML&MST=<자치법규일련번호>
```

The body is in `<조내용>` CDATA blocks, one per article; join them with newlines.
