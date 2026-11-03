import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(root, "skills", "korean-gov-orgchart");

test("스킬 번들이 src와 같다(scripts/prepare-skill.mjs 재실행 필요 여부)", () => {
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "prepare-skill.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("스킬만으로 군산시 예시를 세로 조직도 HWPX로 만든다", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "orgchart-skill-"));
  try {
    const run = spawnSync(process.execPath, [
      path.join(skill, "scripts", "orgchart.mjs"),
      "outline",
      "--input", path.join(skill, "examples", "gunsan", "군산시 행정기구 설치 조례.txt"),
      "--input", path.join(skill, "examples", "gunsan", "군산시 행정기구 설치 조례 시행규칙.txt"),
      "--date", "2026-01-23",
      "--out", out,
    ], { encoding: "utf8", cwd: os.tmpdir() });
    assert.equal(run.status, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.institution, "군산시");
    assert.equal(summary.pageCount, 5);
    assert.ok(readFileSync(summary.hwpx).length > 10_000);
    const firstPreview = readFileSync(path.join(out, "preview", "01.svg"), "utf8");
    assert.ok(firstPreview.includes("본청 7국 4담당관 39과 · 직속기관 2 · 사업소 1"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
