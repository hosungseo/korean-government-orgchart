# Windows 데스크톱 앱

`desktop/`은 기존 조직도 엔진을 가벼운 Tauri 2 + WebView2 앱으로 감싼 포장입니다. 화면은 정적 HTML이고, 실제 법령 파싱·레이아웃·PPTX 생성은 `orgchart-core` sidecar가 담당합니다. 따라서 설치된 Windows에 Node.js나 Python을 별도로 요구하지 않는 구성을 목표로 합니다.

## Windows 설치본 만들기

GitHub Actions의 **Build Windows desktop app**을 수동 실행하거나 `desktop-v*` 태그를 push하면 NSIS 설치파일과 MSI가 artifact로 올라옵니다.

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
```

개발 모드에서 sidecar가 없으면 화면은 열리지만 생성 버튼은 실행파일이 없다는 안내를 보여줍니다. Windows 패키지 빌드에서는 workflow가 sidecar를 먼저 만들기 때문에 정상적으로 생성됩니다.

## 화면 입력

- **직제 문언**: 대통령령과 직제 시행규칙을 각각 붙여넣거나 `.txt/.md` 파일로 불러옵니다.
- **조직도 JSON**: 이미 검토를 마친 `outputs/*.json`을 다시 다른 용지·레이아웃으로 그립니다.
- **용지·유형**: A4 반쪽, A4 세로·가로, 슬라이드 및 세로·가로·2열·매트릭스·카드·소속기관 띠 유형을 선택합니다.
- **산출물**: SVG, 검토 HTML, JSON, 선택 시 PPTX를 화면에서 바로 저장합니다.

직제와 시행규칙은 법적 설치관계와 하위 과·관 명명을 분리한 입력입니다. 앱이 원문을 임의로 보정하지 않으므로, 생성 후에는 JSON의 경고·검증·소속기관 단계도 함께 확인하는 것을 전제로 합니다.
