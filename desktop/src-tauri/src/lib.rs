use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const HWP_NATIVE_SCRIPT: &str = include_str!("../resources/hwp-native.ps1");
const LAW_OPEN_API_SCRIPT: &str = include_str!("../resources/law-open-api.ps1");
const SAMPLE_NATIVE_MANIFEST: &str =
    include_str!("../resources/mois-ai-participation-left.native.json");
const HWP_NATIVE_MANIFEST_SCHEMA: &str = "kr.go.mois.orgchart.hwp-native/v1";
const MAX_MANIFEST_BYTES: usize = 10 * 1024 * 1024;
const MAX_NATIVE_OBJECTS: usize = 5_000;
const MAX_LAW_HISTORY_BYTES: usize = 64 * 1024 * 1024;
const PAGE_TOLERANCE_MM: f64 = 0.02;
const CONNECTION_TOLERANCE_MM: f64 = 1.05;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHwpxRequest {
    manifest_json: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    open_after: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateManifestRequest {
    manifest_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LawApiRequest {
    oc: String,
    institution: String,
    as_of: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LawSnapshotRequest {
    snapshot_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LawHistoryItemRequest {
    id: String,
}

fn unique_run_dir(app: &tauri::AppHandle, label: &str) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("앱 캐시 폴더를 찾지 못했습니다: {error}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("실행 시각을 만들지 못했습니다: {error}"))?
        .as_millis();
    let run_dir = cache.join("native-hwpx").join(format!("{label}-{now}"));
    fs::create_dir_all(&run_dir)
        .map_err(|error| format!("임시 폴더를 만들지 못했습니다: {error}"))?;
    Ok(run_dir)
}

fn write_utf8_bom(path: &Path, contents: &str) -> Result<(), String> {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(contents.trim_start_matches('\u{feff}').as_bytes());
    fs::write(path, bytes)
        .map_err(|error| format!("PowerShell 모듈을 준비하지 못했습니다: {error}"))
}

fn powershell_executable() -> PathBuf {
    if let Some(system_root) = env::var_os("SystemRoot") {
        let candidate = PathBuf::from(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("powershell.exe")
}

fn run_powershell<I, S>(script_path: &Path, args: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(powershell_executable());
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script_path)
        .args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .output()
        .map_err(|error| format!("한글 Automation 모듈을 실행하지 못했습니다: {error}"))
}

fn parse_json_output(output: &Output) -> Result<Value, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!(
                "한글 Automation이 종료 코드 {:?}로 끝났습니다.",
                output.status.code()
            )
        } else {
            stderr
        });
    }
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .ok_or_else(|| {
            if stderr.is_empty() {
                "한글 Automation의 검증 결과를 읽지 못했습니다.".to_string()
            } else {
                format!("한글 Automation의 검증 결과를 읽지 못했습니다: {stderr}")
            }
        })
}

fn validate_law_api_request(request: &LawApiRequest) -> Result<(), String> {
    let oc = request.oc.trim();
    if oc.len() < 3 || oc.len() > 200 || oc.chars().any(char::is_control) {
        return Err("Open API OC 값을 확인해 주세요.".to_string());
    }
    let institution = request.institution.trim();
    if institution.len() < 2
        || institution.len() > 100
        || institution.chars().any(char::is_control)
    {
        return Err("기관명을 정확히 입력해 주세요.".to_string());
    }
    let date_digits: String = request
        .as_of
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();
    if date_digits.len() != 8 {
        return Err("기준일은 YYYY-MM-DD 형식이어야 합니다.".to_string());
    }
    Ok(())
}

fn sanitize_file_name(value: &str) -> String {
    let source = if value.trim().is_empty() {
        "행정안전부-인공지능정부실-참여혁신조직실-편집형.hwpx"
    } else {
        value.trim()
    };
    let mut name: String = source
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '-'
            } else {
                character
            }
        })
        .collect();
    name = name.trim_matches([' ', '.']).to_string();
    if name.is_empty() {
        name = "편집형-조직도.hwpx".to_string();
    }
    if !name.to_lowercase().ends_with(".hwpx") {
        name.push_str(".hwpx");
    }
    let stem = Path::new(&name)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    let mut shortened: String = stem.chars().take(96).collect();
    if shortened.trim().is_empty() {
        shortened = "편집형-조직도".to_string();
    }
    format!("{shortened}.hwpx")
}

