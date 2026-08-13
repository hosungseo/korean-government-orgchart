# Windows 한글 편집형 HWPX 시제품

이 앱은 조직도를 그림 한 장으로 넣지 않습니다. 작도 명세의 각 항목을 Windows에 설치된 한컴오피스 한글 Automation으로 전달하여 다음 개별 객체를 생성합니다.

- 조직 상자: 한글 사각형·글상자 객체
- 조직명: 각 글상자 안의 편집 가능한 문자
- 계선: 각각 독립된 한글 선 객체
- 평가대상 표식: 독립된 점선 사각형 객체

첫 시제품은 행정안전부 `인공지능정부실`과 `참여혁신조직실`을 A4 세로 왼쪽면에 배치합니다. 저장한 HWPX를 Automation으로 다시 열어 `A4 1쪽`과 `네이티브 객체 수 일치`를 확인한 경우에만 앱 화면에 검증 통과를 표시합니다.

## 요구 환경

- Windows 10/11
- 한컴오피스 한글(Automation의 `HWPFrame.HwpObject`가 등록된 버전)
- WebView2 Runtime(Tauri 설치본에 부트스트래퍼 포함)

Node.js나 Python은 설치본 실행 시 필요하지 않습니다. 개발·빌드할 때만 Node.js와 Rust가 필요합니다.

## 개발 실행

Windows에서 저장소 루트를 기준으로 실행합니다.

```powershell
npm ci
npm ci --prefix desktop
npm run desktop:dev
```

`desktop:dev`는 다음 작업을 순서대로 수행합니다.

1. `src/hwp-native-manifest.mjs`에서 행안부 두 실 작도 명세 생성
2. Tauri 앱 실행
3. 한글 Automation 설치 확인
4. 사용자가 생성 버튼을 누르면 네이티브 HWPX 생성·재열기 검증

산출물은 기본적으로 `%USERPROFILE%\Documents\직제기구도`에 저장됩니다. 같은 파일명이 있으면 기존 파일을 덮지 않고 시각값을 붙여 새 파일로 저장합니다.

## Windows 설치본 빌드

```powershell
npm ci
npm ci --prefix desktop
npm run desktop:build
```

NSIS와 MSI 산출물은 `desktop/src-tauri/target/release/bundle` 아래에 생성됩니다. GitHub Actions의 `Build Windows native HWPX prototype` 워크플로도 같은 빌드를 수행합니다.

## 한글 없는 환경에서 가능한 검증

작도 명세의 스키마·객체 수·중복 ID·A4 경계는 Node 테스트로 검사합니다.

```powershell
npm test
node scripts/build-mois-ai-participation-native-manifest.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/src-tauri/resources/hwp-native.ps1 `
  -Mode ValidateManifest `
  -ManifestPath desktop/src-tauri/resources/mois-ai-participation-left.native.json
```

개별 객체가 실제 한글에서 편집되는지와 A4 1쪽으로 저장되는지는 한글이 설치된 Windows에서만 최종 확인할 수 있습니다.

한글이 설치된 Windows 개발 PC에서는 다음 한 줄로 실제 생성·재열기 검증을 바로 실행할 수 있습니다.

```powershell
npm run --prefix desktop verify:windows
```

검증을 통과하면 `A4 1쪽 · 네이티브 객체 86개`가 표시되고 생성 파일이 한글에서 열립니다.

## 보안·라이선스

한글의 파일 접근 보안모듈이 등록되지 않은 PC에서는 첫 저장 때 한글의 접근 승인창이 나타날 수 있습니다. 앱은 이를 우회하지 않습니다.

한글 Automation은 개인·비상업 용도로 자유롭게 이용할 수 있지만, 상업용 솔루션이나 응용프로그램에 사용하려면 한컴의 별도 승인이 필요합니다. 배포 전 [한컴 Automation 안내](https://developer.hancom.com/hwpautomation)를 확인해야 합니다.
