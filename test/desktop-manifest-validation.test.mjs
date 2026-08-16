import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeNativeManifest } from "../desktop/ui/manifest-validation.js";
import { buildMoisAiParticipationNativeManifest } from "../src/hwp-native-manifest.mjs";

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