fn unique_output_path(directory: &Path, file_name: &str) -> PathBuf {
    let desired = directory.join(file_name);
    if !desired.exists() {
        return desired;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let stem = desired
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    directory.join(format!("{stem}-{timestamp}.hwpx"))
}

fn output_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .document_dir()
        .map_err(|error| format!("문서 폴더를 찾지 못했습니다: {error}"))?
        .join("직제기구도");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("출력 폴더를 만들지 못했습니다: {error}"))?;
    Ok(directory)
}

fn law_history_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("법령 이력 폴더를 찾지 못했습니다: {error}"))?
        .join("law-history");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("법령 이력 폴더를 만들지 못했습니다: {error}"))?;
    Ok(directory.join("law-history.json"))
}

fn read_law_history(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = law_history_file(app)?;
    if !path.exists() {
        return Ok(json!({
            "schema": "kr.go.mois.orgchart.history-db/v1",
            "updatedAtUnixMs": unix_time_millis(),
            "snapshots": [],
        }));
    }
    let bytes = fs::read(&path).map_err(|error| format!("법령 이력을 읽지 못했습니다: {error}"))?;
    if bytes.len() > MAX_LAW_HISTORY_BYTES {
        return Err("법령 이력 DB가 64MB를 초과했습니다. 오래된 이력을 정리해 주세요.".to_string());
    }
    let history: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("법령 이력 DB가 손상되었습니다: {error}"))?;
    if !history.is_object() {
        return Err("법령 이력 DB 형식이 올바르지 않습니다.".to_string());
    }
    Ok(history)
}

fn write_law_history(app: &tauri::AppHandle, history: &Value) -> Result<PathBuf, String> {
    let path = law_history_file(app)?;
    let contents = serde_json::to_vec_pretty(history)
        .map_err(|error| format!("법령 이력을 직렬화하지 못했습니다: {error}"))?;
    if contents.len() > MAX_LAW_HISTORY_BYTES {
        return Err("법령 이력 DB가 64MB를 초과합니다. 오래된 이력을 정리해 주세요.".to_string());
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, &contents).map_err(|error| format!("법령 이력을 저장하지 못했습니다: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("법령 이력 DB를 교체하지 못했습니다: {error}"))?;
    Ok(path)
}

fn companion_path(output_path: &Path, suffix: &str) -> PathBuf {
    let stem = output_path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    output_path.with_file_name(format!("{stem}.{suffix}"))
}

fn unix_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

fn required_number(value: &Value, key: &str, label: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{label}의 {key} 값은 유한한 숫자여야 합니다."))
}

fn valid_color(value: Option<&str>, allow_none: bool) -> bool {
    let Some(color) = value else { return false };
    if allow_none && color == "none" {
        return true;
    }
    color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn point_near_rectangle(x: f64, y: f64, geometry: &Value) -> bool {
    let Ok(left) = required_number(geometry, "x", "자식 상자") else {
        return false;
    };
    let Ok(top) = required_number(geometry, "y", "자식 상자") else {
        return false;
    };
    let Ok(width) = required_number(geometry, "width", "자식 상자") else {
        return false;
    };
    let Ok(height) = required_number(geometry, "height", "자식 상자") else {
        return false;
    };
    let right = left + width;
    let bottom = top + height;
    let within_x = x >= left - CONNECTION_TOLERANCE_MM && x <= right + CONNECTION_TOLERANCE_MM;
    let within_y = y >= top - CONNECTION_TOLERANCE_MM && y <= bottom + CONNECTION_TOLERANCE_MM;
    (within_y && (x - left).abs().min((x - right).abs()) <= CONNECTION_TOLERANCE_MM)
        || (within_x && (y - top).abs().min((y - bottom).abs()) <= CONNECTION_TOLERANCE_MM)
}

fn validate_style(object: &Value, object_id: &str, object_type: &str) -> Result<(), String> {
    let style = object
        .get("style")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{object_id} 객체의 서식(style) 정보가 없습니다."))?;
    let stroke = style.get("stroke").and_then(Value::as_str);
    if !valid_color(stroke, true) {
        return Err(format!(
            "{object_id} 객체의 선 색상은 #RRGGBB 또는 none이어야 합니다."
        ));
    }
    let stroke_width = style
        .get("strokeWidthMm")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 10.0)
        .ok_or_else(|| format!("{object_id} 객체의 선 굵기는 0~10mm여야 합니다."))?;
    let dash = style.get("dash").and_then(Value::as_str);
    if !matches!(dash, Some("solid" | "dash")) {
        return Err(format!(
            "{object_id} 객체의 선 종류는 solid 또는 dash여야 합니다."
        ));
    }

    if object_type == "line" {
        if stroke == Some("none") || stroke_width == 0.0 {
            return Err(format!("{object_id} 선 객체가 보이지 않는 서식입니다."));
        }
        return Ok(());
    }

    if !valid_color(style.get("fill").and_then(Value::as_str), true) {
        return Err(format!(
            "{object_id} 객체의 채우기 색상은 #RRGGBB 또는 none이어야 합니다."
        ));
    }
    if object_type != "textbox" {
        return Ok(());
    }
    if !valid_color(style.get("textColor").and_then(Value::as_str), false) {
        return Err(format!(
            "{object_id} 글상자의 문자 색상은 #RRGGBB여야 합니다."
        ));
    }
    style
        .get("fontSizePt")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 2.0 && *value <= 72.0)
        .ok_or_else(|| format!("{object_id} 글상자의 글자 크기는 2~72pt여야 합니다."))?;
    if !matches!(
        style.get("align").and_then(Value::as_str),
        Some("left" | "center" | "right")
    ) {
        return Err(format!(
            "{object_id} 글상자의 가로 정렬 값이 올바르지 않습니다."
        ));
    }
    if !matches!(
        style.get("verticalAlign").and_then(Value::as_str),
        Some("top" | "center" | "bottom")
    ) {
        return Err(format!(
            "{object_id} 글상자의 세로 정렬 값이 올바르지 않습니다."
        ));
    }
    style
        .get("paddingMm")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| format!("{object_id} 글상자의 안쪽 여백은 0 이상이어야 합니다."))?;
    Ok(())
}

