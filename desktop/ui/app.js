import { analyzeNativeManifest } from "./manifest-validation.js";
import { buildNativeComparisonWorkflow, buildNativeLawWorkflow } from "./engine/native-law-workflow.mjs";
import { flattenLawJson } from "./engine/law-json-core.mjs";
import { compareLawSnapshots, createLawSnapshot, summarizeLawSnapshot } from "./engine/law-history.mjs";

const invoke = window.__TAURI__?.core?.invoke;
const $ = (id) => document.getElementById(id);
const MAX_MANIFEST_FILE_BYTES = 5 * 1024 * 1024;

let manifest = null;
let validationReport = null;
let hwpAvailable = false;
let lawWorkflow = null;
let activeWorkflowPage = 0;
let lawSourceInfo = {};
let currentLawSnapshot = null;
let historySnapshots = [];

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

function refreshGenerateAvailability() {
  $("generateButton").disabled = !(invoke && hwpAvailable && manifest && validationReport?.valid);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgText(object, geometry, style) {
  const padding = Number(style.paddingMm || 0);
  const fontSize = Number(style.fontSizePt || 6) * 0.352778;
  const anchor = style.align === "right" ? "end" : style.align === "center" ? "middle" : "start";
  const x = style.align === "right"
    ? geometry.x + geometry.width - padding
    : style.align === "center"
      ? geometry.x + geometry.width / 2
      : geometry.x + padding;
  const lines = String(object.text ?? "").split(/\r?\n/);
  const lineHeight = fontSize * 1.22;
  const centerY = geometry.y + geometry.height / 2;
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines.map((line, index) => (
    `<tspan x="${x}" y="${startY + index * lineHeight}">${escapeXml(line)}</tspan>`
  )).join("");
  return `<text text-anchor="${anchor}" dominant-baseline="central" fill="${style.textColor || "#202020"}" font-family="${escapeXml(style.fontFamily || "Malgun Gothic")}, sans-serif" font-size="${fontSize}" font-weight="${style.bold ? 700 : 400}">${tspans}</text>`;
}

function dashAttr(style) {
  if (style.dashArray) return `stroke-dasharray="${style.dashArray}"`;
  if (style.dash === "dash") return `stroke-dasharray="2.6 1.4"`;
  return "";
}

function svgObject(object) {
  const style = object.style || {};
  const geometry = object.geometry || {};
  if (object.type === "line") {
    return `<line x1="${geometry.x1}" y1="${geometry.y1}" x2="${geometry.x2}" y2="${geometry.y2}" stroke="${style.stroke}" stroke-width="${style.strokeWidthMm}" stroke-linecap="square" ${dashAttr(style)}/>`;
  }
  const fill = style.fill === "none" ? "none" : style.fill;
  const stroke = style.stroke === "none" ? "none" : style.stroke;
  const rectangle = `<rect x="${geometry.x}" y="${geometry.y}" width="${geometry.width}" height="${geometry.height}" fill="${fill}" stroke="${stroke}" stroke-width="${style.strokeWidthMm || 0}" ${dashAttr(style)}/>`;
  if (object.type !== "textbox") return rectangle;
  return `${rectangle}${svgText(object, geometry, style)}`;
}

function renderManifest(nextManifest) {
  manifest = nextManifest;
  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  const pageWidth = Number(manifest.page?.widthMm || 210);
  const pageHeight = Number(manifest.page?.heightMm || 297);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}mm" height="${pageHeight}mm" viewBox="0 0 ${pageWidth} ${pageHeight}" shape-rendering="geometricPrecision"><rect width="${pageWidth}" height="${pageHeight}" fill="#fff"/>${objects.map(svgObject).join("")}</svg>`;
  $("paper").style.aspectRatio = `${pageWidth} / ${pageHeight}`;
  $("paper").classList.toggle("is-landscape", pageWidth > pageHeight);
  $("paper").setAttribute("aria-label", pageWidth > pageHeight ? "A3 가로 조직도 미리보기" : "A4 세로 조직도 미리보기");
  $("paper").innerHTML = svg;
}

function clearPreview(message) {
  $("paper").innerHTML = `<div class="paper-loading paper-error">${escapeXml(message)}</div>`;
}

