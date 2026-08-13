export const MOIS_AI_PARTICIPATION_LEFT_SPEC = Object.freeze({
  title: "행정안전부 주요 실 조직도",
  asOf: "2026. 7. 21.",
  footer: "행정안전부 직제·시행규칙 [시행 2026. 7. 21.] · 왼쪽면 실→국→과 법정 설치계선",
  offices: [
    {
      name: "인공지능정부실",
      grade: "고위 가",
      y: 31,
      bureaus: [
        {
          name: "인공지능정부정책국",
          y: 79,
          divisionsY: 105,
          divisions: [
            "인공지능정부정책과",
            "공공인공지능혁신과",
            "공공데이터정책과",
            "공공데이터분석관리과",
            "인공지능정부협력과",
          ],
        },
        {
          name: "인공지능정부서비스국",
          y: 202,
          divisionsY: 228,
          divisions: [
            "공공서비스혁신과",
            "행정정보공유과",
            "국민맞춤서비스과",
            { name: "통합포털정책과", evaluation: true },
          ],
        },
        {
          name: "인공지능정부기반국",
          grade: "고위 나",
          y: 308,
          divisionsY: 334,
          divisions: [
            "디지털보안정책과",
            "디지털인프라혁신과",
            "지역디지털협력과",
          ],
        },
      ],
    },
    {
      name: "참여혁신조직실",
      grade: "고위 가",
      evaluation: true,
      y: 407,
      bureaus: [
        {
          name: "참여혁신국",
          y: 455,
          divisionsY: 481,
          divisions: [
            "혁신기획과",
            "국민참여정책과",
            "행정제도과",
            "민원제도과",
            "정보공개제도과",
          ],
        },
        {
          name: "조직국",
          grade: "고위 나",
          y: 579,
          divisionsY: 605,
          divisions: [
            "조직기획과",
            "조직진단과",
            "경제조직과",
            "사회조직과",
            "안전조직과",
            { name: "법사조직과", evaluation: true },
          ],
        },
      ],
    },
  ],
});