fn analyze_manifest(manifest: &Value) -> Result<Value, String> {
    if manifest.get("schema").and_then(Value::as_str) != Some(HWP_NATIVE_MANIFEST_SCHEMA) {
        return Err("지원하지 않는 네이티브 작도 명세입니다.".to_string());
    }
    let page = manifest
        .get("page")
        .ok_or_else(|| "용지(page) 정보가 없습니다.".to_string())?;
    if page.get("paper").and_then(Value::as_str) != Some("A4")
        || page.get("orientation").and_then(Value::as_str) != Some("portrait")
    {
        return Err("현재 앱은 A4 세로 명세만 지원합니다.".to_string());
    }
    let page_width = required_number(page, "widthMm", "용지")?;
    let page_height = required_number(page, "heightMm", "용지")?;
    if (page_width - 210.0).abs() > PAGE_TOLERANCE_MM
        || (page_height - 297.0).abs() > PAGE_TOLERANCE_MM
    {
        return Err("A4 세로 크기는 210×297mm여야 합니다.".to_string());
    }
    let margin = page
        .get("marginMm")
        .ok_or_else(|| "용지 여백 정보가 없습니다.".to_string())?;
    let margin_left = required_number(margin, "left", "용지 여백")?;
    let margin_right = required_number(margin, "right", "용지 여백")?;
    let margin_top = required_number(margin, "top", "용지 여백")?;
    let margin_bottom = required_number(margin, "bottom", "용지 여백")?;
    if [margin_left, margin_right, margin_top, margin_bottom]
        .iter()
        .any(|value| *value < 0.0)
        || margin_left + margin_right >= page_width
        || margin_top + margin_bottom >= page_height
    {
        return Err("용지 여백 값이 올바르지 않습니다.".to_string());
    }

    let objects = manifest
        .get("objects")
        .and_then(Value::as_array)
        .ok_or_else(|| "네이티브 작도 객체가 없습니다.".to_string())?;
    if objects.is_empty() {
        return Err("네이티브 작도 객체가 없습니다.".to_string());
    }
    if objects.len() > MAX_NATIVE_OBJECTS {
        return Err(format!(
            "네이티브 객체는 최대 {MAX_NATIVE_OBJECTS}개까지 지원합니다."
        ));
    }

    let mut ids = HashSet::new();
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    let mut line_count = 0_u64;
    let mut rectangle_count = 0_u64;
    let mut text_box_count = 0_u64;
    let mut warnings = Vec::new();
    for object in objects {
        let object_id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "ID가 없는 네이티브 객체가 있습니다.".to_string())?;
        if !ids.insert(object_id.to_string()) {
            return Err(format!("중복 네이티브 객체 ID입니다: {object_id}"));
        }
        by_id.insert(object_id.to_string(), object);
        let object_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{object_id} 객체 유형이 없습니다."))?;
        if !matches!(object_type, "line" | "rectangle" | "textbox") {
            return Err(format!(
                "지원하지 않는 네이티브 객체 유형입니다: {object_type}"
            ));
        }
        let geometry = object
            .get("geometry")
            .ok_or_else(|| format!("{object_id} 객체의 좌표가 없습니다."))?;
        if object_type == "line" {
            line_count += 1;
            let x1 = required_number(geometry, "x1", object_id)?;
            let y1 = required_number(geometry, "y1", object_id)?;
            let x2 = required_number(geometry, "x2", object_id)?;
            let y2 = required_number(geometry, "y2", object_id)?;
            if [[x1, y1], [x2, y2]].iter().any(|point| {
                point[0] < 0.0
                    || point[1] < 0.0
                    || point[0] > page_width + PAGE_TOLERANCE_MM
                    || point[1] > page_height + PAGE_TOLERANCE_MM
            }) {
                return Err(format!("{object_id} 선이 A4 용지 밖으로 나갑니다."));
            }
            let dx = (x2 - x1).abs();
            let dy = (y2 - y1).abs();
            if dx.hypot(dy) < 0.01 {
                return Err(format!("{object_id} 선의 길이가 0입니다."));
            }
            if dx > 0.01 && dy > 0.01 {
                warnings.push(json!({
                    "code": "diagonal-line",
                    "objectId": object_id,
                    "message": "직각 계선이 아닌 대각선입니다."
                }));
            }
        } else {
            if object_type == "rectangle" {
                rectangle_count += 1;
            } else {
                text_box_count += 1;
                if object.get("text").and_then(Value::as_str).is_none() {
                    return Err(format!("{object_id} 글상자의 text 값이 문자열이 아닙니다."));
                }
            }
            let x = required_number(geometry, "x", object_id)?;
            let y = required_number(geometry, "y", object_id)?;
            let width = required_number(geometry, "width", object_id)?;
            let height = required_number(geometry, "height", object_id)?;
            if width <= 0.0
                || height <= 0.0
                || x < 0.0
                || y < 0.0
                || x + width > page_width + PAGE_TOLERANCE_MM
                || y + height > page_height + PAGE_TOLERANCE_MM
            {
                return Err(format!("{object_id} 객체가 A4 용지 밖으로 나갑니다."));
            }
        }
        validate_style(object, object_id, object_type)?;
    }

    let mut connection_checks = 0_u64;
    let mut connection_warnings = 0_u64;
    for object in objects {
        let Some(metadata) = object.get("metadata") else {
            continue;
        };
        let object_id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        for key in ["parentId", "childId", "targetId"] {
            if let Some(reference) = metadata.get(key).and_then(Value::as_str) {
                if !by_id.contains_key(reference) {
                    warnings.push(json!({
                        "code": "missing-reference",
                        "objectId": object_id,
                        "message": format!("{key}가 존재하지 않는 객체를 가리킵니다: {reference}")
                    }));
                }
            }
        }
        if object.get("type").and_then(Value::as_str) != Some("line") {
            continue;
        }
        let Some(child_id) = metadata.get("childId").and_then(Value::as_str) else {
            continue;
        };
        let Some(child) = by_id.get(child_id) else {
            continue;
        };
        if child.get("type").and_then(Value::as_str) == Some("line") {
            continue;
        }
        let Some(line_geometry) = object.get("geometry") else {
            continue;
        };
        let Some(child_geometry) = child.get("geometry") else {
            continue;
        };
        let x1 = required_number(line_geometry, "x1", object_id)?;
        let y1 = required_number(line_geometry, "y1", object_id)?;
        let x2 = required_number(line_geometry, "x2", object_id)?;
        let y2 = required_number(line_geometry, "y2", object_id)?;
        connection_checks += 1;
        if !point_near_rectangle(x1, y1, child_geometry)
            && !point_near_rectangle(x2, y2, child_geometry)
        {
            connection_warnings += 1;
            warnings.push(json!({
                "code": "unsnapped-child",
                "objectId": object_id,
                "message": format!("계선이 자식 상자({child_id}) 경계에 맞물리지 않습니다.")
            }));
        }
    }

    let verification = manifest
        .get("verification")
        .ok_or_else(|| "네이티브 객체 검증 기준이 없습니다.".to_string())?;
    let expected = [
        ("expectedPageCount", 1_u64),
        ("expectedNativeObjectCount", objects.len() as u64),
        ("expectedLineObjectCount", line_count),
        ("expectedRectangleObjectCount", rectangle_count),
        ("expectedTextBoxObjectCount", text_box_count),
        ("expectedEditableTextObjectCount", text_box_count),
    ];
    for (key, actual) in expected {
        if verification.get(key).and_then(Value::as_u64) != Some(actual) {
            return Err(format!("검증 예상값 {key}가 실제값 {actual}와 다릅니다."));
        }
    }

    Ok(json!({
        "valid": true,
        "schema": HWP_NATIVE_MANIFEST_SCHEMA,
        "warnings": warnings,
        "summary": {
            "title": manifest.get("title").and_then(Value::as_str).unwrap_or("제목 없는 조직도"),
            "fileName": manifest.get("fileName").and_then(Value::as_str).unwrap_or(""),
            "paper": "A4",
            "orientation": "portrait",
            "widthMm": page_width,
            "heightMm": page_height,
            "objectCount": objects.len(),
            "lineCount": line_count,
            "rectangleCount": rectangle_count,
            "textBoxCount": text_box_count,
            "connectionChecks": connection_checks,
            "connectionWarnings": connection_warnings,
        }
    }))
}