function manifestDescription(nextManifest) {
  const source = nextManifest?.source || {};
  const parts = [source.institution, source.asOf ? `기준 ${source.asOf}` : ""].filter(Boolean);
  return parts.join(" · ") || "외부 네이티브 작도 명세";
}

function diagnosticItems(report) {
  return [...(report.errors || []), ...(report.warnings || [])].slice(0, 6);
}

function renderPreflight(report) {
  const errors = report.errors || [];
  const warnings = report.warnings || [];
  const summary = report.summary || {};
  const box = $("preflight");
  const state = errors.length ? "error" : warnings.length ? "warning" : "success";
  box.dataset.state = state;
  box.querySelector("span").textContent = errors.length
    ? `사전검사 오류 ${errors.length}건`
    : warnings.length
      ? `통과 · 주의 ${warnings.length}건`
      : "사전검사 통과";
  box.querySelector("p").textContent = errors.length
    ? "오류를 바로잡기 전에는 한글 생성을 시작하지 않습니다."
    : `${summary.connectionChecks || 0}개 자식 계선의 상자 접합과 용지 경계를 확인했습니다.`;
  const list = $("diagnosticList");
  list.replaceChildren();
  for (const item of diagnosticItems(report)) {
    const li = document.createElement("li");
    li.dataset.level = errors.includes(item) ? "error" : "warning";
    li.textContent = `${item.objectId ? `${item.objectId} · ` : ""}${item.message}`;
    list.append(li);
  }
  if (!errors.length && !warnings.length) {
    const li = document.createElement("li");
    li.dataset.level = "success";
    li.textContent = "용지 밖 객체·중복 ID·객체 수 불일치·끊어진 자식 계선이 없습니다.";
    list.append(li);
  }
  $("metricObjects").textContent = summary.objectCount ?? "—";
  $("metricTextboxes").textContent = summary.textBoxCount ?? "—";
  $("metricLines").textContent = summary.lineCount ?? "—";
  $("metricRectangles").textContent = summary.rectangleCount ?? "—";
  $("metricWarnings").textContent = warnings.length;
  setStep("stepManifest", report.valid ? "done" : "failed");
}

async function authoritativePreflight(nextManifest, browserReport) {
  if (!invoke || !browserReport.valid) return browserReport;
  try {
    const nativeReport = await invoke("validate_native_manifest", {
      request: { manifestJson: JSON.stringify(nextManifest) },
    });
    const seen = new Set((browserReport.warnings || []).map((item) => `${item.code}:${item.objectId || ""}`));
    const nativeWarnings = (nativeReport.warnings || []).filter((item) => !seen.has(`${item.code}:${item.objectId || ""}`));
    return {
      ...browserReport,
      warnings: [...(browserReport.warnings || []), ...nativeWarnings],
      summary: { ...browserReport.summary, ...(nativeReport.summary || {}) },
    };
  } catch (error) {
    return {
      ...browserReport,
      valid: false,
      errors: [...(browserReport.errors || []), { code: "native-preflight", message: String(error) }],
    };
  }
}

async function acceptManifest(nextManifest, sourceLabel, { preserveWorkflow = false } = {}) {
  if (!preserveWorkflow) clearLawWorkflow();
  manifest = nextManifest;
  $("loadedSource").textContent = sourceLabel;
  $("manifestTitle").textContent = typeof nextManifest?.title === "string" ? nextManifest.title : "제목 없는 조직도";
  $("manifestDescription").textContent = manifestDescription(nextManifest);
  if (typeof nextManifest?.fileName === "string" && nextManifest.fileName.trim()) {
    $("fileName").value = nextManifest.fileName;
  }
  $("verification").dataset.state = "";
  $("verification").querySelector("span").textContent = "생성 후 검증 대기";
  $("verification").querySelector("p").textContent = "저장 파일을 한글로 다시 열어 실제 객체 수와 쪽수를 확인합니다.";
  $("openFolderButton").hidden = true;

  const browserReport = analyzeNativeManifest(nextManifest);
  validationReport = await authoritativePreflight(nextManifest, browserReport);
  renderPreflight(validationReport);
  if (validationReport.valid) {
    renderManifest(nextManifest);
    const warningMessage = validationReport.warnings.length
      ? `생성은 가능하지만 주의 ${validationReport.warnings.length}건을 먼저 확인하는 편이 좋습니다.`
      : "용지 경계·객체 수·ID·자식 계선 접합 검사를 통과했습니다.";
    setStatus(validationReport.warnings.length ? "명세 검사 통과(주의 있음)" : "명세 검사 통과", warningMessage, validationReport.warnings.length ? "warning" : "success");
  } else {
    clearPreview("명세 오류를 바로잡으면 미리보기가 표시됩니다.");
    setStatus("작도 명세 오류", validationReport.errors[0]?.message || "JSON 명세를 확인하세요.", "error");
  }
  refreshGenerateAvailability();
}

