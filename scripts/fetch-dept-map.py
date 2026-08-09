#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch-dept-map.py — 법제처 DRF 연락부서로 소관법령 지도(dept_map.json) 생성.

특정 부처 소관 현행법령 전체를 lawSearch(org=부처코드)로 나열하고,
각 법령의 기본정보(JO=000100) 연락부서/부서단위를 읽어
'부처 → 부서 → laws' 구조의 dept_map을 만든다. (--law-map 입력 형식)

부서명 문언은 "소속기구 과명-담당범위" 꼴이므로, 기구도 JSON(--graph)의
노드 이름 집합과 대조해 매칭 가능한 키(전체명 → 끝 토큰 → 첫 토큰 순)로 정규화한다.

사용:
  python3 scripts/fetch-dept-map.py --org 1741000 --institution 행정안전부 \
      --graph outputs/행정안전부-2026-기본.json --out work/dept-map/행정안전부-YYYYMMDD.json
"""
import argparse, json, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

BASE = "https://www.law.go.kr/DRF"
UA = {"User-Agent": "Mozilla/5.0 (orgchart-dept-map)"}


def fetch(url, retries=3, timeout=60):
    for i in range(retries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode("utf-8", "replace")
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def tx(el, tag):
    x = el.find(tag)
    return (x.text or "").strip() if x is not None and x.text else ""


def norm(s):
    return re.sub(r"\s+", "", s or "").replace("ㆍ", "·").replace("・", "·")


def list_laws(oc, org):
    laws, page = [], 1
    while True:
        root = ET.fromstring(fetch(f"{BASE}/lawSearch.do?" + urllib.parse.urlencode(
            {"OC": oc, "target": "law", "type": "XML", "display": "100", "page": str(page), "org": org})))
        total = int(tx(root, "totalCnt") or 0)
        rows = root.findall("law")
        for r in rows:
            laws.append({"MST": tx(r, "법령일련번호"), "법령ID": tx(r, "법령ID"),
                         "법령명": tx(r, "법령명한글"), "법종": tx(r, "법령구분명"),
                         "시행일자": tx(r, "시행일자")})
        print(f"\r목록 {len(laws)}/{total}", end="", file=sys.stderr, flush=True)
        if len(laws) >= total or not rows:
            break
        page += 1
        time.sleep(0.1)
    print(file=sys.stderr)
    return laws


def resolve_key(full_name, node_names):
    """부서명 문언을 기구도 노드명으로 정규화. 매칭 우선순위: 전체명 → 끝 토큰 → 첫 토큰."""
    tokens = full_name.split()
    candidates = [full_name]
    if tokens:
        candidates += [tokens[-1], tokens[0]]
    for c in candidates:
        if norm(c) in node_names:
            return c, (full_name if c != full_name else None)
    return full_name, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--oc", default="test")
    ap.add_argument("--org", required=True, help="소관부처코드 (행정안전부=1741000)")
    ap.add_argument("--institution", required=True)
    ap.add_argument("--graph", default=None, help="기구도 JSON (노드명 정규화 대조용)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    node_names = set()
    if args.graph:
        g = json.load(open(args.graph, encoding="utf-8"))
        node_names = {norm(n["name"]) for n in g["nodes"]}

    laws = list_laws(args.oc, args.org)
    dept_map = {}
    inst = dept_map.setdefault(args.institution, {})
    misses = 0
    for i, law in enumerate(laws, 1):
        try:
            root = ET.fromstring(fetch(f"{BASE}/lawService.do?" + urllib.parse.urlencode(
                {"OC": args.oc, "target": "law", "MST": law["MST"], "type": "XML", "JO": "000100"})))
        except Exception:
            misses += 1
            continue
        for du in root.findall(".//기본정보//연락부서/부서단위"):
            if tx(du, "소관부처코드") != args.org:
                continue
            nm = tx(du, "부서명")
            base_nm, note = (nm.split("-", 1) + [""])[:2] if "-" in nm else (nm, "")
            key, prefix = resolve_key(base_nm.strip(), node_names)
            rec = inst.setdefault(key, {"부서키": du.get("부서키"), "부서연락처": tx(du, "부서연락처"), "laws": []})
            entry = {"법령ID": law["법령ID"], "법령명": law["법령명"], "법종": law["법종"], "시행일자": law["시행일자"]}
            scope_parts = [p for p in [prefix, norm(note) if note else None] if p]
            if scope_parts:
                entry["담당범위"] = " / ".join(scope_parts)
            if entry not in rec["laws"]:
                rec["laws"].append(entry)
        if i % 25 == 0:
            print(f"\r연락부서 {i}/{len(laws)}", end="", file=sys.stderr, flush=True)
        time.sleep(0.08)
    print(file=sys.stderr)

    matched = sum(1 for k in inst if norm(k) in node_names) if node_names else None
    meta_note = f"부서 {len(inst)}곳(기구도 노드 일치 {matched}곳), 법령 {len(laws)}건, 조회 실패 {misses}건"
    print(meta_note, file=sys.stderr)
    json.dump(dept_map, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"저장: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
