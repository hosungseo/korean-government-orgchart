const invoke = window.__TAURI__?.core?.invoke;
const $ = (id) => document.getElementById(id);

let manifest = null;
let hwpAvailable = false;

function setStatus(title, message, state = "idle") {
  const box = $("statusBox");
  box.dataset.state = state;
  box.querySelector("strong").textContent = title;
  box.querySelector("p").textContent = message;
}

function setRuntime(state, label) {
  const badge = $("runtimeBadge");
  badge.dataset.state = state;
  badge.querySelector("strong").textContent = label;
}

function setStep(id, state) {
  const step = $(id);
  step.classList.remove("done", "active", "failed");
  if (state) step.classList.add(state);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgObject(object) {
  const style = object.style || {};
  const geometry = object.geometry || {};
  if (object.type === "line") {
    return `<line x1="${geometry.x1}" y1="${geometry.y1}" x2="${geometry.x2}" y2="${geometry.y2}" stroke="${style.stroke}" stroke-width="${style.strokeWidthMm}" ${style.dash === "dash" ? 'stroke-dasharray="1 1"' : ""}/>`;
  }
  const fill = style.fill === "none" ? "none" : style.fill;
  const stroke = style.stroke === "none" ? "none" : style.stroke;
  const rectangle = `<rect x="${geometry.x}" y="${geometry.y}" width="${geometry.width}" height="${geometry.height}" fill="${fill}" stroke="${stroke}" stroke-width="${style.strokeWidthMm || 0}" ${style.dash === "dash" ? 'stroke-dasharray="1 1"' : ""}/>`;
  if (object.type !== "textbox") return rectangle;
  const padding = Number(style.paddingMm || 0);
  const fontSize = Number(style.fontSizePt || 6) * 0.352778;
  const anchor = style.align === "right" ? "end" : style.align === "center" ? "middle" : "start";
  const x = style.align === "right"
    ? geometry.x + geometry.width - padding
    : style.align === "center"
      ? geometry.x + geometry.width / 2
      : geometry.x + padding;
  const y = geometry.y + geometry.height / 2;
  return `${rectangle}<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" fill="${style.textColor || "#202020"}" font-family="Malgun Gothic, sans-serif" font-size="${fontSize}" font-weight="${style.bold ? 700 : 400}">${escapeXml(object.text)}</text>`;
}

function renderManifest(nextManifest) {
  manifest = nextManifest;
  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297" shape-rendering="geometricPrecision"><rect width="210" height="297" fill="#fff"/>${objects.map(svgObject).join("")}</svg>`;
  $("paper").innerHTML = svg;
  $("metricObjects").textContent = objects.length;
  $("metricTextboxes").textContent = objects.filter((object) => object.type === "textbox").length;
  $("metricLines").textContent = objects.filter((object) => object.type === "line").length;
  $("metricRectangles").textContent = objects.filter((object) => object.type === "rectangle").length;
  if (manifest.fileName) $("fileName").value = manifest.fileName;
}

async function loadSample() {
  if (!invoke) {
    try {
      const response = await fetch("../src-tauri/resources/mois-ai-participation-left.native.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderManifest(await response.json());
      setStatus("브라우저 미리보기", "작도 명세는 확인할 수 있지만 한글 출력은 Windows 앱에서 실행됩니다.", "idle");
    } catch {
      setStatus("Windows 앱 필요", "Tauri Windows 앱에서 네이티브 한글 출력을 사용할 수 있습니다.", "error");
    }
    return;
  }
  try {
    const text = await invoke("sample_native_manifest");
    renderManifest(JSON.parse(text));
    setStatus("작도 명세 준비됨", "두 실의 상자·계선·평가대상 테두리를 개별 객체로 준비했습니다.", "idle");
  } catch (error) {
    setStatus("명세 오류", String(error), "error");
  }
}

async function checkRuntime() {
  if (!invoke) {
    setRuntime("unavailable", "브라우저 미리보기");
    setStep("stepRuntime", "failed");
    return;
  }
  try {
    const runtime = await invoke("hwp_runtime_info");
    hwpAvailable = Boolean(runtime.available);
    if (hwpAvailable) {
      setRuntime("ready", runtime.version ? `한글 ${runtime.version} 연결됨` : "Windows 한글 연결됨");
      setStep("stepRuntime", "done");
      $("generateButton").disabled = false;
      const securityNote = runtime.securityModuleRegistered
        ? "파일 접근 보안모듈까지 확인했습니다."
        : "첫 저장 시 한글의 파일 접근 승인창이 나타날 수 있습니다.";
      setStatus("한글 연결 완료", securityNote, "success");
    } else {
      setRuntime("unavailable", "Windows 한글 미연결");
      setStep("stepRuntime", "failed");
      setStatus("한글을 찾지 못함", runtime.reason || "Windows 한글 설치 상태를 확인하세요.", "error");
    }
  } catch (error) {
    setRuntime("unavailable", "한글 연결 오류");
    setStep("stepRuntime", "failed");
    setStatus("한글 연결 오류", String(error), "error");
  }
}

async function generate() {
  if (!invoke || !manifest || !hwpAvailable) return;
  const button = $("generateButton");
  button.disabled = true;
  setStep("stepVerify", "active");
  setStatus("네이티브 객체 작도 중", "한글이 잠깐 열립니다. 상자와 계선을 만들고 저장본을 다시 검사합니다.", "working");
  $("verification").dataset.state = "";
  $("verification").querySelector("span").textContent = "검증 중";
  $("verification").querySelector("p").textContent = "저장된 HWPX를 한글로 다시 여는 중입니다.";
  try {
    const result = await invoke("generate_native_hwpx", {
      request: {
        manifestJson: JSON.stringify(manifest),
        fileName: $("fileName").value,
        openAfter: $("openAfter").checked,
      },
    });
    if (result.verified) {
      setStep("stepVerify", "done");
      setStatus("편집형 HWPX 검증 완료", `${result.pageCount}쪽 · 네이티브 객체 ${result.nativeObjectCount}개 · ${result.outputPath}`, "success");
      $("verification").dataset.state = "success";
      $("verification").querySelector("span").textContent = "재열기 검증 통과";
      $("verification").querySelector("p").textContent = `A4 ${result.pageCount}쪽, 객체 ${result.nativeObjectCount}/${result.expectedNativeObjectCount}개가 저장본에서 확인됐습니다.`;
    } else {
      setStep("stepVerify", "failed");
      setStatus("HWPX는 생성됐지만 검증 불일치", `${result.outputPath} · 쪽수 또는 객체 수를 확인해야 합니다.`, "error");
      $("verification").dataset.state = "error";
      $("verification").querySelector("span").textContent = "재열기 검증 불일치";
      $("verification").querySelector("p").textContent = `쪽수 ${result.pageCount}/${result.expectedPageCount}, 객체 ${result.nativeObjectCount}/${result.expectedNativeObjectCount}`;
    }
  } catch (error) {
    setStep("stepVerify", "failed");
    setStatus("생성 실패", String(error), "error");
    $("verification").dataset.state = "error";
    $("verification").querySelector("span").textContent = "생성 또는 검증 실패";
    $("verification").querySelector("p").textContent = String(error);
  } finally {
    button.disabled = !hwpAvailable;
  }
}

$("generateButton").addEventListener("click", generate);
$("reloadButton").addEventListener("click", loadSample);

await loadSample();
await checkRuntime();