fn validate_manifest_json(contents: &str) -> Result<(Value, Value), String> {
    if contents.len() > MAX_MANIFEST_BYTES {
        return Err("네이티브 작도 명세는 10MB 이하여야 합니다.".to_string());
    }
    let manifest: Value = serde_json::from_str(contents)
        .map_err(|error| format!("네이티브 작도 명세 JSON이 올바르지 않습니다: {error}"))?;
    let report = analyze_manifest(&manifest)?;
    Ok((manifest, report))
}

fn launch_output(path: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .spawn()
            .is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        false
    }
}

#[tauri::command]
fn runtime_info() -> Value {
    json!({
        "name": "직제 기구도 · 한글 편집본",
        "platform": env::consts::OS,
        "arch": env::consts::ARCH,
        "nativeHwpx": env::consts::OS == "windows",
    })
}

#[tauri::command]
fn sample_native_manifest() -> String {
    SAMPLE_NATIVE_MANIFEST.to_string()
}

#[tauri::command]
fn validate_native_manifest(request: ValidateManifestRequest) -> Result<Value, String> {
    let (_, report) = validate_manifest_json(&request.manifest_json)?;
    Ok(report)
}

#[tauri::command]
fn open_output_directory(app: tauri::AppHandle) -> Result<Value, String> {
    let directory = output_directory(&app)?;
    #[cfg(target_os = "windows")]
    let opened = Command::new("explorer.exe").arg(&directory).spawn().is_ok();
    #[cfg(not(target_os = "windows"))]
    let opened = false;
    Ok(json!({
        "opened": opened,
        "path": directory.display().to_string(),
    }))
}

