import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildComparisonVideoPlan,
  comparisonTransition,
  comparisonVideoCapability,
  comparisonVideoFileName,
  revealStateForObject,
  supportedRecordingFormat,
} from "../desktop/ui/comparison-video.js";

const manifest = JSON.parse(readFileSync(
  new URL("../examples/mcst-four-stage-video/assets/mcst-four-stage-chart.native.json", import.meta.url),
  "utf8",
));

test("Windows 앱은 A3 4단 명세를 14초 고정 영상 계획으로 만든다", () => {
  const capability = comparisonVideoCapability(manifest);
  const plan = buildComparisonVideoPlan(manifest);

  assert.equal(capability.supported, true);
  assert.equal(plan.columns, 4);
  assert.equal(plan.width, 1680);
  assert.equal(plan.height, 1188);
  assert.equal(plan.fps, 30);
  assert.equal(plan.stageBuildEnd, 8.8);
  assert.equal(plan.correspondenceStart, 8.9);
  assert.equal(plan.holdStart, 12.4);
  assert.equal(plan.duration, 14);
});

test("Windows 영상 계획은 점선 조각 전체를 1→2, 2→3, 3→4 묶음으로 보존한다", () => {
  const plan = buildComparisonVideoPlan(manifest);
  const correspondence = manifest.objects.filter((object) => [
    "correspondence-link",
    "correspondence-underlay",
    "correspondence-wrap",
  ].includes(object.metadata?.role));
  const transitions = correspondence.map(comparisonTransition);

  assert.equal(transitions.includes(null), false);
  assert.deepEqual([...new Set(transitions)].sort(), [1, 2, 3]);
  for (const object of correspondence) {
    assert.equal(plan.entries.get(object.id)?.transition, comparisonTransition(object));
  }
});

test("네 조직도는 점선보다 먼저 완성되고 점선은 시점 묶음 순서로 나타난다", () => {
  const plan = buildComparisonVideoPlan(manifest);
  const organizations = manifest.objects.filter((object) => object.metadata?.role === "organization-node");
  const wraps = manifest.objects.filter((object) => object.metadata?.role === "correspondence-wrap");
  const transitionOne = manifest.objects.filter((object) => object.metadata?.role === "correspondence-link" && comparisonTransition(object) === 1);
  const transitionTwo = manifest.objects.filter((object) => object.metadata?.role === "correspondence-link" && comparisonTransition(object) === 2);
  const transitionThree = manifest.objects.filter((object) => object.metadata?.role === "correspondence-link" && comparisonTransition(object) === 3);

  assert.ok(organizations.every((object) => revealStateForObject(plan, object, 8.7).alpha > 0.99));
  assert.ok(wraps.every((object) => revealStateForObject(plan, object, 8.7).alpha === 0));
  assert.ok(transitionOne.every((object) => revealStateForObject(plan, object, 10.15).lineProgress > 0.99));
  assert.ok(transitionTwo.every((object) => revealStateForObject(plan, object, 10.15).lineProgress === 0));
  assert.ok(transitionThree.every((object) => revealStateForObject(plan, object, 10.15).lineProgress === 0));
  assert.ok(transitionOne.every((object) => revealStateForObject(plan, object, 13.8).lineProgress === 1));
  assert.ok(transitionTwo.every((object) => revealStateForObject(plan, object, 13.8).lineProgress === 1));
  assert.ok(transitionThree.every((object) => revealStateForObject(plan, object, 13.8).lineProgress === 1));
});

test("Windows WebView2 영상 형식은 H.264 MP4를 우선하고 파일명을 안전하게 만든다", () => {
  class FakeMediaRecorder {
    static isTypeSupported(type) {
      return type === "video/mp4;codecs=avc1.42E01E" || type.startsWith("video/webm");
    }
  }
  const format = supportedRecordingFormat(FakeMediaRecorder);
  assert.equal(format.extension, "mp4");
  assert.match(format.mimeType, /^video\/mp4/);
  assert.equal(comparisonVideoFileName(manifest, format.extension), "문화체육관광부-4단-조직개편-애니메이션.mp4");

  class WebmOnlyMediaRecorder {
    static isTypeSupported(type) {
      return type === "video/webm;codecs=vp8";
    }
  }
  assert.equal(supportedRecordingFormat(WebmOnlyMediaRecorder).extension, "webm");
});
