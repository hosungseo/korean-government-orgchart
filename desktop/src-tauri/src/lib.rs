use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateRequest {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    decree: String,
    #[serde(default)]
    rule: String,
    #[serde(default)]
    json_text: String,
    #[serde(default)]
    institution: String,
    #[serde(default)]
    date: String,
    #[serde(default = "default_paper")]
    paper: String,
    #[serde(default = "default_layout")]
    layout: String,
    #[serde(default)]
    view: String,
    #[serde(default)]
    focus: String,
    #[serde(default)]
    oc: String,
    #[serde(default = "default_true")]
    pptx: bool,
    #[serde(default)]
    routed_pptx: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateResponse {
    svg: String,
    html: String,
    json: String,
    pptx_base64: Option<String>,
    summary: Option<Value>,
}

fn default_paper() -> String {
    "a4-half".to_string()
}

fn default_layout() -> String {
    "best".to_string()
}

fn default_true() -> bool {
    true
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn unique_run_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("앱 캐시 폴더를 찾지 못했습니다: {error}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("실행 시각을 만들지 못했습니다: {error}"))?
        .as_millis();
    let run_dir = cache.join("orgchart-runs").join(format!("{now}"));
    fs::create_dir_all(&run_dir).map_err(|error| format!("임시 폴더를 만들지 못했습니다: {error}"))?;
    Ok(run_dir)
}

fn write_input(run_dir: &Path, name: &str, contents: &str) -> Result<PathBuf, String> {
    let path = run_dir.join(name);
    fs::write(&path, contents).map_err(|error| format!("입력 파일을 저장하지 못했습니다: {error}"))?;
    Ok(path)
}

fn add_common_args(args: &mut Vec<String>, request: &GenerateRequest, output_dir: &Path) {
    args.extend(["--paper".to_string(), request.paper.clone()]);
    args.extend(["--layout".to_string(), request.layout.clone()]);
    args.extend(["--svg".to_string(), output_dir.join("chart.svg").display().to_string()]);
    args.extend(["--html".to_string(), output_dir.join("chart.html").display().to_string()]);
    args.extend(["--json".to_string(), output_dir.join("chart.json").display().to_string()]);
    if let Some(view) = non_empty(&request.view) {
        args.extend(["--view".to_string(), view.to_string()]);
    }
    if let Some(focus) = non_empty(&request.focus) {
        args.extend(["--focus".to_string(), focus.to_string()]);
    }
    if request.routed_pptx {
        args.push("--routed-pptx".to_string());
    }
    if request.pptx {
        args.extend(["--out".to_string(), output_dir.join("chart.pptx").display().to_string()]);
    }
}

fn build_args(request: &GenerateRequest, run_dir: &Path) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    match request.mode.as_str() {
        "api" => {
            let institution = non_empty(&request.institution)
                .ok_or_else(|| "법제처 API 모드에는 기관명이 필요합니다.".to_string())?;
            let date = non_empty(&request.date)
                .ok_or_else(|| "법제처 API 모드에는 기준일이 필요합니다.".to_string())?;
            args.extend(["from-law".to_string(), "--institution".to_string(), institution.to_string()]);
            args.extend(["--date".to_string(), date.to_string()]);
        }
        "json" => {
            if non_empty(&request.json_text).is_none() {
                return Err("조직도 JSON 입력이 비어 있습니다.".to_string());
            }
            let graph_path = write_input(run_dir, "graph.json", &request.json_text)?;
            args.extend(["render-json".to_string(), "--graph".to_string(), graph_path.display().to_string()]);
            if let Some(institution) = non_empty(&request.institution) {
                args.extend(["--title".to_string(), institution.to_string()]);
            }
            if let Some(date) = non_empty(&request.date) {
                args.extend(["--date".to_string(), date.to_string()]);
            }
        }
        _ => {
            if non_empty(&request.decree).is_none() && non_empty(&request.rule).is_none() {
                return Err("직제 또는 시행규칙 문언을 하나 이상 입력하세요.".to_string());
            }
            args.push("build".to_string());
            if let Some(decree) = non_empty(&request.decree) {
                let path = write_input(run_dir, "decree.txt", decree)?;
                args.extend(["--input".to_string(), path.display().to_string()]);
            }
            if let Some(rule) = non_empty(&request.rule) {
                let path = write_input(run_dir, "rule.txt", rule)?;
                args.extend(["--input".to_string(), path.display().to_string()]);
            }
            if let Some(institution) = non_empty(&request.institution) {
                args.extend(["--institution".to_string(), institution.to_string()]);
            }
            if let Some(date) = non_empty(&request.date) {
                args.extend(["--date".to_string(), date.to_string()]);
            }
        }
    }
    add_common_args(&mut args, request, run_dir);
    Ok(args)
}

fn read_required(path: &Path, label: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("{label} 결과를 읽지 못했습니다: {error}"))
}

#[tauri::command]
async fn generate_orgchart(
    app: tauri::AppHandle,
    request: GenerateRequest,
) -> Result<GenerateResponse, String> {
    let run_dir = unique_run_dir(&app)?;
    let args = match build_args(&request, &run_dir) {
        Ok(args) => args,
        Err(error) => {
            let _ = fs::remove_dir_all(&run_dir);
            return Err(error);
        }
    };

    let command = match app.shell().sidecar("orgchart-core") {
        Ok(command) => command.args(args),
        Err(error) => {
            let _ = fs::remove_dir_all(&run_dir);
            return Err(format!("orgchart-core 실행 파일을 찾지 못했습니다. Windows 패키지를 다시 설치하세요: {error}"));
        }
    };
    let command = if let Some(oc) = non_empty(&request.oc) {
        command.env("LAW_API_OC", oc)
    } else {
        command
    };
    let output = match command.output().await {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&run_dir);
            return Err(format!("조직도 엔진을 실행하지 못했습니다: {error}"));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_dir_all(&run_dir);
        return Err(if stderr.is_empty() {
            format!("조직도 엔진이 종료 코드 {:?}로 끝났습니다.", output.status.code())
        } else {
            format!("조직도 엔진 오류: {stderr}")
        });
    }

    let result = (|| -> Result<GenerateResponse, String> {
        let svg = read_required(&run_dir.join("chart.svg"), "SVG")?;
        let html = read_required(&run_dir.join("chart.html"), "HTML")?;
        let json = read_required(&run_dir.join("chart.json"), "JSON")?;
        let summary = serde_json::from_str::<Value>(&json).ok();
        let pptx_base64 = if request.pptx {
            Some(
                BASE64.encode(
                    fs::read(run_dir.join("chart.pptx"))
                        .map_err(|error| format!("PPTX 결과를 읽지 못했습니다: {error}"))?,
                ),
            )
        } else {
            None
        };

        Ok(GenerateResponse {
            svg,
            html,
            json,
            pptx_base64,
            summary,
        })
    })();
    let _ = fs::remove_dir_all(&run_dir);
    result
}

#[tauri::command]
fn runtime_info() -> Value {
    serde_json::json!({
        "name": "직제 기구도 생성기",
        "engine": "orgchart-core sidecar",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![generate_orgchart, runtime_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
