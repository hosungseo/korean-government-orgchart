# 온AI 실험실 · 공공 GitLab · 개인 GitLab 연결 정리

이 문서는 **조직도 레포가 어디에 있고**, **온AI(AI 정부 실험실)과 어떻게 연결되는지**를 혼동 없이 정리한다.

## 1. 지금 이 Mac에 연결된 것

| 구분 | 호스트 | 계정 | 상태 |
| --- | --- | --- | --- |
| 개인 GitLab (SaaS) | `gitlab.com` | `hosung.seo2026` | `glab` + keyring 인증됨 |
| 개인 GitHub | `github.com` | `hosungseo` | `gh` + keyring 인증됨 |
| **공공 GitLab (온AI 산출물)** | **`gitlab.aigov.go.kr`** | **`hosung.seo`** (행정안전부 서호성) | CLI 별도 로그인 필요 |

즉 **로컬 `glab` 기본값은 gitlab.com 개인 계정**이다.  
**온AI 실험실**·**공공 GitLab**과 자동 SSO로 한 줄에 묶여 있지는 **않다**.

이미 공공 GitLab에 올라간 본인 프로젝트 예:

- https://gitlab.aigov.go.kr/hosung.seo/korea100_MOIS

## 2. 정책상 구조 (행안부 보도 기준)

행정안전부 「AI 정부 실험실」 시범운영 안내의 흐름은 대략 다음과 같다.

```text
아이디어 구상
    │
    ▼
온AI / AI 정부 실험실
  (AI 코딩 환경, 시제품 개발·검증)
    │
    ▼
공공 개발산출물 저장소 (공공 GitLab = gitlab.aigov.go.kr)
  (과제문서 · 소스 · 프롬프트 등록·공유)
    │
    ▼
타 기관 활용 · 개선 요청 · 확산
```

- **온AI 실험실**: 공무원이 AI로 업무 도구를 **만들고 검증**하는 환경.
- **공공 GitLab** (`gitlab.aigov.go.kr`): 만든 산출물을 **등록·공유**하는 공공 개발산출물 저장소.

| 질문 | 답 |
| --- | --- |
| 내 gitlab.com 계정이 곧 공공 GitLab인가? | **아님.** 호스트·계정이 다름 (`hosung.seo2026` vs `hosung.seo`). |
| 온AI에서 만든 코드가 자동으로 gitlab.com에 가나? | **기본적으로 안 감.** 등록이 별 단계. |
| 조직도 레포 공공 등록 경로 | `hosung.seo/korean-government-orgchart` (권장) |

## 3. 이 레포의 위치

| 위치 | URL |
| --- | --- |
| GitHub (원본 개발) | https://github.com/hosungseo/korean-government-orgchart |
| GitLab.com (미러) | https://gitlab.com/hosung.seo2026/korean-government-orgchart |
| 라이브 데모 | https://hosungseo.github.io/korean-government-orgchart/ |
| **공공 GitLab** | https://gitlab.aigov.go.kr/hosung.seo/korean-government-orgchart |

동일 서버 참고 과제(타 사용자): [온AI 조직도 만들기](https://gitlab.aigov.go.kr/wavelen/onai-orgchart-plugin)

## 4. 온AI 실험실까지 연계하는 실무 절차

### A. 실험실에서 쓰기 (개발·검증)

1. 온AI / AI 정부 실험실 이용 신청·로그인.
2. 이 레포를 실험실 작업 공간으로 가져오기  
   - `git clone https://gitlab.aigov.go.kr/hosung.seo/korean-government-orgchart.git`  
   - 또는 공개 GitHub/GitLab.com URL  
   - 또는 ZIP 업로드
3. 직제 원문 → PPTX/SVG/JSON 파이프라인 검증.

### B. 공공 GitLab에 등록 (공유·확산)

1. https://gitlab.aigov.go.kr 로그인 (`hosung.seo`)
2. 신규 프로젝트 생성 또는 **Import**  
   - `https://github.com/hosungseo/korean-government-orgchart.git`  
   - 또는 `https://gitlab.com/hosung.seo2026/korean-government-orgchart.git`
3. 등록 메타 권장값:
   - 경로: `hosung.seo/korean-government-orgchart`
   - 이름: 행정기관 직제 조직도 변환기
   - 설명: 직제·시행규칙 문언 → PPTX · SVG · JSON
   - 태그: `조직도`, `직제`, `AX`, `공픈클로`
4. README의 빠른 시작·입출력 예시·면책을 등록 화면에 인용.
5. 데모 URL과 `outputs/` 예시 링크 포함.

### C. CLI 동기화 (이 Mac)

```bash
# Personal Access Token: api + write_repository
glab auth login --hostname gitlab.aigov.go.kr --git-protocol https --api-protocol https

cd /path/to/korean-government-orgchart
git remote add aigov https://gitlab.aigov.go.kr/hosung.seo/korean-government-orgchart.git
# 또는 이미 remote 있으면
git remote set-url aigov https://gitlab.aigov.go.kr/hosung.seo/korean-government-orgchart.git

git push -u aigov main
```

토큰 발급: https://gitlab.aigov.go.kr/-/user_settings/personal_access_tokens  
스코프: `api`, `write_repository` (또는 `read_api` + `write_repository`)

## 5. 체크리스트

- [x] 공개 복제본: GitHub + GitLab.com
- [x] README·데모·예시 산출물
- [x] 공공 GitLab 호스트 확정: `gitlab.aigov.go.kr`
- [x] 공공 네임스페이스 확정: `hosung.seo`
- [ ] 공공 GitLab 프로젝트 push/import 완료
- [ ] 온AI 실험실 작업공간에 clone/import

```text
공공 GitLab URL: https://gitlab.aigov.go.kr/hosung.seo/korean-government-orgchart
온AI 실험실 과제/워크스페이스 ID:
등록일:
```

## 6. 한 줄 결론

**연결은 자동 SSO가 아니라 「실험실에서 개발·검증 → 공공 GitLab(`gitlab.aigov.go.kr`) 등록」 단계 작업이다.**  
개인 `gitlab.com` / GitHub 사본은 이미 있고, **`hosung.seo` 계정으로 공공 인스턴스에 push** 해야 온AI 실험실 연계가 완성된다.