#[tauri::command]
async fn hwp_runtime_info(app: tauri::AppHandle) -> Result<Value, String> {
    if env::consts::OS != "windows" {
        return Ok(json!({
            "available": false,
            "platform": env::consts::OS,
            "reason": "한글 Automation은 Windows에서만 실행됩니다.",
        }));
    }
    let run_dir = unique_run_dir(&app, "probe")?;
    let script_path = run_dir.join("hwp-native.ps1");
    write_utf8_bom(&script_path, HWP_NATIVE_SCRIPT)?;
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_powershell(&script_path, ["-Mode", "Probe"])
    })
    .await
    .map_err(|error| format!("한글 확인 작업이 중단되었습니다: {error}"))??;
    let result = parse_json_output(&output);
    let _ = fs::remove_dir_all(&run_dir);
    result
}

#[tauri::command]
async fn fetch_official_laws(
    app: tauri::AppHandle,
    request: LawApiRequest,
) -> Result<Value, String> {
    validate_law_api_request(&request)?;
    if env::consts::OS != "windows" {
        return Err("공식 법령 자동조회는 Windows 앱에서 사용할 수 있습니다.".to_string());
    }
    let run_dir = unique_run_dir(&app, "law-api")?;
    let script_path = run_dir.join("law-open-api.ps1");
    write_utf8_bom(&script_path, LAW_OPEN_API_SCRIPT)?;
    let oc = request.oc.trim().to_string();
    let institution = request.institution.trim().to_string();
    let as_of = request.as_of.trim().to_string();
    let script_for_task = script_path.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_powershell(
            &script_for_task,
            [
                OsStr::new("-Oc"),
                OsStr::new(&oc),
                OsStr::new("-Institution"),
                OsStr::new(&institution),
                OsStr::new("-AsOf"),
                OsStr::new(&as_of),
            ],
        )
    })
    .await
    .map_err(|error| format!("공식 법령 조회 작업이 중단되었습니다: {error}"))??;
    let result = parse_json_output(&output);
    let _ = fs::remove_dir_all(&run_dir);
    result
}

