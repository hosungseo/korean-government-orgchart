import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeNativeManifest } from "../desktop/ui/manifest-validation.js";
import { buildMoisAiParticipationNativeManifest } from "../src/hwp-native-manifest.mjs";
import { buildNativeComparisonWorkflow } from "../src/native-law-workflow.mjs";

test("Windows 앱 사전검사는 A3 가로 3단 대비 명세를 통과시킨다", () => {
  const workflow = buildNativeComparisonWorkflow({
    stages: [
      {
        decreeText: `시험행정부와 그 소속기관 직제\n제4조(하부조직) 시험행정부에 디지털정부실을 둔다.\n제5조(디지털정부실) 디지털정부실에 인공지능정책국을 둔다.`,
        ruleText: `시험행정부와 그 소속기관 직제 시행규칙\n제3조(디지털정부실) 인공지능정책국에 인공지능정책과를 둔다.`,
        asOf: "2025-10-01",
      },
      {
        decreeText: `시험행정부와 그 소속기관 직제\n제4조(하부조직) 시험행정부에 인공지능정부실을 둔다.\n제5조(인공지능정부실) 인공지능정부실에 인공지능정책국을 둔다.`,
        ruleText: `시험행정부와 그 소속기관 직제 시행규칙\n제3조(인공지능정부실) 인공지능정책국에 인공지능정책과를 둔다.`,
        asOf: "2025-11-25",
      },
      {
        decreeText: `시험행정부와 그 소속기관 직제\n제4조(하부조직) 시험행정부에 인공지능정부실을 둔다.\n제5조(인공지능정부실) 인공지능정부실에 인공지능정책국을 둔다.`,
        ruleText: `시험행정부와 그 소속기관 직제 시행규칙\n제3조(인공지능정부실) 인공지능정책국에 인공지능정책과ㆍ법사조직과를 둔다.`,
        asOf: "2026-07-21",
      },
    ],
    focus: "디지털정부실, 인공지능정부실",
    onePage: true,
  });
  const report = analyzeNativeManifest(workflow.manifests[0]);
  assert.equal(workflow.summary.paper, "A3");
  assert.equal(report.valid, true);
  assert.equal(report.errors.length, 0);
});

test("Windows 앱 사전검사는 정상 네이티브 명세의 객체와 계선 접합을 집계한다", () => {
  const manifest = buildMoisAiParticipationNativeManifest();
  const report = analyzeNativeManifest(manifest);

  assert.equal(report.valid, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.summary.objectCount, manifest.objects.length);
  assert.equal(report.summary.lineCount, manifest.verification.expectedLineObjectCount);
  assert.equal(report.summary.textBoxCount, manifest.verification.expectedTextBoxObjectCount);
  assert.ok(report.summary.connectionChecks > 20);
  assert.equal(report.summary.connectionWarnings, 0);
});

test("Windows 앱 사전검사는 A4 밖 상자와 검증 객체 수 불일치를 거부한다", () => {
  const manifest = structuredClone(buildMoisAiParticipationNativeManifest());
  const textbox = manifest.objects.find((object) => object.type === "textbox");
  textbox.geometry.x = 209;
  textbox.geometry.width = 10;
  manifest.verification.expectedNativeObjectCount += 1;

  const report = analyzeNativeManifest(manifest);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "box-out-of-page"));
  assert.ok(report.errors.some((item) => item.code === "verification-mismatch"));
});

test("Windows 앱 사전검사는 자식 상자에 맞물리지 않은 계선을 경고한다", () => {
  const manifest = structuredClone(buildMoisAiParticipationNativeManifest());
  const line = manifest.objects.find((object) => object.type === "line" && object.metadata?.childId);
  line.geometry.x2 -= 8;

  const report = analyzeNativeManifest(manifest);
  assert.equal(report.valid, true);
  assert.equal(report.summary.connectionWarnings, 1);
  assert.ok(report.warnings.some((item) => item.code === "unsnapped-child" && item.objectId === line.id));
});

test("Windows 앱 사전검사는 한글 Automation에서 처리할 수 없는 서식을 거부한다", () => {
  const manifest = structuredClone(buildMoisAiParticipationNativeManifest());
  const textbox = manifest.objects.find((object) => object.type === "textbox");
  textbox.style.textColor = "rgb(0, 0, 0)";
  textbox.style.fontSizePt = 0;

  const report = analyzeNativeManifest(manifest);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "invalid-text-color"));
  assert.ok(report.errors.some((item) => item.code === "invalid-font-size"));
});