async function loadManifestText(text, sourceLabel) {
  try {
    await acceptManifest(JSON.parse(text), sourceLabel);
  } catch (error) {
    validationReport = { valid: false, errors: [{ code: "invalid-json", message: String(error) }], warnings: [], summary: {} };
    renderPreflight(validationReport);
    clearPreview("JSON 문법 오류로 미리보기를 만들 수 없습니다.");
    setStatus("JSON 불러오기 실패", String(error), "error");
    refreshGenerateAvailability();
  }
}

function clearLawWorkflow() {
  lawWorkflow = null;
  currentLawSnapshot = null;
  activeWorkflowPage = 0;
  $("pageNavigator").hidden = true;
  $("pageSelect").replaceChildren();
  $("parseSummary").hidden = true;
  $("historyControls").hidden = true;
  $("historyDiff").hidden = true;
}

function setHistoryControlsVisible(visible) {
  $("historyControls").hidden = !visible || !invoke;
}

function historyOptionLabel(snapshot) {
  const summary = summarizeLawSnapshot(snapshot);
  const date = summary.asOf || "기준일 없음";
  return `${date} · ${summary.nodeCount}개 조직 · ${summary.capturedAt ? summary.capturedAt.slice(0, 10) : ""}`;
}

function renderHistorySelectors() {
  const required = [$("historyLeft"), $("historyRight")];
  const optional = [$("historyMid"), $("historyFourth")].filter(Boolean);
  const previous = Object.fromEntries([...required, ...optional].map((select) => [select.id, select.value]));
  for (const select of [...required, ...optional]) {
    select.replaceChildren();
    if (optional.includes(select)) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "없음";
      select.append(empty);
    }
    for (const snapshot of historySnapshots) {
      const option = document.createElement("option");
      option.value = snapshot.id;
      option.textContent = historyOptionLabel(snapshot);
      select.append(option);
    }
  }
  if (historySnapshots.length) {
    $("historyLeft").value = historySnapshots.some((item) => item.id === previous.historyLeft)
      ? previous.historyLeft
      : historySnapshots.at(-1).id;
    $("historyRight").value = historySnapshots.some((item) => item.id === previous.historyRight)
      ? previous.historyRight
      : historySnapshots[0].id;
    for (const select of optional) {
      select.value = historySnapshots.some((item) => item.id === previous[select.id]) ? previous[select.id] : "";
    }
  }
  $("compareHistoryButton").disabled = historySnapshots.length < 2;
}

async function refreshHistory() {
  if (!invoke) return;
  try {
    const result = await invoke("list_law_snapshots");
    const institution = currentLawSnapshot?.institution || manifest?.source?.institution || "";
    historySnapshots = (result.snapshots || []).filter((snapshot) => !institution || snapshot.institution === institution);
    renderHistorySelectors();
  } catch (error) {
    setStatus("법령 이력 읽기 실패", String(error), "error");
  }
}

async function saveCurrentSnapshot() {
  if (!invoke || !currentLawSnapshot) return;
  const button = $("saveSnapshotButton");
  button.disabled = true;
  try {
    const saved = await invoke("save_law_snapshot", {
      request: { snapshotJson: JSON.stringify(currentLawSnapshot) },
    });
    currentLawSnapshot = saved.snapshot || currentLawSnapshot;
    await refreshHistory();
    setStatus("법령 이력 저장 완료", `${currentLawSnapshot.asOf || "기준일 없음"} 조직 스냅샷을 로컬 이력 DB에 저장했습니다.`, "success");
  } catch (error) {
    setStatus("법령 이력 저장 실패", String(error), "error");
  } finally {
    button.disabled = false;
  }
}

