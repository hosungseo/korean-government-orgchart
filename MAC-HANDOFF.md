# Mac 개발 전달 안내

이 폴더는 `직제 기구도` 프로젝트의 소스 전용 전달본입니다. Windows에서 설치·생성된 의존성 및 결과물은 제외했으며, macOS에서 소스 수정과 Node 기반 테스트를 바로 이어갈 수 있도록 구성했습니다.

## 1. 압축을 푼 뒤 기본 확인

Node.js 22 LTS와 npm을 준비한 뒤 프로젝트 루트에서 실행합니다.

```bash
npm ci
npm test
```

테스트가 통과하면 샘플 산출물을 만들 수 있습니다.

```bash
npm run demo
```

생성 결과는 새 `outputs/` 폴더에 저장됩니다.

## 2. 데스크톱 화면 개발

Tauri 화면까지 수정하려면 Xcode Command Line Tools와 Rust stable도 설치합니다.

```bash
xcode-select --install
rustup default stable
npm ci --prefix desktop
npm run desktop:dev
```

`desktop:dev`는 아이콘과 브라우저용 엔진 파일을 다시 생성한 뒤 개발 앱을 실행합니다.

## 3. macOS에서 가능한 범위

- 직제·시행규칙 문언 파싱
- 조직도 모델 및 레이아웃 수정
- SVG, PPTX, HWPX, HTML, JSON 산출 로직 수정과 테스트
- 법제처 API 조회 및 조직개편 비교 로직 수정
- Tauri UI의 화면과 상호작용 수정

한컴오피스 한글 Automation을 이용해 네이티브 개별 객체를 그리는 기능은 Windows 전용입니다. macOS에서는 그 최종 생성·재열기 검증을 실행할 수 없으므로, 해당 부분의 실기 확인은 다시 Windows PC에서 해야 합니다.

현재 `desktop/src-tauri/tauri.conf.json`도 Windows NSIS 번들을 대상으로 합니다. Mac 설치 앱까지 만들려면 번들 대상을 macOS용으로 분리하고 `icon.icns`를 다시 생성하는 작업이 필요합니다.

## 4. 법제처 API 인증값

인증값은 이 전달본에 포함하지 않았습니다. 터미널 세션에서만 환경변수로 지정하세요.

```bash
export LAW_API_OC="본인의_OC_값"
```

인증값이 든 `.env` 파일은 Git이나 메일 첨부본에 넣지 않는 것을 권장합니다. 데스크톱 화면에서 입력한 OC 값은 조회 요청에만 사용하도록 구현되어 있습니다.

## 5. 주요 경로

- `src/`: 파서, 데이터 모델, 레이아웃, 렌더러, 법제처 API 및 조직개편 비교
- `test/`: Node 테스트
- `desktop/ui/`: 데스크톱 화면
- `desktop/src-tauri/`: Tauri/Rust 셸과 Windows 한글 Automation 연동
- `scripts/`: 데스크톱 준비 및 보조 스크립트
- `examples/`: 샘플 입력
- `README.md`: 전체 CLI 사용법과 기능 설명

## 6. 전달본에서 제외된 항목

- `node_modules/`, `desktop/node_modules/`
- `outputs/`, `test-output/`
- `desktop/src-tauri/target/`
- 자동 생성 아이콘(원본 `source.svg`는 포함)
- 자동 복사되는 `desktop/ui/engine/`
- 자동 생성 네이티브 샘플 명세
- Windows EXE, DLL, 설치파일 및 디버그 파일
- `.env`, 개인키, API 인증값

필요한 파일은 `npm ci`와 `npm run desktop:prepare`가 다시 생성합니다.

## 7. 새 Git 저장소로 시작하려는 경우

이 압축본에는 Git 이력이 없습니다. Mac에서 별도 저장소로 시작하려면 다음과 같이 실행합니다.

```bash
git init
git add .
git commit -m "Import orgchart generator source"
```
