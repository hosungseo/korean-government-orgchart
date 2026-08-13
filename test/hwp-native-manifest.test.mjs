import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMoisAiParticipationNativeManifest,
  HWP_NATIVE_MANIFEST_SCHEMA,
  validateNativeManifest,
} from "../src/hwp-native-manifest.mjs";

test("행안부 두 실을 A4 세로 네이티브 객체 명세로 만든다", () => {
  const manifest = buildMoisAiParticipationNativeManifest();

  assert.equal(manifest.schema, HWP_NATIVE_MANIFEST_SCHEMA);
  assert.equal(manifest.page.paper, "A4");
  assert.equal(manifest.page.orientation, "portrait");
  assert.equal(manifest.page.widthMm, 210);
  assert.equal(manifest.page.heightMm, 297);
  assert.equal(manifest.verification.expectedPageCount, 1);
  assert.ok(manifest.verification.expectedNativeObjectCount > 70);
  assert.equal(validateNativeManifest(manifest), manifest);
});

test("조직명·상자·선은 한 장의 그림이 아니라 개별 객체다", () => {
  const manifest = buildMoisAiParticipationNativeManifest();
  const lines = manifest.objects.filter((object) => object.type === "line");
  const textboxes = manifest.objects.filter((object) => object.type === "textbox");
  const rectangles = manifest.objects.filter((object) => object.type === "rectangle");

  assert.equal(lines.length, manifest.verification.expectedLineObjectCount);
  assert.equal(textboxes.length, manifest.verification.expectedTextBoxObjectCount);
  assert.equal(rectangles.length, manifest.verification.expectedRectangleObjectCount);
  assert.equal(textboxes.length, manifest.verification.expectedEditableTextObjectCount);
  assert.ok(textboxes.some((object) => object.text.includes("인공지능정부실")));
  assert.ok(textboxes.some((object) => object.text.includes("참여혁신조직실")));
  assert.ok(lines.some((object) => object.metadata.role === "page-trunk"));
});

test("모든 네이티브 객체 ID와 좌표가 안정적이다", () => {
  const manifest = buildMoisAiParticipationNativeManifest();
  const ids = manifest.objects.map((object) => object.id);

  assert.equal(new Set(ids).size, ids.length);
  for (const object of manifest.objects) {
    for (const value of Object.values(object.geometry)) assert.ok(Number.isFinite(value));
  }
});

test("계선 끝은 자식 상자 경계 안쪽에 겹쳐 접속한다", () => {
  const manifest = buildMoisAiParticipationNativeManifest();
  const byId = new Map(manifest.objects.map((object) => [object.id, object]));
  const childLinks = manifest.objects.filter((object) => object.type === "line" && object.metadata.childId);

  for (const line of childLinks) {
    const child = byId.get(line.metadata.childId);
    assert.ok(child, `${line.id}의 자식 상자가 있어야 합니다.`);
    assert.ok(line.geometry.x2 > child.geometry.x, `${line.id}는 상자 경계 안쪽까지 들어가야 합니다.`);
    assert.ok(line.geometry.x2 < child.geometry.x + 1, `${line.id}의 겹침은 1mm 미만이어야 합니다.`);
  }
});

test("중복 객체 ID를 검증 단계에서 거부한다", () => {
  const manifest = buildMoisAiParticipationNativeManifest();
  manifest.objects[1].id = manifest.objects[0].id;
  assert.throws(() => validateNativeManifest(manifest), /중복/);
});