function diffLine(label, entries, formatter) {
  if (!entries.length) return "";
  const items = entries.slice(0, 30).map((entry) => `<li>${escapeXml(formatter(entry))}</li>`).join("");
  return `<strong>${escapeXml(label)} ${entries.length}건</strong><ul>${items}</ul>`;
}

function renderHistoryDiff(diff) {
  const box = $("historyDiff");
  const summary = diff.summary;
  const parts = [
    `<strong>${escapeXml(diff.previous.asOf || "이전")} → ${escapeXml(diff.current.asOf || "현재")}</strong> · 총 ${summary.totalChanges}건`,
    diffLine("신설", diff.added, (entry) => `+ ${entry.path.join(" › ")}`),
    diffLine("폐지", diff.removed, (entry) => `− ${entry.path.join(" › ")}`),
    diffLine("명칭 변경", diff.renamed, (entry) => `${entry.before.name} → ${entry.after.name}`),
    diffLine("소속 이동", diff.moved, (entry) => `${entry.node.name}: ${entry.beforePath.join(" › ")} → ${entry.afterPath.join(" › ")}`),
    diffLine("속성 변경", diff.changed, (entry) => `${entry.node.name}: ${entry.before.kind} → ${entry.after.kind}`),
  ].filter(Boolean);
  box.innerHTML = parts.join("");
  box.hidden = false;
}

async function compareHistory() {
  if (!invoke || historySnapshots.length < 2) return;
  const button = $("compareHistoryButton");
  button.disabled = true;
  try {
    const selectedIds = [...new Set([
      $("historyLeft").value,
      $("historyRight").value,
      $("historyMid")?.value,
      $("historyFourth")?.value,
    ].filter(Boolean))];
    if (selectedIds.length < 2) throw new Error("서로 다른 기준일을 두 개 이상 고르세요.");
    const loaded = [];
    for (const id of selectedIds) {
      loaded.push(await invoke("load_law_snapshot", { request: { id } }));
    }
    loaded.sort((left, right) => String(left.asOf || "").localeCompare(String(right.asOf || "")));
    if (loaded.length === 2) {
      renderHistoryDiff(compareLawSnapshots(loaded[0], loaded[1]));
    } else {
      $("historyDiff").innerHTML = `<strong>${escapeXml(loaded.map((item) => item.asOf || "기준일 없음").join(" → "))}</strong> · ${loaded.length}단 대비`;
      $("historyDiff").hidden = false;
    }
    lawWorkflow = buildNativeComparisonWorkflow({
      stages: loaded,
      focus: $("lawFocus")?.value,
      onePage: true,
    });
    currentLawSnapshot = createLawSnapshot(lawWorkflow, {
      label: `${lawWorkflow.summary.institution} · ${loaded.map((item) => item.asOf || "?").join(" → ")}`,
    });
    activeWorkflowPage = 0;
    renderPageNavigator();
    renderLawWorkflowSummary(lawWorkflow.summary);
    await selectWorkflowPage(0);
    const paper = lawWorkflow.manifests[0]?.page?.paper || "A4";
    setStatus(
      "대비 조직도 작도 완료",
      `${loaded.map((item) => item.asOf || "기준일 없음").join(" · ")}을 ${paper} ${loaded.length}단으로 그렸습니다. 바뀐 과만 점선, 신설·폐지는 글자입니다.`,
      "success",
    );
  } catch (error) {
    setStatus("개편 내역 비교 실패", String(error), "error");
  } finally {
    button.disabled = false;
  }
}

