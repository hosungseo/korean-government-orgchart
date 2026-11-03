import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("데스크톱 화면용 HWPX 직접 작성기는 Node 전용 기능 없이 동작한다", async () => {
  execFileSync(process.execPath, [path.join(root, "scripts", "prepare-desktop-law-engine.mjs")], { stdio: "ignore" });
  const writer = fs.readFileSync(path.join(root, "desktop", "ui", "engine", "render-native-hwpx.mjs"), "utf8");
  assert.doesNotMatch(writer, /from "jszip"|node:|Buffer\./);

  // Load it the way the webview does: window global, no Buffer.
  const script = `
    globalThis.window = globalThis;
    delete globalThis.Buffer;
    const { createNativeHwpxBytes } = await import(${JSON.stringify(path.join(root, "desktop", "ui", "engine", "render-native-hwpx.mjs"))});
    const manifest = { title: "시험", page: { paper: "A4", orientation: "portrait", widthMm: 210, heightMm: 297 },
      objects: [{ id: "a", type: "rect", geometry: { x: 20, y: 20, width: 40, height: 12 }, text: "기획과" }] };
    const bytes = await createNativeHwpxBytes(manifest);
    process.stdout.write(btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const zip = await JSZip.loadAsync(Buffer.from(out, "base64"));
  assert.equal(await zip.file("mimetype").async("string"), "application/hwp+zip");
  assert.match(await zip.file("Contents/section0.xml").async("string"), /기획과/);
});
