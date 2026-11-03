import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * hwp-native.ps1 의 Generate 제어 흐름을 가짜 한글로 검증한다(test/hwp-native-generate.sim.ps1).
 * PowerShell 이 없는 환경(맥 기본)에서는 건너뛴다. HWP_PWSH 로 실행 파일을 지정할 수 있다.
 */
const SIM = fileURLToPath(new URL("./hwp-native-generate.sim.ps1", import.meta.url));

function findPowershell() {
  // Windows 에서는 앱이 실제로 쓰는 Windows PowerShell 5.1 을 먼저 고른다.
  const order = process.platform === "win32" ? ["powershell", "pwsh"] : ["pwsh", "powershell"];
  const candidates = [process.env.HWP_PWSH, ...order].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PWSH = findPowershell();
if (!PWSH && process.env.CI) {
  throw new Error("CI 에서는 PowerShell(pwsh 또는 powershell)이 있어야 한글 작도 시뮬레이션이 실행됩니다.");
}

function simulate(args) {
  const run = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SIM, ...args], { encoding: "utf8", timeout: 120_000 });
  assert.equal(run.status, 0, `시뮬레이션 실행 실패: ${run.stderr}`);
  const line = run.stdout.trim().split("\n").at(-1);
  return JSON.parse(line);
}

const maybe = PWSH ? test : (name, fn) => test.skip(`${name} (PowerShell 없음 — HWP_PWSH 로 지정 가능)`, fn);

maybe("크래시 없이 575객체를 150개 청크로 그리면 세션 4개 + 검증 1회로 끝나고 순서는 선→사각형→글상자다", () => {
  const r = simulate(["-ObjectCount", "575", "-ChunkSize", "150"]);
  assert.equal(r.failure, null);
  assert.equal(r.output.verified, true);
  assert.equal(r.output.sessions, 4);
  assert.equal(r.output.recoveries, 0);
  assert.equal(r.sessions, 5, "작도 세션 4 + 검증 재열기 1");
  assert.equal(r.releases, 5, "세션마다 한글을 완전히 내린다(체크포인트 rename 전) + 검증 1");
  assert.equal(r.outputObjects, 575);
  assert.equal(r.createdOrder.length, 575);
  const kinds = r.createdOrder.map((id) => Number(id.slice(1)) % 3); // 1=line, 2=rect, 0=textbox
  const firstRect = kinds.indexOf(2);
  const firstText = kinds.indexOf(0);
  assert.ok(kinds.slice(0, firstRect).every((k) => k === 1), "선이 먼저");
  assert.ok(kinds.slice(firstRect, firstText).every((k) => k === 2), "사각형이 다음");
  assert.ok(kinds.slice(firstText).every((k) => k === 0), "글상자가 마지막");
  assert.ok(!r.leftovers.some((name) => name.includes("checkpoint")), "체크포인트 임시 파일이 남지 않는다");
  assert.equal(r.progress.phase, "done");
});

maybe("두 번째 세션 중간(200번째)에서 한글이 죽으면 마지막 체크포인트(150)부터 청크를 줄여 이어 그리고 검증까지 통과한다", () => {
  const r = simulate(["-ObjectCount", "575", "-ChunkSize", "150", "-CrashAt", "200", "-CrashTimes", "1"]);
  assert.equal(r.failure, null);
  assert.equal(r.output.verified, true);
  assert.equal(r.output.recoveries, 1);
  assert.equal(r.output.chunkSize, 75);
  assert.equal(r.outputObjects, 575);
  // 150까지 저장 → 151~199 그리다 200에서 죽음 → 151부터 다시: 151~199 는 두 번 만들어지지만 문서에는 한 번만 남는다
  assert.equal(r.createdOrder.length, 575 + 49);
  assert.ok(r.logTail.some((line) => line.includes("verified=True")));
});

maybe("첫 체크포인트 전에 죽어도 새 문서부터 다시 시작한다", () => {
  const r = simulate(["-ObjectCount", "60", "-ChunkSize", "150", "-CrashAt", "1", "-CrashTimes", "1"]);
  assert.equal(r.failure, null);
  assert.equal(r.output.verified, true);
  assert.equal(r.output.recoveries, 1);
  assert.equal(r.outputObjects, 60);
});

maybe("같은 자리에서 재개 한도(3회)를 넘겨 죽으면 위치를 밝히며 실패하고 부분 파일을 남기지 않는다", () => {
  const r = simulate(["-ObjectCount", "300", "-ChunkSize", "100", "-CrashAt", "120", "-CrashTimes", "4", "-MaxRecoveries", "3"]);
  assert.ok(r.failure, "실패해야 한다");
  // 작도 순서는 선→사각형→글상자라 120번째는 사각형 20번째(o59)다 — 실제 죽은 객체를 그대로 밝힌다.
  assert.match(r.failure, /객체 120\/300 \(o59, rectangle/, "실제로 죽은 객체 번호와 ID 를 밝힌다");
  assert.match(r.failure, /3회 연속 응답을 끊었습니다/);
  assert.match(r.failure, /부분 저장본\(100개/);
  assert.equal(r.output, null);
  assert.equal(r.outputExists, false);
  assert.ok(r.leftovers.includes("checkpoint.hwpx"), "실패해도 부분 저장본은 남긴다");
  assert.ok(!r.leftovers.some((name) => name.endsWith(".saving.hwpx")), "쓰다 만 임시본은 지운다");
  assert.equal(r.progress.phase, "failed");
  assert.equal(r.progress.recoveries, 3);
  assert.equal(r.progress.failedIndex, 120);
  assert.equal(r.progress.failedId, "o59");
  assert.equal(r.progress.failedType, "rectangle");
  assert.equal(r.progress.checkpointObjects, 100);
  assert.equal(r.progress.disconnected, true);
});

maybe("서로 다른 자리에서 네 번 끊겨도 자리마다 진전이 있으면 계속 재개해 완주한다", () => {
  const r = simulate(["-ObjectCount", "575", "-ChunkSize", "150", "-CrashAt", "120,260,380,470", "-CrashTimes", "1", "-MaxRecoveries", "3"]);
  assert.equal(r.failure, null);
  assert.equal(r.output.verified, true);
  assert.equal(r.output.recoveries, 4);
  assert.equal(r.outputObjects, 575);
});

maybe("한글 메모리가 한도를 넘으면 청크를 기다리지 않고 조기 체크포인트로 프로세스를 갈아 끼운다", () => {
  const r = simulate(["-ObjectCount", "100", "-ChunkSize", "150", "-MemorySpikeAt", "40"]);
  assert.equal(r.failure, null);
  assert.equal(r.output.verified, true);
  assert.equal(r.outputObjects, 100);
  assert.ok(r.output.earlyCheckpoints >= 1, `earlyCheckpoints=${r.output.earlyCheckpoints}`);
  assert.ok(r.output.sessions > 1, "세션이 나뉘어야 한다");
  assert.equal(r.output.recoveries, 0);
});

maybe("한글이 끊긴 것이 아닌 오류(예: 객체 생성 실패)는 재개 없이 즉시 실패한다", () => {
  const r = simulate(["-ObjectCount", "40", "-ChunkSize", "150", "-CrashAt", "5", "-CrashTimes", "1", "-PlainError"]);
  assert.ok(r.failure);
  assert.match(r.failure, /객체 5\/40 \(o13, line/);
  assert.doesNotMatch(r.failure, /재개/);
  assert.equal(r.sessions, 1);
  assert.equal(r.releases, 1, "살아 있는 한글은 강제 종료가 아니라 정상 Quit 으로 내린다");
});
