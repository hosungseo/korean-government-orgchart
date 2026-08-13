import test from "node:test";
import assert from "node:assert/strict";
import { buildBrowserChartSvg } from "../docs/hwpx-browser.mjs";

test("브라우저 HWPX도 A4 본문 비율의 전용 300dpi 플레이트를 사용한다", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620" viewBox="0 0 900 620"><rect width="100%" height="100%" fill="#fff"/><text x="450" y="32">시험부</text><text x="450" y="52">가로 버스형</text><path d="M 450 100 V 160"/><rect x="390" y="160" width="120" height="36"/><text x="450" y="183">장관</text></svg>`;
  const plate = buildBrowserChartSvg({
    agency: "시험부",
    asOf: "20260813",
    view: "legal",
    assessment: { level: "ready" },
    svg: source,
  });

  assert.match(plate, /width="756\.84" height="510\.24"/);
  assert.match(plate, /ORGANIZATION ATLAS/);
  assert.match(plate, /2026\. 8\. 13\. 기준 · 법정 설치형/);
  assert.match(plate, /viewBox="0 60 900 560"/);
  assert.match(plate, /스냅샷 기준일 일치/);
  assert.equal((plate.match(/>시험부</g) || []).length, 1, "원본 SVG 제목은 제거되어야 한다");
  assert.doesNotMatch(plate, /가로 버스형/);
});
