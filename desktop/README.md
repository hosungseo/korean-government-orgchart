# Windows 데스크톱 앱

`desktop/`은 기존 조직도 엔진을 Tauri 2 + WebView2 앱으로 감싼 포장입니다. 화면은 정적 HTML이고, 실제 법령 파싱·레이아웃·PPTX 생성은 `orgchart-core` sidecar가 담당합니다. 따라서 설치된 Windows에 Node.js나 Python을 별도로 요구하지 않습니다.

## Windows 설치본 만들기

GitHub Actions의 **Build Windows desktop app**을 수동 실행하거나 `desktop-v*` 태그를 push하면 NSIS 설치파일과 MSI가 artifact로 올라옵니다. 수동 실행에서 `offline=true`를 선택하면 WebView2 오프라인 설치파일을 포함합니다. 설치파일은 약 127MB 커지지만 WebView2가 없는 PC에서도 설치 중 인터넷이 필요하지 않습니다. Windows 10/11 이미지에 WebView2가 이미 관리·배포되어 있으면 `offline=false`의 작은 패키지를 사용할 수 있습니다.

워크플로가 하는 일은 다음과 같습니다.

1. Bun으로 `src/cli.mjs`를 Windows 단일 실행파일로 컴파일합니다.
2. `orgchart-core-x86_64-pc-windows-msvc.exe`를 Tauri sidecar로 묶습니다.
3. Tauri가 WebView2 화면과 sidecar를 NSIS/MSI로 패키징합니다.

현재 저장소에서 로컬로 확인할 수 있는 명령은 다음과 같습니다.

```bash
# macOS/Linux에서 core 컴파일 흐름 점검
node desktop/build-core.mjs bun-darwin-arm64 aarch64-apple-darwin

# Tauri Rust 설정 점검
cargo check --manifest-path desktop/src-tauri/Cargo.toml

# Windows에서 개발 화면 실행
npm run desktop:dev

# 폐쇄망 배포용 Windows 빌드(Windows에서 실행)
npm run --prefix desktop build:offline
```

개발 모드에서 sidecar가 없으면 화면은 열리지만 생성 버튼은 실행파일이 없다는 안내를 보여줍니다. Windows 패키지 빌드에서는 workflow가 sidecar를 먼저 만들기 때문에 정상적으로 생성됩니다.

## 화면 입력

- **직제 문언**: 대통령령과 직제 시행규칙을 각각 붙여넣거나 `.txt/.md` 파일로 불러옵니다.
- **법제처 API**: 인터넷 또는 기관 내부 프록시가 허용된 환경에서 기관명·기준일로 기준일 법령을 가져옵니다. OC 인증값은 입력하거나 sidecar 환경변수 `LAW_API_OC`로 제공합니다.
- **조직도 JSON**: 이미 검토를 마친 `outputs/*.json`을 다시 다른 용지·레이아웃으로 그립니다.
- **용지·유형**: A4 반쪽, A4 세로·가로, 슬라이드 및 세로·가로·2열·매트릭스·카드·소속기관 띠 유형을 선택합니다.
- **산출물**: SVG, 검토 HTML, JSON, 선택 시 PPTX를 화면에서 바로 저장합니다.

직제와 시행규칙은 법적 설치관계와 하위 과·관 명명을 분리한 입력입니다. 앱이 원문을 임의로 보정하지 않으므로, 생성 후에는 JSON의 경고·검증·소속기관 단계도 함께 확인하는 것을 전제로 합니다.

## 폐쇄망 운영 절차

가장 안전한 방식은 인터넷이 가능한 수집 PC에서 법제처 기준일 원문과 별표를 미리 내려받아 `--source-dir`에 보관하는 것입니다. 별표까지 포함한 법적 그래프를 그대로 보존하려면 그 PC에서 `from-law --json 기관.json`을 먼저 실행하고, 생성된 조직도 JSON을 승인된 반입 매체로 폐쇄망에 전달해 데스크톱의 **조직도 JSON** 모드로 여십시오. 단순 텍스트 검토는 직제·시행규칙 `.txt`만 반입해도 됩니다. 폐쇄망 데스크톱은 직제 문언 또는 JSON 모드만 사용하므로 생성 시 외부 URL을 호출하지 않습니다. API 모드는 내부 프록시나 법제처 API 미러가 실제로 접근 가능한 경우에만 사용합니다.
