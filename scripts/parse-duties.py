#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""parse-duties.py — 직제 시행규칙 평문에서 과·담당관별 분장사무를 추출.

"○○과장은 다음 사항을 분장한다." / "○○담당관은 다음 사항을 분장한다." 조문과
뒤따르는 번호 목록을 읽어 부서 단위 duties 카탈로그(JSON)를 만든다.
기구도 JSON(--graph)을 주면 노드명과 대조해 매칭 여부를 함께 기록한다.

사용:
  python3 scripts/parse-duties.py \
      --input "work/legal-snapshots/mois-2026/행정안전부와 그 소속기관 직제 시행규칙-20260721.txt" \
      --graph outputs/행정안전부-2026-기본.json \
      --out work/duties/행정안전부-20260721.json
"""
import argparse, json, os, re, sys

ARTICLE_RE = re.compile(r"^제(\d+(?:의\d+)?)조(?:의\d+)?\s*\(([^)]*)\)")
CLAUSE_RE = re.compile(
    r"^(?:[①-⑳㉑-㉟]|<\d+>|\(\d+\))?\s*(\S+?)(과장|담당관|팀장|센터장|관장|소장|국장|부장|단장|실장|원장)은\s*다음\s*사항을\s*분장한다"
)
ITEM_RE = re.compile(r"^(\d+(?:의\d+)?)\.\s*(.+)$")
SUFFIX_TO_UNIT = {
    "과장": "과", "팀장": "팀", "센터장": "센터", "국장": "국", "부장": "부",
    "단장": "단", "실장": "실", "원장": "원", "관장": "관", "소장": "소",
    # 담당관은 직위명이 곧 부서명
    "담당관": "담당관",
}


def norm(s):
    return re.sub(r"\s+", "", s or "").replace("ㆍ", "·").replace("・", "·")


def unit_name(stem, suffix):
    if suffix == "담당관":
        return stem + "담당관"
    if suffix == "관장":
        # "…기록관장은" → 부서명 "…기록관"
        return stem + "관"
    return stem + SUFFIX_TO_UNIT[suffix]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--graph", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    node_names = set()
    if args.graph:
        g = json.load(open(args.graph, encoding="utf-8"))
        node_names = {norm(n["name"]) for n in g["nodes"]}

    duties = {}  # unit -> {article, articleTitle, duties: [...]}
    current = None
    article = ("", "")
    for raw in open(args.input, encoding="utf-8"):
        line = raw.strip()
        if not line:
            continue
        am = ARTICLE_RE.match(line)
        if am:
            article = (f"제{am.group(1)}조", am.group(2))
            current = None
        cm = CLAUSE_RE.match(line)
        if cm:
            unit = unit_name(cm.group(1), cm.group(2))
            rec = duties.setdefault(unit, {
                "article": article[0], "articleTitle": article[1], "duties": [],
            })
            current = rec
            continue
        im = ITEM_RE.match(line)
        if im and current is not None:
            text = re.sub(r"\s*<[^>]*>\s*$", "", im.group(2)).strip()  # 개정 이력 꼬리 제거
            current["duties"].append(text)
            continue
        # 번호 목록이 아닌 줄(다음 항 등)이 나오면 수집 종료
        if current is not None and re.match(r"^(?:[①-⑳㉑-㉟제]|<\d+>|\(\d+\))", line):
            current = None

    matched = unmatched = 0
    for unit, rec in duties.items():
        ok = norm(unit) in node_names if node_names else None
        rec["matchedNode"] = ok
        if ok:
            matched += 1
        elif node_names:
            unmatched += 1

    out = {
        "meta": {
            "source": os.path.basename(args.input),
            "unitCount": len(duties),
            "dutyCount": sum(len(r["duties"]) for r in duties.values()),
            "matchedNodes": matched,
            "unmatchedNodes": unmatched,
        },
        "byUnit": duties,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"부서 {len(duties)}곳 / 분장사무 {out['meta']['dutyCount']}건 (노드 일치 {matched}, 불일치 {unmatched})", file=sys.stderr)
    if node_names and unmatched:
        bad = [u for u, r in duties.items() if not r["matchedNode"]][:15]
        print("불일치 예:", ", ".join(bad), file=sys.stderr)
    print(f"저장: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
