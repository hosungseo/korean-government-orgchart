# Windows 한글 편집형 HWPX 앱

이 앱은 조직도를 그림 한 장으로 넣지 않습니다. 작도 명세의 각 항목을 Windows에 설치된 한컴오피스 한글 Automation으로 전달하여 다음 개별 객체를 생성합니다.

- 조직 상자: 한글 사각형·글상자 객체
- 조직명: 각 글상자 안의 편집 가능한 문자
- 계선: 각각 독립된 한글 선 객체
- 평가대상 표식: 독립된 점선 사각형 객체

내장 샘플은 행정안전부 `인공지능정부실`과 `참여혁신조직실`을 A4 세로 왼쪽면에 배치합니다. 0.4부터는 앱의 **직제·시행규칙 붙여넣기** 창에서 두 법령 원문을 바로 입력해 조직도 명세를 만들 수 있습니다. 작도 범위에 `인공지능정부실, 참여혁신조직실`처럼 여러 조직을 지정하면 한 장에 묶고, 비워두면 전체 구조를 개요·본부 하부조직·소속기관으로 자동 분할합니다. 0.3의 `*.native.json` 선택·드래그앤드롭 방식도 유지됩니다.

문언 파서는 설치본에 함께 들어가므로 실행 PC에 Node.js가 필요하지 않으며, 입력 원문은 외부로 전송하거나 HWPX에 통째로 넣지 않습니다. 직제 본문은 실·국·소속기관을, 시행규칙은 과·담당관·팀을 보강하므로 정확한 과 단위 조직도에는 두 원문을 함께 넣는 것이 원칙입니다.

불러온 명세는 한글을 열기 전에 다음 항목을 검사합니다.

- A4 세로 또는 A3 가로 경계와 여백. 2단 대비는 A4, 3단 이상은 A3 가로로 한글에 생성합니다.
- 객체 ID 중복과 지원 객체 유형
- 한글 Automation이 처리할 수 있는 색상·글꼴·정렬·좌표
- 명세의 예상 객체 수와 실제 객체 수
- `childId`가 있는 계선이 자식 상자 경계에 맞물리는지

오류가 있으면 생성을 막고, 끊긴 접합이나 대각선처럼 확인이 필요한 항목은 경고로 표시합니다. 저장한 HWPX를 Automation으로 다시 열어 `A4 1쪽`과 `네이티브 객체 수 일치`를 확인한 경우에만 앱 화면에 검증 통과를 표시합니다.

## 요구 환경

- Windows 10/11
- 한컴오피스 한글(Automation의 `HWPFrame.HwpObject`가 등록된 버전)
- 한컴 개발자센터에서 제공하는 파일 접근 보안모듈(Automation) 설치·등록
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

1. 행안부 두 실 내장 명세와 브라우저용 직제 파서 준비
2. Tauri 앱 실행
3. 직제·시행규칙 문언 붙여넣기 또는 외부 `*.native.json` 불러오기
4. 조직 추출, A4 자동 분할, 계선–상자 접합 사전검사
5. 한글 Automation 설치 확인
6. 사용자가 생성 버튼을 누르면 현재 미리보기 쪽의 네이티브 HWPX 생성·재열기 검증

산출물은 기본적으로 `%USERPROFILE%\Documents\직제기구도`에 저장됩니다. 같은 파일명이 있으면 기존 파일을 덮지 않고 시각값을 붙여 새 파일로 저장합니다. 재현과 감사에 필요한 파일도 같은 이름으로 함께 남깁니다.

- `이름.hwpx`: 한글 편집형 조직도
- `이름.native.json`: 실제 생성에 사용한 작도 명세
- `이름.verification.json`: 사전검사와 한글 재열기 결과

## Windows 설치본 빌드

```powershell
npm ci
npm ci --prefix desktop
npm run desktop:build
```

NSIS 설치본(`*.exe`)은 `desktop/src-tauri/target/release/bundle/nsis` 아래에 생성됩니다. GitHub Actions의 `Build Windows native HWPX studio` 워크플로도 같은 빌드를 수행합니다.

## 한글 없는 환경에서 가능한 검증

작도 명세의 스키마·객체 수·중복 ID·A4/A3 용지 경계는 Node 테스트로 검사합니다.

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

한글의 파일 접근 보안모듈이 등록되지 않은 PC에서는 생성 버튼을 비활성화하고, 명령을 직접 호출해도 즉시 중단합니다. 저장 승인창을 우회하지 않으며, [한컴 Automation 안내](https://developer.hancom.com/hwpautomation)에서 공식 보안모듈을 내려받아 설치·등록한 뒤 사용해야 합니다.

한글 Automation은 개인·비상업 용도로 자유롭게 이용할 수 있지만, 상업용 솔루션이나 응용프로그램에 사용하려면 한컴의 별도 승인이 필요합니다. 배포 전 [한컴 Automation 안내](https://developer.hancom.com/hwpautomation)를 확인해야 합니다.