function dateYearsAgo(dateText, yearsAgo) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  const yearValue = Math.max(1900, year - yearsAgo);
  const lastDay = new Date(yearValue, month, 0).getDate();
  return `${yearValue}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

async function collectRecentHistory() {
  const button = $("collectHistoryButton");
  const institution = $("lawInstitution").value.trim();
  const oc = $("lawApiOc").value.trim();
  const asOf = $("lawAsOf").value;
  const errorBox = $("lawInputError");
  if (!invoke) return;
  if (!institution || !oc || !asOf) {
    errorBox.textContent = "기관명, 기준일, Open API OC를 모두 입력해 주세요.";
    errorBox.hidden = false;
    return;
  }
  button.disabled = true;
  const dates = Array.from({ length: 5 }, (_, index) => dateYearsAgo(asOf, index));
  let successCount = 0;
  const failures = [];
  try {
    for (const [index, date] of dates.entries()) {
      $("lawApiStatus").textContent = `최근 5년 이력 수집 중… ${index + 1}/${dates.length} · ${date}`;
      try {
        const result = await invoke("fetch_official_laws", { request: { oc, institution, asOf: date } });
        const workflow = buildNativeLawWorkflow({
          decreeText: flattenLawJson(result.decree?.json),
          ruleText: flattenLawJson(result.rule?.json),
          institution,
          asOf: date,
          layout: $("lawLayout").value,
          lawSources: { decree: result.decree, rule: result.rule },
        });
        const snapshot = createLawSnapshot(workflow, { label: `${institution} · ${date}` });
        await invoke("save_law_snapshot", { request: { snapshotJson: JSON.stringify(snapshot) } });
        successCount += 1;
      } catch (error) {
        failures.push(`${date}: ${String(error?.message || error)}`);
      }
    }
    await refreshHistory();
    $("lawApiOc").value = "";
    $("lawApiStatus").textContent = `${successCount}개 기준일의 법령·조직 스냅샷을 저장했습니다.`;
    if (failures.length) {
      errorBox.textContent = `일부 기준일은 수집하지 못했습니다. ${failures.join(" · ")}`;
      errorBox.hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}

function renderLawWorkflowSummary(summary) {
  $("parseSummary").hidden = false;
  $("parsedNodes").textContent = `${summary.nodeCount}개`;
  $("parsedRelations").textContent = `${summary.relationCount}개`;
  $("parsedPages").textContent = `${summary.pageCount}쪽`;
  const warning = (summary.warnings || [])[0];
  $("parseWarning").textContent = warning || "직제와 시행규칙을 모두 확인했습니다.";
  $("parseWarning").hidden = !warning;

  const datalist = $("focusOptions");
  datalist.replaceChildren();
  for (const option of summary.focusOptions || []) {
    const element = document.createElement("option");
    element.value = option.name;
    element.label = `하위 ${option.descendantCount}개`;
    datalist.append(element);
  }
}

function renderPageNavigator() {
  const pages = lawWorkflow?.pages || [];
  const select = $("pageSelect");
  select.replaceChildren();
  pages.forEach((page, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1}/${pages.length} · ${page.label} (${page.nodeCount}개)`;
    select.append(option);
  });
  select.value = String(activeWorkflowPage);
  $("pageNavigator").hidden = pages.length < 2;
  $("previousPageButton").disabled = activeWorkflowPage <= 0;
  $("nextPageButton").disabled = activeWorkflowPage >= pages.length - 1;
}

async function selectWorkflowPage(index) {
  if (!lawWorkflow?.manifests?.length) return;
  activeWorkflowPage = Math.max(0, Math.min(lawWorkflow.manifests.length - 1, Number(index) || 0));
  const page = lawWorkflow.pages[activeWorkflowPage];
  renderPageNavigator();
  await acceptManifest(
    lawWorkflow.manifests[activeWorkflowPage],
    `문언 자동변환 · ${activeWorkflowPage + 1}/${lawWorkflow.manifests.length}`,
    { preserveWorkflow: true },
  );
  renderLawWorkflowSummary(lawWorkflow.summary);
  const warningCount = lawWorkflow.summary.warnings?.length || 0;
  setStatus(
    warningCount ? "문언 자동분석 완료(확인 필요)" : "문언 자동분석 완료",
    `조직 ${lawWorkflow.summary.nodeCount}개·관계 ${lawWorkflow.summary.relationCount}개를 ${lawWorkflow.summary.pageCount}쪽으로 작도했습니다. 현재 ${page.label}입니다.`,
    warningCount ? "warning" : "success",
  );
}