#[tauri::command]
fn list_law_snapshots(app: tauri::AppHandle) -> Result<Value, String> {
    let history = read_law_history(&app)?;
    let snapshots = history
        .get("snapshots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let summaries: Vec<Value> = snapshots
        .iter()
        .map(|snapshot| {
            let graph = snapshot.get("graph");
            let node_count = graph
                .and_then(|value| value.get("nodes"))
                .and_then(Value::as_array)
                .map(|nodes| {
                    nodes
                        .iter()
                        .filter(|node| node.get("kind").and_then(Value::as_str) != Some("institution"))
                        .count()
                })
                .unwrap_or_default();
            let relation_count = graph
                .and_then(|value| value.get("edges"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or_default();
            json!({
                "id": snapshot.get("id"),
                "label": snapshot.get("label"),
                "institution": snapshot.get("institution"),
                "asOf": snapshot.get("asOf"),
                "capturedAt": snapshot.get("capturedAt"),
                "nodeCount": node_count,
                "relationCount": relation_count,
                "lawNames": snapshot.get("laws").and_then(Value::as_array).map(|laws| laws.iter().filter_map(|law| law.get("name")).collect::<Vec<_>>()).unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({
        "schema": "kr.go.mois.orgchart.history-db/v1",
        "path": law_history_file(&app)?.display().to_string(),
        "snapshots": summaries,
    }))
}

#[tauri::command]
fn save_law_snapshot(
    app: tauri::AppHandle,
    request: LawSnapshotRequest,
) -> Result<Value, String> {
    if request.snapshot_json.len() > MAX_LAW_HISTORY_BYTES {
        return Err("저장할 법령 스냅샷이 너무 큽니다.".to_string());
    }
    let mut snapshot: Value = serde_json::from_str(&request.snapshot_json)
        .map_err(|error| format!("법령 스냅샷 JSON이 올바르지 않습니다: {error}"))?;
    if snapshot.get("schema").and_then(Value::as_str) != Some("kr.go.mois.orgchart.history/v1") {
        return Err("지원하지 않는 법령 스냅샷 형식입니다.".to_string());
    }
    let institution = snapshot.get("institution").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let as_of = snapshot.get("asOf").and_then(Value::as_str).unwrap_or("기준일 없음").to_string();
    if institution.is_empty() || snapshot.get("graph").and_then(Value::as_object).is_none() {
        return Err("기관명과 조직 그래프가 있는 스냅샷만 저장할 수 있습니다.".to_string());
    }
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("snapshot-{}", unix_time_millis()));
    let captured_at = snapshot
        .get("capturedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}", unix_time_millis()));
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("id".to_string(), Value::String(id.clone()));
        object.insert("capturedAt".to_string(), Value::String(captured_at));
        if !object.contains_key("label") {
            object.insert("label".to_string(), Value::String(format!("{} · {}", institution, as_of)));
        }
    }
    let mut history = read_law_history(&app)?;
    let snapshots = history
        .get_mut("snapshots")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "법령 이력 DB의 snapshots 배열을 찾지 못했습니다.".to_string())?;
    snapshots.retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    snapshots.push(snapshot.clone());
    snapshots.sort_by(|left, right| {
        right
            .get("asOf")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(left.get("asOf").and_then(Value::as_str).unwrap_or(""))
            .then_with(|| right.get("capturedAt").and_then(Value::as_str).unwrap_or("").cmp(left.get("capturedAt").and_then(Value::as_str).unwrap_or("")))
    });
    if let Some(object) = history.as_object_mut() {
        object.insert("schema".to_string(), Value::String("kr.go.mois.orgchart.history-db/v1".to_string()));
        object.insert("updatedAtUnixMs".to_string(), json!(unix_time_millis()));
    }
    let path = write_law_history(&app, &history)?;
    Ok(json!({
        "saved": true,
        "id": id,
        "path": path.display().to_string(),
        "snapshot": snapshot,
    }))
}

#[tauri::command]
fn load_law_snapshot(
    app: tauri::AppHandle,
    request: LawHistoryItemRequest,
) -> Result<Value, String> {
    let history = read_law_history(&app)?;
    history
        .get("snapshots")
        .and_then(Value::as_array)
        .and_then(|snapshots| snapshots.iter().find(|snapshot| snapshot.get("id").and_then(Value::as_str) == Some(request.id.trim())))
        .cloned()
        .ok_or_else(|| "선택한 법령 스냅샷을 찾지 못했습니다.".to_string())
}

#[tauri::command]
async fn generate_native_hwpx(
    app: tauri::AppHandle,
    request: NativeHwpxRequest,
) -> Result<Value, String> {
    if env::consts::OS != "windows" {
        return Err(
            "편집 가능한 한글 HWPX는 Windows 한글 설치 환경에서 생성할 수 있습니다.".to_string(),
        );
    }
    let (manifest, preflight) = validate_manifest_json(&request.manifest_json)?;
    let manifest_file_name = manifest
        .get("fileName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file_name = sanitize_file_name(if request.file_name.trim().is_empty() {
        manifest_file_name
    } else {
        &request.file_name
    });
    let output_dir = output_directory(&app)?;
    let output_path = unique_output_path(&output_dir, &file_name);

    let run_dir = unique_run_dir(&app, "generate")?;
    let script_path = run_dir.join("hwp-native.ps1");
    let manifest_path = run_dir.join("drawing.native.json");
    write_utf8_bom(&script_path, HWP_NATIVE_SCRIPT)?;
    fs::write(&manifest_path, &request.manifest_json)
        .map_err(|error| format!("작도 명세를 준비하지 못했습니다: {error}"))?;

    let script_for_task = script_path.clone();
    let manifest_for_task = manifest_path.clone();
    let output_for_task = output_path.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_powershell(
            &script_for_task,
            [
                OsStr::new("-Mode"),
                OsStr::new("Generate"),
                OsStr::new("-ManifestPath"),
                manifest_for_task.as_os_str(),
                OsStr::new("-OutputPath"),
                output_for_task.as_os_str(),
            ],
        )
    })
    .await
    .map_err(|error| format!("한글 생성 작업이 중단되었습니다: {error}"))??;

    let mut result = parse_json_output(&output)?;
    let native_manifest_path = companion_path(&output_path, "native.json");
    let verification_report_path = companion_path(&output_path, "verification.json");
    let pretty_manifest = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("재현용 작도 명세를 직렬화하지 못했습니다: {error}"))?;
    fs::write(&native_manifest_path, format!("{pretty_manifest}\n"))
        .map_err(|error| format!("재현용 작도 명세를 저장하지 못했습니다: {error}"))?;
    let opened = request.open_after && launch_output(&output_path);
    if let Some(object) = result.as_object_mut() {
        object.insert("opened".to_string(), Value::Bool(opened));
        object.insert(
            "outputPath".to_string(),
            Value::String(output_path.display().to_string()),
        );
        object.insert(
            "nativeManifestPath".to_string(),
            Value::String(native_manifest_path.display().to_string()),
        );
        object.insert(
            "verificationReportPath".to_string(),
            Value::String(verification_report_path.display().to_string()),
        );
    }
    let verification_document = json!({
        "schema": "kr.go.mois.orgchart.hwp-native-verification/v1",
        "generatedAtUnixMs": unix_time_millis(),
        "manifest": {
            "schema": manifest.get("schema"),
            "title": manifest.get("title"),
            "fileName": manifest.get("fileName"),
            "source": manifest.get("source"),
            "page": manifest.get("page"),
            "verification": manifest.get("verification"),
        },
        "preflight": preflight,
        "result": result.clone(),
    });
    let pretty_verification = serde_json::to_string_pretty(&verification_document)
        .map_err(|error| format!("검증 리포트를 직렬화하지 못했습니다: {error}"))?;
    fs::write(
        &verification_report_path,
        format!("{pretty_verification}\n"),
    )
    .map_err(|error| format!("검증 리포트를 저장하지 못했습니다: {error}"))?;
    let _ = fs::remove_dir_all(&run_dir);
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            sample_native_manifest,
            validate_native_manifest,
            hwp_runtime_info,
            fetch_official_laws,
            list_law_snapshots,
            save_law_snapshot,
            load_law_snapshot,
            generate_native_hwpx,
            open_output_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_writer_keeps_exactly_one_utf8_bom() {
        let directory = env::temp_dir().join(format!("orgchart-bom-test-{}", unix_time_millis()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("probe.ps1");
        write_utf8_bom(&path, "\u{feff}[CmdletBinding()]\nparam()").unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        assert_ne!(&bytes[3..6], &[0xEF, 0xBB, 0xBF]);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn bundled_manifest_passes_native_preflight() {
        let (manifest, report) = validate_manifest_json(SAMPLE_NATIVE_MANIFEST).unwrap();
        assert_eq!(
            manifest.get("schema").and_then(Value::as_str),
            Some(HWP_NATIVE_MANIFEST_SCHEMA)
        );
        assert_eq!(report.get("valid").and_then(Value::as_bool), Some(true));
        assert_eq!(
            report
                .pointer("/summary/connectionWarnings")
                .and_then(Value::as_u64),
            Some(0)
        );
    }

    #[test]
    fn native_preflight_rejects_out_of_page_objects() {
        let mut manifest: Value = serde_json::from_str(SAMPLE_NATIVE_MANIFEST).unwrap();
        let textbox = manifest
            .get_mut("objects")
            .and_then(Value::as_array_mut)
            .unwrap()
            .iter_mut()
            .find(|object| object.get("type").and_then(Value::as_str) == Some("textbox"))
            .unwrap();
        textbox
            .pointer_mut("/geometry/x")
            .map(|value| *value = json!(209.0));
        textbox
            .pointer_mut("/geometry/width")
            .map(|value| *value = json!(10.0));
        assert!(analyze_manifest(&manifest)
            .unwrap_err()
            .contains("A4 용지 밖"));
    }

    #[test]
    fn output_file_name_is_windows_safe_and_bounded() {
        assert_eq!(sanitize_file_name("조직도:검토본"), "조직도-검토본.hwpx");
        assert!(sanitize_file_name(&"가".repeat(200)).chars().count() <= 101);
        assert_eq!(sanitize_file_name("sample.HWPX"), "sample.hwpx");
    }
}
