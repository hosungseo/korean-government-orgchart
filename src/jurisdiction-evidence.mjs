const EVIDENCE_LABELS = {
  "direct-installation": "직접 설치 문형",
  "explicit-duty-clause": "분장사무 명시",
  "duty-item-range": "직제 호 번호 범위 대조",
  "duty-text-crosswalk": "직제 호 범위·과 분장사무 문언 대조",
  "duty-text-order-run": "문언 anchor·과 조문 순서 대조",
  "ordered-anchor-run": "보좌기관 순서 기반 보강",
  declared: "사용자 확인 지시문",
};

export function jurisdictionEvidenceLabel(value) {
  if (!value) return "";
  return EVIDENCE_LABELS[value] || value;
}