test("한글 Automation 스크립트는 Windows PowerShell 5.1용 UTF-8 BOM을 유지한다", () => {
  const script = readFileSync(new URL("../desktop/src-tauri/resources/hwp-native.ps1", import.meta.url));
  assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("Windows 실기 검증 스크립트는 PowerShell 5.1용 UTF-8 BOM을 유지한다", () => {
  const script = readFileSync(new URL("../desktop/verify-windows.ps1", import.meta.url));
  assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("쪽 설정은 한글 버전 간 호환되는 HSet 파라미터 API를 사용한다", () => {
  const script = readFileSync(
    new URL("../desktop/src-tauri/resources/hwp-native.ps1", import.meta.url),
    "utf8",
  );
  assert.match(script, /HSet\.SetItem\("ApplyClass", 24\)/);
  assert.match(script, /HSet\.SetItem\("ApplyTo", 3\)/);
  assert.match(script, /HSet\.SetItem\("ShapeCreationMode", 0\)/);
  assert.match(script, /HSet\.SetItem\("FlowWithText", 0\)/);
  assert.match(script, /TextWrapType\("BehindText"\)/);
  assert.doesNotMatch(script, /TextWrapType\("TopAndBottom"\)/);
  assert.match(script, /HSet\.SetItem\("ShapeCreationType", 0\)/);
  assert.match(script, /HSet\.SetItem\("ShapeCreationType", 1\)/);
  assert.match(script, /CreatePt\.Item\(0\)\s*=/);
  assert.doesNotMatch(script, /\$section\.Apply(?:Class|To)\s*=/);
  assert.doesNotMatch(script, /\$shape\.ShapeCreation(?:Mode|Type)\s*=/i);
  assert.doesNotMatch(script, /\$points\s*=\s*\$layout\.CreateItemArray/);
  assert.match(script, /A3 가로/);
  assert.match(script, /\$pageWidth - 420/);
});

test("한글 작도는 청크 체크포인트·프로세스 재기동·크래시 재개 구조를 가진다", () => {
  const script = readFileSync(
    new URL("../desktop/src-tauri/resources/hwp-native.ps1", import.meta.url),
    "utf8",
  );
  // 앱(lib.rs)이 넘기는 인자와 스크립트 파라미터가 맞아야 한다.
  for (const name of ["ChunkSize", "ProgressPath", "PidPath", "MaxRecoveries"]) {
    assert.match(script, new RegExp(`\\$${name}\\b`), `${name} 파라미터`);
  }
  // 세션마다 임시 경로에 lock:false 로 저장하고, 한글을 완전히 내린 뒤(파일 잠금 해제) 체크포인트로 바꾼다.
  assert.match(script, /SaveAs\(\$Path, "HWPX", "lock:false;"\)/);
  const releaseIndex = script.indexOf("Release-HwpObject $script:Hwp\n                $script:Hwp = $null\n                $holder = $null\n                [GC]::Collect()\n                Move-FileAtomic $saving $checkpoint");
  assert.ok(releaseIndex > 0, "Release(Quit+프로세스 종료) → rename 순서");
  assert.match(script, /function Move-FileAtomic/);
  assert.match(script, /\[IO\.File\]::Replace\(\$Source, \$Destination, \[NullString\]::Value\)/);
  assert.match(script, /function Stop-HwpProcess/);
  assert.match(script, /Stop-Process -Id \$pidValue -Force/);
  // 재개는 체크포인트를 다시 열어 기존 앵커 뒤(문단 끝)에서 이어 그린다.
  assert.match(script, /Open\(\$CheckpointPath, "", "lock:false;forceopen:true;versionwarning:false;"\)/);
  assert.match(script, /HAction\.Run\("MoveDocEnd"\)/);
  assert.doesNotMatch(script, /HAction\.Run\("MoveDocBegin"\)/);
  // 실패 지점은 실제 객체 번호·ID·유형으로 보고하고, 부분 저장본은 남긴다.
  assert.match(script, /failedIndex = \$current \+ 1/);
  assert.match(script, /if \(\$succeeded\) \{ try \{ if \(Test-Path -LiteralPath \$checkpoint\)/);
  // 재개 한도는 '같은 자리 연속'(streak)과 '전체 총량'을 분리한다.
  assert.match(script, /if \(\$streak -ge \$MaxRecoveries\)/);
  assert.match(script, /if \(\$recoveries -ge \$MaxTotalRecoveries\)/);
  // 한글이 죽었을 때만(RPC 단절·프로세스 소멸) 청크를 줄여 재개하고, 그 외 오류는 즉시 실패한다.
  assert.match(script, /0x800706BA\|0x800706BE\|0x80010108/);
  assert.match(script, /\[Math\]::Max\(25, \[int\]\[Math\]::Floor\(\$chunk \/ 2\)\)/);
  // z-order: 선 → 사각형 → 글상자 순서를 하나의 배열로 유지한다.
  const order = ["\"line\"", "\"rectangle\"", "\"textbox\""].map((type) =>
    script.indexOf(`$ordered += @($manifest.objects | Where-Object { $_.type -eq ${type} })`),
  );
  assert.ok(order.every((index) => index >= 0) && order[0] < order[1] && order[1] < order[2]);
  // 진행 상태는 앱이 읽는 JSON과 사람이 읽는 로그로 남긴다.
  assert.match(script, /function Write-ProgressState/);
  assert.match(script, /"\$ProgressPath\.log"/);
  // 한컴 자동화 함정 대응: FileNew 금지(보이는 창을 띄움), 창 전부 숨김, 기존 인스턴스 부착 시 중단,
  // Quit 전 Clear(1), 메시지박스 자동응답 확대, 고아 자동화 한글 정리, 메모리 기준 조기 체크포인트.
  assert.doesNotMatch(script, /HAction\.Run\("FileNew"\)/);
  assert.match(script, /\$script:Hwp\.Clear\(1\)/);
  assert.match(script, /function Hide-HwpWindows/);
  assert.match(script, /if \(\$holder\.Attached\)/);
  assert.match(script, /\$Hwp\.Clear\(1\)[\s\S]{0,80}\$Hwp\.Quit\(\)/);
  assert.match(script, /SetMessageBoxMode\(0x00011011\)/);
  assert.match(script, /function Stop-OrphanAutomationHwp/);
  assert.match(script, /CommandLine -match '-Automation'/);
  assert.match(script, /early checkpoint/);
  assert.match(script, /GetWindowThreadProcessId/);
});

test("데스크톱 앱은 객체 수에 비례한 타임아웃과 진행·PID 파일을 한글 작도에 넘긴다", () => {
  const source = readFileSync(new URL("../desktop/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /fn native_generate_timeout_secs\(object_count: usize\) -> u64/);
  assert.match(source, /estimate\.clamp\(DEFAULT_POWERSHELL_TIMEOUT_SECS, 14_400\)/);
  // 정체 감지·취소·종료 훅·이미지명 확인 taskkill
  assert.match(source, /stall_timeout_secs: Some\(NATIVE_STALL_TIMEOUT_SECS\)/);
  assert.match(source, /fn cancel_native_hwpx\(\)/);
  assert.match(source, /tauri::RunEvent::Exit/);
  assert.match(source, /IMAGENAME eq \{image\}/);
  assert.match(source, /kill_process_id\(pid, Some\("Hwp\.exe"\)\)/);
  for (const flag of ["-ChunkSize", "-ProgressPath", "-PidPath"]) {
    assert.match(source, new RegExp(`OsStr::new\\("${flag}"\\)`), flag);
  }
  assert.match(source, /kill_process_from_pid_file\(pid_file\)/);
  assert.match(source, /app_for_progress\.emit\("native-hwpx-progress", state\)/);
  const ui = readFileSync(new URL("../desktop/ui/app.js", import.meta.url), "utf8");
  assert.match(ui, /listenEvent\("native-hwpx-progress"/);
  assert.match(ui, /invoke\("cancel_native_hwpx"\)/);
  const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="cancelButton"/);
});

test("파일 접근 보안모듈이 없으면 한글 생성을 즉시 중단한다", () => {
  const script = readFileSync(
    new URL("../desktop/src-tauri/resources/hwp-native.ps1", import.meta.url),
    "utf8",
  );

  assert.match(script, /if \(-not \$holder\.SecurityModuleRegistered\)/);
  assert.match(script, /파일 접근 보안모듈이 등록되어 있지 않습니다/);
});

test("Windows NSIS 번들은 생성된 ICO 아이콘을 명시적으로 사용한다", () => {
  const config = JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(config.bundle.targets, ["nsis"]);
  assert.ok(config.bundle.icon.includes("icons/icon.ico"));
});