async function parseLawInput(event) {
  event.preventDefault();
  const button = $("parseLawButton");
  const errorBox = $("lawInputError");
  button.disabled = true;
  button.textContent = "문언 분석 중…";
  errorBox.hidden = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    lawWorkflow = buildNativeLawWorkflow({
      decreeText: $("decreeText").value,
      ruleText: $("ruleText").value,
      institution: $("lawInstitution").value,
      asOf: $("lawAsOf").value,
      focus: $("lawFocus").value,
      layout: $("lawLayout").value,
      lawSources: lawSourceInfo,
    });
    currentLawSnapshot = createLawSnapshot(lawWorkflow, { label: `${lawWorkflow.summary.institution} · ${lawWorkflow.summary.asOf || "기준일 없음"}` });
    activeWorkflowPage = 0;
    renderPageNavigator();
    renderLawWorkflowSummary(lawWorkflow.summary);
    await selectWorkflowPage(0);
    setHistoryControlsVisible(true);
    await refreshHistory();
    $("lawInputDialog").close();
  } catch (error) {
    errorBox.textContent = String(error?.message || error);
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "자동 조직도 만들기";
  }
}

async function fetchOfficialLawInput() {
  const button = $("fetchLawApiButton");
  const errorBox = $("lawInputError");
  const status = $("lawApiStatus");
  errorBox.hidden = true;
  if (!invoke) {
    errorBox.textContent = "공식 법령 자동조회는 Windows 앱에서 사용할 수 있습니다.";
    errorBox.hidden = false;
    return;
  }
  const institution = $("lawInstitution").value.trim();
  const oc = $("lawApiOc").value.trim();
  const asOf = $("lawAsOf").value;
  if (!institution || !oc || !asOf) {
    errorBox.textContent = "기관명, 기준일, Open API OC를 모두 입력해 주세요.";
    errorBox.hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = "공식 법령 조회 중…";
  status.textContent = "국가법령정보센터에서 기준일에 유효한 두 법령을 확인하고 있습니다.";
  try {
    const result = await invoke("fetch_official_laws", {
      request: { oc, institution, asOf },
    });
    $("decreeText").value = flattenLawJson(result.decree?.json);
    $("ruleText").value = flattenLawJson(result.rule?.json);
    lawSourceInfo = { decree: result.decree, rule: result.rule };
    $("lawApiOc").value = "";
    const displayDate = (value) => {
      const digits = String(value || "").replace(/\D/g, "");
      return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : value;
    };
    status.textContent = `불러오기 완료 · 직제 ${displayDate(result.decree?.effectiveDate)} 시행본 · 시행규칙 ${displayDate(result.rule?.effectiveDate)} 시행본`;
  } catch (error) {
    errorBox.textContent = String(error?.message || error);
    errorBox.hidden = false;
    status.textContent = "공식 법령을 불러오지 못했습니다.";
  } finally {
    button.disabled = false;
    button.textContent = "공식 API에서 두 법령 불러오기";
  }
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_MANIFEST_FILE_BYTES) {
    setStatus("파일이 너무 큼", "작도 명세 JSON은 5MB 이하만 불러올 수 있습니다.", "error");
    return;
  }
  if (!file.name.toLowerCase().endsWith(".json")) {
    setStatus("지원하지 않는 파일", ".json 작도 명세를 선택하세요.", "error");
    return;
  }
  setStep("stepManifest", "active");
  setStatus("명세 읽는 중", `${file.name}을 검사하고 있습니다.`, "working");
  await loadManifestText(await file.text(), file.name);
}

