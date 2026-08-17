export const COMPARISON_VIDEO_SCHEMA = "kr.go.mois.orgchart.comparison-video/v1";

const GLOBAL_ROLES = new Set([
  "document-label",
  "header-rule",
  "footer-rule",
  "comparison-divider",
  "comparison-band",
  "comparison-band-rule",
]);
const ORGANIZATION_ROLES = new Set(["comparison-header", "organization-node"]);
const STRUCTURE_ROLES = new Set(["child-link", "child-trunk"]);
const CHANGE_NODE_ROLES = new Set(["correspondence-wrap", "status-label"]);
const CHANGE_LINE_ROLES = new Set(["correspondence-underlay", "correspondence-link"]);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function smooth(value) {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roleOf(object) {
  return String(object?.metadata?.role || "");
}

function dashNumbers(style = {}) {
  if (typeof style.dashArray === "string" && style.dashArray.trim()) {
    return style.dashArray.trim().split(/[\s,]+/).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  }
  return style.dash === "dash" ? [2.6, 1.4] : [];
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function comparisonColumn(object) {
  const side = String(object?.metadata?.side || "");
  const sideMatch = side.match(/^c([1-4])$/);
  if (sideMatch) return Number(sideMatch[1]);
  const id = String(object?.id || "");
  const nodeMatch = id.match(/^c([1-4])-/);
  if (nodeMatch) return Number(nodeMatch[1]);
  const headerMatch = id.match(/^column-header-([1-4])$/);
  return headerMatch ? Number(headerMatch[1]) : null;
}

export function comparisonTransition(object) {
  const match = String(object?.id || "").match(/^col([1-3])-/);
  return match ? Number(match[1]) : null;
}

export function comparisonVideoCapability(manifest) {
  const page = manifest?.page || {};
  const source = manifest?.source || {};
  const columns = Number(source.columns || source.stageAsOf?.length || 0);
  if (manifest?.schema !== "kr.go.mois.orgchart.hwp-native/v1") {
    return { supported: false, reason: "네이티브 작도 명세만 영상으로 만들 수 있습니다.", columns };
  }
  if (page.paper !== "A3" || page.orientation !== "landscape" || Math.abs(Number(page.widthMm) - 420) > 0.02 || Math.abs(Number(page.heightMm) - 297) > 0.02) {
    return { supported: false, reason: "3~4단 A3 가로 대비표를 먼저 만드세요.", columns };
  }
  if (columns < 3 || columns > 4) {
    return { supported: false, reason: "현재 영상 내보내기는 3단 또는 4단 대비표를 지원합니다.", columns };
  }
  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  if (!objects.some((object) => roleOf(object) === "organization-node")) {
    return { supported: false, reason: "영상으로 그릴 조직도 객체를 찾지 못했습니다.", columns };
  }
  return { supported: true, reason: "A3 고정 비교 영상을 만들 수 있습니다.", columns };
}

function indexedBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key == null) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

export function buildComparisonVideoPlan(manifest, { fps = 30 } = {}) {
  const capability = comparisonVideoCapability(manifest);
  if (!capability.supported) throw new Error(capability.reason);
  const columns = capability.columns;
  const normalizedFps = Math.max(1, Math.min(60, Math.round(Number(fps) || 30)));
  const columnDuration = 2.2;
  const stageBuildEnd = rounded(columns * columnDuration, 2);
  const correspondenceStart = rounded(stageBuildEnd + 0.1, 2);
  const correspondenceLineStart = rounded(stageBuildEnd + 0.35, 2);
  const transitionSpacing = 1.02;
  const holdStart = rounded(stageBuildEnd + 0.54 + (columns - 1) * transitionSpacing, 2);
  const duration = rounded(holdStart + 1.6, 1);
  const objects = manifest.objects.map((object, order) => ({ object, order }));
  const orgGroups = indexedBy(
    objects.filter(({ object }) => ORGANIZATION_ROLES.has(roleOf(object))),
    ({ object }) => comparisonColumn(object),
  );
  const structureGroups = indexedBy(
    objects.filter(({ object }) => STRUCTURE_ROLES.has(roleOf(object))),
    ({ object }) => comparisonColumn(object),
  );
  const changeNodes = objects.filter(({ object }) => CHANGE_NODE_ROLES.has(roleOf(object)));
  const changeUnderlays = indexedBy(
    objects.filter(({ object }) => roleOf(object) === "correspondence-underlay"),
    ({ object }) => comparisonTransition(object),
  );
  const changeLinks = indexedBy(
    objects.filter(({ object }) => roleOf(object) === "correspondence-link"),
    ({ object }) => comparisonTransition(object),
  );
  const entries = new Map();

  for (const { object } of objects) {
    const role = roleOf(object);
    if (GLOBAL_ROLES.has(role) || (!ORGANIZATION_ROLES.has(role) && !STRUCTURE_ROLES.has(role) && !CHANGE_NODE_ROLES.has(role) && !CHANGE_LINE_ROLES.has(role))) {
      entries.set(object.id, { mode: "static", start: 0, duration: 0 });
    }
  }
  for (let column = 1; column <= columns; column += 1) {
    const stageStart = (column - 1) * columnDuration;
    for (const [index, { object }] of (orgGroups.get(column) || []).entries()) {
      entries.set(object.id, { mode: "fade", start: stageStart + 0.1 + index * 0.012, duration: 0.32, column });
    }
    const structure = structureGroups.get(column) || [];
    const solid = structure.filter(({ object }) => dashNumbers(object.style).length === 0);
    const dashed = structure.filter(({ object }) => dashNumbers(object.style).length > 0);
    for (const [index, { object }] of solid.entries()) {
      entries.set(object.id, { mode: "line", start: stageStart + 1 + index * 0.005, duration: 0.5, column });
    }
    for (const [index, { object }] of dashed.entries()) {
      entries.set(object.id, { mode: "line", start: stageStart + 1.1 + index * 0.005, duration: 0.4, column });
    }
  }
  for (const [index, { object }] of changeNodes.entries()) {
    entries.set(object.id, { mode: "fade", start: correspondenceStart + index * 0.008, duration: 0.34, transition: comparisonTransition(object) });
  }
  for (let transition = 1; transition < columns; transition += 1) {
    const groupStart = correspondenceLineStart + (transition - 1) * transitionSpacing;
    for (const [index, { object }] of (changeUnderlays.get(transition) || []).entries()) {
      entries.set(object.id, { mode: "line", start: groupStart + index * 0.006, duration: 0.58, transition });
    }
    for (const [index, { object }] of (changeLinks.get(transition) || []).entries()) {
      entries.set(object.id, { mode: "line", start: groupStart + 0.12 + index * 0.008, duration: 0.66, transition });
    }
  }

  return {
    schema: COMPARISON_VIDEO_SCHEMA,
    manifest,
    objects,
    entries,
    columns,
    fps: normalizedFps,
    frameCount: Math.round(duration * normalizedFps),
    width: 1680,
    height: 1188,
    columnDuration,
    stageBuildEnd,
    correspondenceStart,
    correspondenceLineStart,
    transitionSpacing,
    holdStart,
    duration,
  };
}

export function comparisonFrameTime(plan, frameIndex) {
  const index = Math.max(0, Math.min(plan.frameCount - 1, Math.floor(Number(frameIndex) || 0)));
  return index / plan.fps;
}

export function revealStateForObject(plan, object, seconds) {
  const entry = plan.entries.get(object.id) || { mode: "static", start: 0, duration: 0 };
  if (entry.mode === "static" || entry.duration <= 0) return { alpha: 1, lineProgress: 1, entry };
  const progress = smooth((seconds - entry.start) / entry.duration);
  return {
    alpha: progress,
    lineProgress: entry.mode === "line" ? progress : 1,
    entry,
  };
}

function applyStrokeStyle(context, style, scale) {
  context.strokeStyle = style.stroke || "#000000";
  context.lineWidth = Math.max(0.1, safeNumber(style.strokeWidthMm, 0.2) * scale);
  context.lineCap = "butt";
  context.setLineDash(dashNumbers(style).map((value) => value * scale));
}

function drawRectangle(context, geometry, style, scaleX, scaleY) {
  const x = safeNumber(geometry.x) * scaleX;
  const y = safeNumber(geometry.y) * scaleY;
  const width = safeNumber(geometry.width) * scaleX;
  const height = safeNumber(geometry.height) * scaleY;
  if (style.fill && style.fill !== "none") {
    context.fillStyle = style.fill;
    context.fillRect(x, y, width, height);
  }
  if (style.stroke && style.stroke !== "none" && safeNumber(style.strokeWidthMm) > 0) {
    applyStrokeStyle(context, style, (scaleX + scaleY) / 2);
    context.strokeRect(x, y, width, height);
  }
}

function drawText(context, object, geometry, style, scaleX, scaleY) {
  const padding = safeNumber(style.paddingMm) * scaleX;
  const x = safeNumber(geometry.x) * scaleX;
  const y = safeNumber(geometry.y) * scaleY;
  const width = safeNumber(geometry.width) * scaleX;
  const height = safeNumber(geometry.height) * scaleY;
  const fontPx = Math.max(1, safeNumber(style.fontSizePt, 6) * 0.352778 * scaleY);
  const align = style.align === "right" ? "right" : style.align === "center" ? "center" : "left";
  const textX = align === "right" ? x + width - padding : align === "center" ? x + width / 2 : x + padding;
  const lines = String(object.text ?? "").split(/\r?\n/);
  const lineHeight = fontPx * 1.22;
  const startY = y + height / 2 - ((lines.length - 1) * lineHeight) / 2;
  context.fillStyle = style.textColor || "#202020";
  context.textAlign = align;
  context.textBaseline = "middle";
  context.font = `${style.bold ? 700 : 400} ${fontPx}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
  if ("lang" in context) context.lang = "ko";
  for (const [index, line] of lines.entries()) {
    context.fillText(line, textX, startY + index * lineHeight, Math.max(1, width - padding * 2));
  }
}

function drawObject(context, object, state, scaleX, scaleY) {
  if (state.alpha <= 0.001) return;
  const geometry = object.geometry || {};
  const style = object.style || {};
  context.save();
  context.globalAlpha = state.alpha;
  if (object.type === "line") {
    const x1 = safeNumber(geometry.x1) * scaleX;
    const y1 = safeNumber(geometry.y1) * scaleY;
    const x2 = safeNumber(geometry.x2) * scaleX;
    const y2 = safeNumber(geometry.y2) * scaleY;
    applyStrokeStyle(context, style, (scaleX + scaleY) / 2);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x1 + (x2 - x1) * state.lineProgress, y1 + (y2 - y1) * state.lineProgress);
    context.stroke();
  } else {
    drawRectangle(context, geometry, style, scaleX, scaleY);
    if (object.type === "textbox") drawText(context, object, geometry, style, scaleX, scaleY);
  }
  context.restore();
}

function drawColumnGlow(context, plan, seconds) {
  for (let column = 1; column <= plan.columns; column += 1) {
    const start = (column - 1) * plan.columnDuration + 1.62;
    const progress = clamp01((seconds - start) / 0.58);
    if (progress <= 0 || progress >= 1) continue;
    const left = ((column - 1) / plan.columns) * plan.width;
    const width = plan.width / plan.columns;
    const center = left + width * (-0.1 + progress * 1.2);
    const gradient = context.createLinearGradient(center - width * 0.18, 0, center + width * 0.18, 0);
    gradient.addColorStop(0, "rgba(15,118,110,0)");
    gradient.addColorStop(0.5, `rgba(15,118,110,${Math.sin(progress * Math.PI) * 0.11})`);
    gradient.addColorStop(1, "rgba(15,118,110,0)");
    context.fillStyle = gradient;
    context.fillRect(left, 36 * (plan.height / 297), width, 244 * (plan.height / 297));
  }
}

export function renderComparisonVideoFrame(context, plan, seconds) {
  const time = Math.max(0, Math.min(plan.duration, Number(seconds) || 0));
  const page = plan.manifest.page;
  const scaleX = plan.width / Number(page.widthMm);
  const scaleY = plan.height / Number(page.heightMm);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, plan.width, plan.height);
  for (const { object } of plan.objects) {
    drawObject(context, object, revealStateForObject(plan, object, time), scaleX, scaleY);
  }
  drawColumnGlow(context, plan, time);
  context.restore();
}

export function supportedRecordingFormat(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass || typeof MediaRecorderClass.isTypeSupported !== "function") return null;
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4", label: "H.264 MP4" },
    { mimeType: "video/mp4;codecs=avc3.42E01E", extension: "mp4", label: "H.264 MP4" },
    { mimeType: "video/mp4", extension: "mp4", label: "MP4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm", label: "VP9 WebM" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm", label: "VP8 WebM" },
    { mimeType: "video/webm", extension: "webm", label: "WebM" },
  ];
  return candidates.find((candidate) => MediaRecorderClass.isTypeSupported(candidate.mimeType)) || null;
}

export function comparisonVideoFileName(manifest, extension = "mp4") {
  const institution = String(manifest?.source?.institution || "정부조직").trim() || "정부조직";
  const columns = Number(manifest?.source?.columns || manifest?.source?.stageAsOf?.length || 4);
  return `${institution}-${columns}단-조직개편-애니메이션.${extension}`;
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function abortError() {
  return new DOMException("영상 내보내기를 취소했습니다.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function waitForMilliseconds(milliseconds, signal) {
  throwIfAborted(signal);
  const delay = Math.max(0, Number(milliseconds) || 0);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function nextAnimationFrame(signal) {
  throwIfAborted(signal);
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return waitForMilliseconds(1000 / 60, signal).then(() => performance.now());
  }
  return new Promise((resolve, reject) => {
    let frameRequest = 0;
    const onAbort = () => {
      if (frameRequest) globalThis.cancelAnimationFrame(frameRequest);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    frameRequest = globalThis.requestAnimationFrame((now) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(now);
    });
  });
}

export function createComparisonCaptureStream(canvas, fps = 30) {
  if (!canvas || typeof canvas.captureStream !== "function") {
    throw new Error("이 WebView2에서는 Canvas 영상 녹화를 지원하지 않습니다.");
  }
  let manualStream = null;
  try {
    manualStream = canvas.captureStream(0);
    const manualTrack = manualStream.getVideoTracks()[0];
    if (manualTrack && typeof manualTrack.requestFrame === "function") {
      return {
        stream: manualStream,
        track: manualTrack,
        mode: "manual-request-frame",
        frameRateLocked: true,
      };
    }
  } catch {
    // Older WebView2 builds can reject frameRate 0. The timed stream below is the compatibility path.
  }
  manualStream?.getTracks().forEach((track) => track.stop());
  const stream = canvas.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("Canvas 영상 트랙을 만들지 못했습니다.");
  }
  return {
    stream,
    track,
    mode: "automatic-canvas-stream",
    frameRateLocked: false,
  };
}

function reportFrameProgress(onProgress, plan, format, capture, frameNumber, seconds) {
  onProgress({
    seconds,
    duration: plan.duration,
    ratio: Math.min(1, frameNumber / plan.frameCount),
    frameNumber,
    frameCount: plan.frameCount,
    format,
    plan,
    captureMode: capture.mode,
    frameRateLocked: capture.frameRateLocked,
  });
}

async function pumpManualFrames({ context, plan, capture, format, onProgress, signal, recorderError }) {
  const frameDurationMs = 1000 / plan.fps;
  const startedAt = performance.now();
  let nextDeadline = startedAt;
  for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex += 1) {
    throwIfAborted(signal);
    if (recorderError.current) throw recorderError.current;
    if (frameIndex > 0) {
      nextDeadline += frameDurationMs;
      const now = performance.now();
      if (now - nextDeadline > frameDurationMs) nextDeadline = now;
      await waitForMilliseconds(nextDeadline - now, signal);
    }
    const frameTime = comparisonFrameTime(plan, frameIndex);
    renderComparisonVideoFrame(context, plan, frameTime);
    capture.track.requestFrame();
    reportFrameProgress(onProgress, plan, format, capture, frameIndex + 1, (frameIndex + 1) / plan.fps);
  }
  const remainingMs = startedAt + plan.duration * 1000 - performance.now();
  await waitForMilliseconds(remainingMs, signal);
  return (performance.now() - startedAt) / 1000;
}

async function pumpAutomaticFrames({ context, plan, capture, format, onProgress, signal, recorderError }) {
  const startedAt = performance.now();
  let reportedFrame = 0;
  while (true) {
    const now = await nextAnimationFrame(signal);
    if (recorderError.current) throw recorderError.current;
    const elapsed = Math.min(plan.duration, (now - startedAt) / 1000);
    renderComparisonVideoFrame(context, plan, elapsed);
    const frameNumber = Math.min(plan.frameCount, Math.max(reportedFrame, Math.round(elapsed * plan.fps)));
    reportedFrame = frameNumber;
    reportFrameProgress(onProgress, plan, format, capture, frameNumber, elapsed);
    if (elapsed >= plan.duration) return (performance.now() - startedAt) / 1000;
  }
}

export async function recordComparisonVideo(manifest, {
  canvas,
  onProgress = () => {},
  signal,
  videoBitsPerSecond = 7_000_000,
} = {}) {
  throwIfAborted(signal);
  const format = supportedRecordingFormat();
  if (!format) throw new Error("이 WebView2에서 사용할 수 있는 영상 코덱을 찾지 못했습니다.");
  const plan = buildComparisonVideoPlan(manifest);
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("영상 Canvas를 만들지 못했습니다.");
  if (globalThis.document?.fonts?.ready) await globalThis.document.fonts.ready;
  throwIfAborted(signal);
  renderComparisonVideoFrame(context, plan, 0);
  const capture = createComparisonCaptureStream(canvas, plan.fps);
  const { stream } = capture;
  const chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond,
    });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const recorderError = { current: null };
  const stopped = new Promise((resolve) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", (event) => {
      recorderError.current = event.error || new Error("영상 녹화가 중단되었습니다.");
      resolve();
    }, { once: true });
  });
  const onAbort = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    recorder.start(1000);
    const pump = capture.frameRateLocked ? pumpManualFrames : pumpAutomaticFrames;
    const recordedWallClockSeconds = await pump({
      context,
      plan,
      capture,
      format,
      onProgress,
      signal,
      recorderError,
    });
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    throwIfAborted(signal);
    if (recorderError.current) throw recorderError.current;
    const mimeType = recorder.mimeType || format.mimeType;
    const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) throw new Error("녹화된 영상 데이터가 비어 있습니다.");
    return {
      blob,
      mimeType,
      extension,
      format: { ...format, mimeType },
      plan,
      captureMode: capture.mode,
      frameRateLocked: capture.frameRateLocked,
      frameCount: plan.frameCount,
      recordedWallClockSeconds,
    };
  } catch (error) {
    if (recorder.state !== "inactive") recorder.stop();
    await Promise.race([stopped, waitForMilliseconds(1_000)]);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.getTracks().forEach((track) => track.stop());
  }
}
