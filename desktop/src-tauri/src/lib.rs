use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const HWP_NATIVE_SCRIPT: &str = include_str!("../resources/hwp-native.ps1");
const SAMPLE_NATIVE_MANIFEST: &str =
    include_str!("../resources/mois-ai-participation-left.native.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHwpxRequest {
    manifest_json: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    open_after: bool,
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
    bytes.extend_from_slice(contents.as_bytes());
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
    name
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

fn validate_manifest_json(contents: &str) -> Result<Value, String> {
    let manifest: Value = serde_json::from_str(contents)
        .map_err(|error| format!("네이티브 작도 명세 JSON이 올바르지 않습니다: {error}"))?;
    if manifest.get("schema").and_then(Value::as_str) != Some("kr.go.mois.orgchart.hwp-native/v1") {
        return Err("지원하지 않는 네이티브 작도 명세입니다.".to_string());
    }
    let objects = manifest
        .get("objects")
        .and_then(Value::as_array)
        .ok_or_else(|| "네이티브 작도 객체가 없습니다.".to_string())?;
    let expected = manifest
        .pointer("/verification/expectedNativeObjectCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "네이티브 객체 검증 기준이 없습니다.".to_string())?;
    if objects.len() as u64 != expected {
        return Err("작도 명세의 객체 수와 검증 기준이 다릅니다.".to_string());
    }
    Ok(manifest)
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
async fn generate_native_hwpx(
    app: tauri::AppHandle,
    request: NativeHwpxRequest,
) -> Result<Value, String> {
    if env::consts::OS != "windows" {
        return Err(
            "편집 가능한 한글 HWPX는 Windows 한글 설치 환경에서 생성할 수 있습니다.".to_string(),
        );
    }
    let manifest = validate_manifest_json(&request.manifest_json)?;
    let manifest_file_name = manifest
        .get("fileName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file_name = sanitize_file_name(if request.file_name.trim().is_empty() {
        manifest_file_name
    } else {
        &request.file_name
    });
    let output_dir = app
        .path()
        .document_dir()
        .map_err(|error| format!("문서 폴더를 찾지 못했습니다: {error}"))?
        .join("직제기구도");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("출력 폴더를 만들지 못했습니다: {error}"))?;
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
    let opened = request.open_after && launch_output(&output_path);
    if let Some(object) = result.as_object_mut() {
        object.insert("opened".to_string(), Value::Bool(opened));
        object.insert(
            "outputPath".to_string(),
            Value::String(output_path.display().to_string()),
        );
    }
    let _ = fs::remove_dir_all(&run_dir);
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            sample_native_manifest,
            hwp_runtime_info,
            generate_native_hwpx,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