async function loadSample() {
  setStep("stepManifest", "active");
  try {
    let text;
    if (invoke) {
      text = await invoke("sample_native_manifest");
    } else {
      const response = await fetch("../src-tauri/resources/mois-ai-participation-left.native.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    }
    await loadManifestText(text, "내장 샘플 · 행안부 두 실");
    if (!invoke) setStatus("브라우저 미리보기", "명세 검사는 가능하지만 한글 출력은 Windows 앱에서 실행됩니다.", "idle");
  } catch (error) {
    setStep("stepManifest", "failed");
    setStatus("샘플 명세 오류", String(error), "error");
  }
}

async function checkRuntime() {
  if (!invoke) {
    setRuntime("unavailable", "브라우저 미리보기");
    setStep("stepRuntime", "failed");
    refreshGenerateAvailability();
    return;
  }
  try {
    const runtime = await invoke("hwp_runtime_info");
    hwpAvailable = Boolean(runtime.available && runtime.securityModuleRegistered);
    if (hwpAvailable) {
      setRuntime("ready", runtime.version ? `한글 ${runtime.version} 연결됨` : "Windows 한글 연결됨");
      setStep("stepRuntime", "done");
      setStatus("한글 연결 완료", "한글 연결과 파일 접근 보안모듈을 확인했습니다.", "success");
    } else if (runtime.available) {
      setRuntime("unavailable", "한글 보안모듈 미등록");
      setStep("stepRuntime", "failed");
      setStatus(
        "파일 접근 보안모듈 필요",
        "한컴 개발자센터의 Automation 보안모듈을 설치·등록한 뒤 연결 상태를 다시 확인하세요.",
        "error",
      );
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
  refreshGenerateAvailability();
}

async function generate() {
  if (!invoke || !manifest || !hwpAvailable || !validationReport?.valid) return;
  const button = $("generateButton");
  button.disabled = true;
  setStep("stepVerify", "active");
  setStatus("네이티브 객체 작도 중", "한글에서 상자와 계선을 만들고 저장본을 다시 검사합니다.", "working");
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
    $("openFolderButton").hidden = false;
    if (result.verified) {
      setStep("stepVerify", "done");
      setStatus("편집형 HWPX 검증 완료", `${result.pageCount}쪽 · 네이티브 객체 ${result.nativeObjectCount}개 · 검증 리포트 저장 완료`, "success");
      $("verification").dataset.state = "success";
      $("verification").querySelector("span").textContent = "재열기 검증 통과";
      $("verification").querySelector("p").textContent = `A4 ${result.pageCount}쪽, 객체 ${result.nativeObjectCount}/${result.expectedNativeObjectCount}개를 확인했습니다. 같은 폴더에 .native.json과 .verification.json을 남겼습니다.`;
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
    refreshGenerateAvailability();
  }
}

async function openOutputFolder() {
  if (!invoke) return;
  try {
    const result = await invoke("open_output_directory");
    if (!result.opened) setStatus("결과 폴더", result.path, "idle");
  } catch (error) {
    setStatus("폴더 열기 실패", String(error), "error");
  }
}

$("generateButton").addEventListener("click", generate);
$("reloadButton").addEventListener("click", loadSample);
$("loadManifestButton").addEventListener("click", () => $("manifestFile").click());
$("manifestFile").addEventListener("change", (event) => loadFile(event.target.files?.[0]));
$("openFolderButton").addEventListener("click", openOutputFolder);
$("openLawInputButton").addEventListener("click", () => {
  $("lawInputError").hidden = true;
  $("lawInputDialog").showModal();
});
$("closeLawInputButton").addEventListener("click", () => $("lawInputDialog").close());
$("lawInputForm").addEventListener("submit", parseLawInput);
$("fetchLawApiButton").addEventListener("click", fetchOfficialLawInput);
$("collectHistoryButton").addEventListener("click", collectRecentHistory);
$("saveSnapshotButton").addEventListener("click", saveCurrentSnapshot);
$("refreshHistoryButton").addEventListener("click", refreshHistory);
$("compareHistoryButton").addEventListener("click", compareHistory);
$("pageSelect").addEventListener("change", (event) => selectWorkflowPage(event.target.value));
$("previousPageButton").addEventListener("click", () => selectWorkflowPage(activeWorkflowPage - 1));
$("nextPageButton").addEventListener("click", () => selectWorkflowPage(activeWorkflowPage + 1));

const drawingStage = $("drawingStage");
for (const eventName of ["dragenter", "dragover"]) {
  drawingStage.addEventListener(eventName, (event) => {
    event.preventDefault();
    drawingStage.classList.add("drop-active");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  drawingStage.addEventListener(eventName, (event) => {
    event.preventDefault();
    drawingStage.classList.remove("drop-active");
  });
}
drawingStage.addEventListener("drop", (event) => loadFile(event.dataTransfer?.files?.[0]));

if (!$("lawAsOf").value) {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  $("lawAsOf").value = localDate;
}

await loadSample();
await checkRuntime();
