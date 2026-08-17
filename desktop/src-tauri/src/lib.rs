use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::thread;
use tauri::Manager;

const HWP_NATIVE_SCRIPT: &str = include_str!("../resources/hwp-native.ps1");
const LAW_OPEN_API_SCRIPT: &str = include_str!("../resources/law-open-api.ps1");
const SAMPLE_NATIVE_MANIFEST: &str =
    include_str!("../resources/mois-ai-participation-left.native.json");
const HWP_NATIVE_MANIFEST_SCHEMA: &str = "kr.go.mois.orgchart.hwp-native/v1";
const MAX_MANIFEST_BYTES: usize = 10 * 1024 * 1024;
const MAX_NATIVE_OBJECTS: usize = 5_000;
const MAX_LAW_HISTORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMPARISON_VIDEO_BYTES: usize = 100 * 1024 * 1024;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComparisonVideoRequest {
    video_base64: String,
    mime_type: String,
    #[serde(default)]
    file_name: String,
    manifest_json: String,
    metadata_json: String,
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
    // 한글 COM 호출이 모달 대화상자(보안 승인 등)에 걸리면 응답 없이 영구
    // 대기한다. 타임아웃을 두고 초과 시 프로세스를 종료해 앱이 함께 멈추는
    // 것을 막는다.
    const POWERSHELL_TIMEOUT_SECS: u64 = 600;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("한글 Automation 모듈을 실행하지 못했습니다: {error}"))?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_thread = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(ref mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });
    let stderr_thread = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(ref mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });
    let deadline = Instant::now() + Duration::from_secs(POWERSHELL_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(format!(
                        "한글 자동화가 {POWERSHELL_TIMEOUT_SECS}초 안에 끝나지 않아 중단했습니다. 한글 창에 떠 있는 대화상자(파일 접근 승인·보안모듈 등)를 닫고, 생성 중에는 한글 창을 조작하지 말고 다시 시도하세요."
                    ));
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => {
                return Err(format!("한글 Automation 상태를 확인하지 못했습니다: {error}"));
            }
        }
    };
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    Ok(Output { status, stdout, stderr })
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
    if institution.len() < 2 || institution.len() > 100 || institution.chars().any(char::is_control)
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

fn comparison_video_extension(mime_type: &str) -> Result<(&'static str, &'static str), String> {
    let normalized = mime_type.trim().to_ascii_lowercase();
    if normalized == "video/mp4" || normalized.starts_with("video/mp4;") {
        return Ok(("mp4", "MP4"));
    }
    if normalized == "video/webm" || normalized.starts_with("video/webm;") {
        return Ok(("webm", "WebM"));
    }
    Err("영상 형식은 MP4 또는 WebM이어야 합니다.".to_string())
}

fn sanitize_video_file_name(value: &str, extension: &str) -> String {
    let source = if value.trim().is_empty() {
        "정부조직-조직개편-애니메이션"
    } else {
        value.trim()
    };
    let source_stem = Path::new(source)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("정부조직-조직개편-애니메이션");
    let mut stem: String = source_stem
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
    stem = stem.trim_matches([' ', '.']).chars().take(96).collect();
    if stem.trim().is_empty() {
        stem = "정부조직-조직개편-애니메이션".to_string();
    }
    format!("{stem}.{extension}")
}

fn decode_comparison_video(
    request: &ComparisonVideoRequest,
) -> Result<(Vec<u8>, &'static str, &'static str), String> {
    let (extension, media_type) = comparison_video_extension(&request.mime_type)?;
    let encoded_limit = MAX_COMPARISON_VIDEO_BYTES.saturating_mul(4) / 3 + 8;
    if request.video_base64.len() > encoded_limit {
        return Err("영상 파일은 100MB를 초과할 수 없습니다.".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(request.video_base64.trim())
        .map_err(|error| format!("영상 데이터를 해독하지 못했습니다: {error}"))?;
    if bytes.is_empty() {
        return Err("저장할 영상 데이터가 비어 있습니다.".to_string());
    }
    if bytes.len() > MAX_COMPARISON_VIDEO_BYTES {
        return Err("영상 파일은 100MB를 초과할 수 없습니다.".to_string());
    }
    Ok((bytes, extension, media_type))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_comparison_video_metadata(
    metadata: &Value,
    columns: u64,
    mime_type: &str,
) -> Result<(), String> {
    let video = metadata
        .get("video")
        .and_then(Value::as_object)
        .ok_or_else(|| "영상 메타데이터에 video 정보가 없습니다.".to_string())?;
    let width = video
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let height = video
        .get("height")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let fps = video.get("fps").and_then(Value::as_u64).unwrap_or_default();
    if width != 1680 || height != 1188 || fps != 30 {
        return Err("영상 메타데이터는 1680×1188·30fps여야 합니다.".to_string());
    }
    let duration = video
        .get("durationSeconds")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (5.0..=60.0).contains(value))
        .ok_or_else(|| "영상 길이 메타데이터가 올바르지 않습니다.".to_string())?;
    let frame_count = video
        .get("frameCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "영상 프레임 수 메타데이터가 없습니다.".to_string())?;
    if frame_count != (duration * fps as f64).round() as u64 {
        return Err("영상 길이와 30fps 프레임 수가 일치하지 않습니다.".to_string());
    }
    if video.get("frameCountKind").and_then(Value::as_str) != Some("requested-render-frames") {
        return Err("영상 프레임 수의 의미가 명시되지 않았습니다.".to_string());
    }
    let expected_duration = if columns == 4 { 14.0 } else { 10.8 };
    if (duration - expected_duration).abs() > 0.01 {
        return Err(format!(
            "{columns}단 영상 길이는 {expected_duration:.1}초여야 합니다."
        ));
    }
    let capture_mode = video
        .get("captureMode")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !matches!(
        capture_mode,
        "manual-request-frame" | "automatic-canvas-stream"
    ) {
        return Err("지원하지 않는 영상 프레임 캡처 방식입니다.".to_string());
    }
    let frame_rate_locked = video
        .get("frameRateLocked")
        .and_then(Value::as_bool)
        .ok_or_else(|| "프레임 고정 여부 메타데이터가 없습니다.".to_string())?;
    if frame_rate_locked != (capture_mode == "manual-request-frame") {
        return Err("프레임 캡처 방식과 고정 여부가 일치하지 않습니다.".to_string());
    }
    let recorded_wall_clock = video
        .get("recordedWallClockSeconds")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 120.0);
    if recorded_wall_clock.is_none() {
        return Err("실제 녹화 시간 메타데이터가 올바르지 않습니다.".to_string());
    }
    if video.get("mimeType").and_then(Value::as_str) != Some(mime_type) {
        return Err("영상 코덱과 메타데이터의 MIME 형식이 일치하지 않습니다.".to_string());
    }
    Ok(())
}

#[derive(Debug)]
struct VideoBundlePaths {
    video: PathBuf,
    native_manifest: PathBuf,
    metadata: PathBuf,
}

#[derive(Debug)]
struct HwpxBundlePaths {
    hwpx: PathBuf,
    native_manifest: PathBuf,
    verification: PathBuf,
    legal_evidence: PathBuf,
}

fn temporary_bundle_path(path: &Path, token: &str) -> PathBuf {
    let name = path.file_name().and_then(OsStr::to_str).unwrap_or("video");
    path.with_file_name(format!(".{name}.{token}.part"))
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("임시 저장 파일을 만들지 못했습니다: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("임시 저장 파일을 쓰지 못했습니다: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("임시 저장 파일을 디스크에 반영하지 못했습니다: {error}"))
}

fn remove_files(paths: &[&Path]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn write_atomic_video_bundle(
    output_path: &Path,
    bytes: &[u8],
    native_manifest: &str,
    metadata: &str,
) -> Result<(VideoBundlePaths, String), String> {
    let native_manifest_path = companion_path(output_path, "video.native.json");
    let metadata_path = companion_path(output_path, "video.json");
    if [
        output_path,
        native_manifest_path.as_path(),
        metadata_path.as_path(),
    ]
    .iter()
    .any(|path| path.exists())
    {
        return Err("같은 이름의 영상 묶음이 이미 존재합니다.".to_string());
    }
    let token = format!("{}-{}", std::process::id(), unix_time_millis());
    let temporary_video = temporary_bundle_path(output_path, &token);
    let temporary_manifest = temporary_bundle_path(&native_manifest_path, &token);
    let temporary_metadata = temporary_bundle_path(&metadata_path, &token);
    let temporary_paths = [
        temporary_video.as_path(),
        temporary_manifest.as_path(),
        temporary_metadata.as_path(),
    ];
    let result = (|| {
        write_new_synced(&temporary_video, bytes)?;
        let read_back = fs::read(&temporary_video)
            .map_err(|error| format!("임시 영상 파일을 다시 읽지 못했습니다: {error}"))?;
        let expected_sha256 = sha256_hex(bytes);
        if read_back.len() != bytes.len() || sha256_hex(&read_back) != expected_sha256 {
            return Err("저장한 영상의 SHA-256 무결성 검증에 실패했습니다.".to_string());
        }
        write_new_synced(&temporary_manifest, native_manifest.as_bytes())?;
        write_new_synced(&temporary_metadata, metadata.as_bytes())?;

        let promotions = [
            (temporary_video.as_path(), output_path),
            (temporary_manifest.as_path(), native_manifest_path.as_path()),
            (temporary_metadata.as_path(), metadata_path.as_path()),
        ];
        let mut promoted: Vec<&Path> = Vec::new();
        for (temporary, final_path) in promotions {
            if let Err(error) = fs::rename(temporary, final_path) {
                remove_files(&promoted);
                return Err(format!(
                    "영상 묶음을 최종 경로로 확정하지 못했습니다: {error}"
                ));
            }
            promoted.push(final_path);
        }
        Ok((
            VideoBundlePaths {
                video: output_path.to_path_buf(),
                native_manifest: native_manifest_path.clone(),
                metadata: metadata_path.clone(),
            },
            expected_sha256,
        ))
    })();
    if result.is_err() {
        remove_files(&temporary_paths);
        remove_files(&[
            output_path,
            native_manifest_path.as_path(),
            metadata_path.as_path(),
        ]);
    }
    result
}

fn temporary_hwpx_path(path: &Path, token: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    path.with_file_name(format!(".{stem}.{token}.partial.hwpx"))
}

fn hwpx_bundle_path_available(path: &Path) -> bool {
    !path.exists()
        && !companion_path(path, "native.json").exists()
        && !companion_path(path, "verification.json").exists()
        && !companion_path(path, "legal-evidence.json").exists()
}

fn write_atomic_hwpx_bundle(
    staged_hwpx: &Path,
    output_path: &Path,
    native_manifest: &str,
    verification: &str,
    legal_evidence: &str,
) -> Result<(HwpxBundlePaths, String), String> {
    let native_manifest_path = companion_path(output_path, "native.json");
    let verification_path = companion_path(output_path, "verification.json");
    let legal_evidence_path = companion_path(output_path, "legal-evidence.json");
    if !staged_hwpx.is_file() {
        return Err("검증할 임시 HWPX 파일이 없습니다.".to_string());
    }
    if !hwpx_bundle_path_available(output_path) {
        return Err("같은 이름의 HWPX 검증 묶음이 이미 존재합니다.".to_string());
    }
    let bytes = fs::read(staged_hwpx)
        .map_err(|error| format!("임시 HWPX를 다시 읽지 못했습니다: {error}"))?;
    if bytes.is_empty() {
        return Err("한글이 저장한 HWPX가 비어 있습니다.".to_string());
    }
    let expected_sha256 = sha256_hex(&bytes);
    let token = format!("{}-{}", std::process::id(), unix_time_millis());
    let temporary_manifest = temporary_bundle_path(&native_manifest_path, &token);
    let temporary_verification = temporary_bundle_path(&verification_path, &token);
    let temporary_evidence = temporary_bundle_path(&legal_evidence_path, &token);
    let temporary_paths = [
        staged_hwpx,
        temporary_manifest.as_path(),
        temporary_verification.as_path(),
        temporary_evidence.as_path(),
    ];
    let result = (|| {
        write_new_synced(&temporary_manifest, native_manifest.as_bytes())?;
        write_new_synced(&temporary_verification, verification.as_bytes())?;
        write_new_synced(&temporary_evidence, legal_evidence.as_bytes())?;

        let read_back = fs::read(staged_hwpx)
            .map_err(|error| format!("임시 HWPX를 무결성 검사하지 못했습니다: {error}"))?;
        if read_back.len() != bytes.len() || sha256_hex(&read_back) != expected_sha256 {
            return Err("저장한 HWPX의 SHA-256 무결성 검증에 실패했습니다.".to_string());
        }

        let promotions = [
            (staged_hwpx, output_path),
            (temporary_manifest.as_path(), native_manifest_path.as_path()),
            (
                temporary_verification.as_path(),
                verification_path.as_path(),
            ),
            (temporary_evidence.as_path(), legal_evidence_path.as_path()),
        ];
        let mut promoted: Vec<&Path> = Vec::new();
        for (temporary, final_path) in promotions {
            if let Err(error) = fs::rename(temporary, final_path) {
                remove_files(&promoted);
                return Err(format!(
                    "HWPX 검증 묶음을 최종 경로로 확정하지 못했습니다: {error}"
                ));
            }
            promoted.push(final_path);
        }
        Ok((
            HwpxBundlePaths {
                hwpx: output_path.to_path_buf(),
                native_manifest: native_manifest_path.clone(),
                verification: verification_path.clone(),
                legal_evidence: legal_evidence_path.clone(),
            },
            expected_sha256,
        ))
    })();
    if result.is_err() {
        remove_files(&temporary_paths);
        remove_files(&[
            output_path,
            native_manifest_path.as_path(),
            verification_path.as_path(),
            legal_evidence_path.as_path(),
        ]);
    }
    result
}

#[cfg(test)]
fn unique_output_path(directory: &Path, file_name: &str) -> PathBuf {
    let desired = directory.join(file_name);
    if !desired.exists() {
        return desired;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let stem = desired
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    let extension = desired
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty());
    for attempt in 0..1_000_u16 {
        let suffix = if attempt == 0 {
            timestamp.to_string()
        } else {
            format!("{timestamp}-{attempt}")
        };
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem}-{suffix}.{extension}")),
            None => directory.join(format!("{stem}-{suffix}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    match extension {
        Some(extension) => directory.join(format!("{stem}-{timestamp}-overflow.{extension}")),
        None => directory.join(format!("{stem}-{timestamp}-overflow")),
    }
}

fn unique_hwpx_output_path(directory: &Path, file_name: &str) -> PathBuf {
    let desired = directory.join(file_name);
    if hwpx_bundle_path_available(&desired) {
        return desired;
    }
    let timestamp = unix_time_millis();
    let stem = desired
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    for attempt in 0..1_000_u16 {
        let suffix = if attempt == 0 {
            timestamp.to_string()
        } else {
            format!("{timestamp}-{attempt}")
        };
        let candidate = directory.join(format!("{stem}-{suffix}.hwpx"));
        if hwpx_bundle_path_available(&candidate) {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{timestamp}-overflow.hwpx"))
}

fn video_bundle_path_available(path: &Path) -> bool {
    !path.exists()
        && !companion_path(path, "video.native.json").exists()
        && !companion_path(path, "video.json").exists()
}

fn unique_video_output_path(directory: &Path, file_name: &str) -> PathBuf {
    let desired = directory.join(file_name);
    if video_bundle_path_available(&desired) {
        return desired;
    }
    let timestamp = unix_time_millis();
    let stem = desired
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("정부조직-조직개편-애니메이션");
    let extension = desired
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty());
    for attempt in 0..1_000_u16 {
        let suffix = if attempt == 0 {
            timestamp.to_string()
        } else {
            format!("{timestamp}-{attempt}")
        };
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem}-{suffix}.{extension}")),
            None => directory.join(format!("{stem}-{suffix}")),
        };
        if video_bundle_path_available(&candidate) {
            return candidate;
        }
    }
    match extension {
        Some(extension) => directory.join(format!("{stem}-{timestamp}-overflow.{extension}")),
        None => directory.join(format!("{stem}-{timestamp}-overflow")),
    }
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
    fs::write(&temporary, &contents)
        .map_err(|error| format!("법령 이력을 저장하지 못했습니다: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("법령 이력 DB를 교체하지 못했습니다: {error}"))?;
    Ok(path)
}

fn companion_path(output_path: &Path, suffix: &str) -> PathBuf {
    let stem = output_path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("편집형-조직도");
    output_path.with_file_name(format!("{stem}.{suffix}"))
}

fn legal_evidence_document(manifest: &Value) -> Value {
    let source = manifest.get("source").cloned().unwrap_or(Value::Null);
    let mut seen = HashSet::new();
    let mut line_evidence = Vec::new();
    for object in manifest
        .get("objects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(metadata) = object.get("metadata").and_then(Value::as_object) else {
            continue;
        };
        if metadata.get("role").and_then(Value::as_str) != Some("correspondence-link") {
            continue;
        }
        let from = metadata.get("from").and_then(Value::as_str).unwrap_or("");
        let to = metadata.get("to").and_then(Value::as_str).unwrap_or("");
        let basis = metadata.get("basis").and_then(Value::as_str).unwrap_or("");
        if from.is_empty() || to.is_empty() {
            continue;
        }
        let key = format!("{from}>{to}|{basis}");
        if !seen.insert(key) {
            continue;
        }
        line_evidence.push(Value::Object(metadata.clone()));
    }
    let duty_fact_count = source
        .get("dutyFactCount")
        .and_then(Value::as_u64)
        .map(|count| count as usize)
        .or_else(|| {
            source
                .get("dutyFacts")
                .and_then(Value::as_array)
                .map(|items| {
                    if items.iter().any(|item| item.get("facts").is_some()) {
                        items
                            .iter()
                            .filter_map(|stage| stage.get("facts").and_then(Value::as_array))
                            .map(Vec::len)
                            .sum()
                    } else {
                        items.len()
                    }
                })
        })
        .unwrap_or_default();
    json!({
        "schema": "kr.go.mois.orgchart.legal-evidence/v1",
        "generatedAtUnixMs": unix_time_millis(),
        "manifest": {
            "schema": manifest.get("schema"),
            "title": manifest.get("title"),
            "fileName": manifest.get("fileName"),
        },
        "source": source,
        "lineEvidence": line_evidence,
        "stats": {
            "dutyFactCount": duty_fact_count,
            "lineEvidenceCount": seen.len(),
        },
    })
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
    let page_width = required_number(page, "widthMm", "용지")?;
    let page_height = required_number(page, "heightMm", "용지")?;
    let paper = page.get("paper").and_then(Value::as_str).unwrap_or("");
    let orientation = page
        .get("orientation")
        .and_then(Value::as_str)
        .unwrap_or("");
    let a4_portrait = paper == "A4"
        && orientation == "portrait"
        && (page_width - 210.0).abs() <= PAGE_TOLERANCE_MM
        && (page_height - 297.0).abs() <= PAGE_TOLERANCE_MM;
    let a3_landscape = paper == "A3"
        && orientation == "landscape"
        && (page_width - 420.0).abs() <= PAGE_TOLERANCE_MM
        && (page_height - 297.0).abs() <= PAGE_TOLERANCE_MM;
    if !a4_portrait && !a3_landscape {
        return Err("현재 앱은 A4 세로 또는 A3 가로 명세를 지원합니다.".to_string());
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
                return Err(format!("{object_id} 선이 용지 밖으로 나갑니다."));
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
                return Err(format!("{object_id} 객체가 용지 밖으로 나갑니다."));
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
            "paper": paper,
            "orientation": orientation,
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
fn save_law_snapshot(app: tauri::AppHandle, request: LawSnapshotRequest) -> Result<Value, String> {
    if request.snapshot_json.len() > MAX_LAW_HISTORY_BYTES {
        return Err("저장할 법령 스냅샷이 너무 큽니다.".to_string());
    }
    let mut snapshot: Value = serde_json::from_str(&request.snapshot_json)
        .map_err(|error| format!("법령 스냅샷 JSON이 올바르지 않습니다: {error}"))?;
    if snapshot.get("schema").and_then(Value::as_str) != Some("kr.go.mois.orgchart.history/v1") {
        return Err("지원하지 않는 법령 스냅샷 형식입니다.".to_string());
    }
    let institution = snapshot
        .get("institution")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let as_of = snapshot
        .get("asOf")
        .and_then(Value::as_str)
        .unwrap_or("기준일 없음")
        .to_string();
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
            object.insert(
                "label".to_string(),
                Value::String(format!("{} · {}", institution, as_of)),
            );
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
            .then_with(|| {
                right
                    .get("capturedAt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(left.get("capturedAt").and_then(Value::as_str).unwrap_or(""))
            })
    });
    if let Some(object) = history.as_object_mut() {
        object.insert(
            "schema".to_string(),
            Value::String("kr.go.mois.orgchart.history-db/v1".to_string()),
        );
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
        .and_then(|snapshots| {
            snapshots.iter().find(|snapshot| {
                snapshot.get("id").and_then(Value::as_str) == Some(request.id.trim())
            })
        })
        .cloned()
        .ok_or_else(|| "선택한 법령 스냅샷을 찾지 못했습니다.".to_string())
}

#[tauri::command]
fn save_comparison_video(
    app: tauri::AppHandle,
    request: ComparisonVideoRequest,
) -> Result<Value, String> {
    let (bytes, extension, media_type) = decode_comparison_video(&request)?;
    let (manifest, preflight) = validate_manifest_json(&request.manifest_json)?;
    let page = manifest
        .get("page")
        .and_then(Value::as_object)
        .ok_or_else(|| "영상 원본의 용지 정보를 찾지 못했습니다.".to_string())?;
    let columns = manifest
        .pointer("/source/columns")
        .and_then(Value::as_u64)
        .or_else(|| {
            manifest
                .pointer("/source/stageAsOf")
                .and_then(Value::as_array)
                .map(|items| items.len() as u64)
        })
        .unwrap_or_default();
    if page.get("paper").and_then(Value::as_str) != Some("A3")
        || page.get("orientation").and_then(Value::as_str) != Some("landscape")
        || !(3..=4).contains(&columns)
    {
        return Err("영상 원본은 3~4단 A3 가로 대비표여야 합니다.".to_string());
    }
    let mut metadata: Value = serde_json::from_str(&request.metadata_json)
        .map_err(|error| format!("영상 메타데이터 JSON이 올바르지 않습니다: {error}"))?;
    if metadata.get("schema").and_then(Value::as_str)
        != Some("kr.go.mois.orgchart.comparison-video/v1")
    {
        return Err("지원하지 않는 영상 메타데이터 형식입니다.".to_string());
    }
    validate_comparison_video_metadata(&metadata, columns, &request.mime_type)?;
    let expected_sha256 = sha256_hex(&bytes);
    if let Some(object) = metadata.as_object_mut() {
        object.insert("savedAtUnixMs".to_string(), json!(unix_time_millis()));
        object.insert("preflight".to_string(), preflight);
        object.insert(
            "mediaType".to_string(),
            Value::String(media_type.to_string()),
        );
        object.insert("bytes".to_string(), json!(bytes.len()));
        object.insert(
            "integrity".to_string(),
            json!({
                "algorithm": "SHA-256",
                "sha256": expected_sha256.clone(),
                "verified": true,
                "readBack": true,
            }),
        );
        object.insert(
            "storage".to_string(),
            json!({
                "atomicBundle": true,
                "files": 3,
            }),
        );
    }
    let file_name = sanitize_video_file_name(&request.file_name, extension);
    let output_dir = output_directory(&app)?;
    let output_path = unique_video_output_path(&output_dir, &file_name);
    let pretty_manifest = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("영상 원본 명세를 직렬화하지 못했습니다: {error}"))?;
    let pretty_metadata = serde_json::to_string_pretty(&metadata)
        .map_err(|error| format!("영상 메타데이터를 직렬화하지 못했습니다: {error}"))?;
    let (paths, verified_sha256) = write_atomic_video_bundle(
        &output_path,
        &bytes,
        &format!("{pretty_manifest}\n"),
        &format!("{pretty_metadata}\n"),
    )?;
    if verified_sha256 != expected_sha256 {
        remove_files(&[
            paths.video.as_path(),
            paths.native_manifest.as_path(),
            paths.metadata.as_path(),
        ]);
        return Err("최종 영상 해시가 예상값과 일치하지 않습니다.".to_string());
    }
    let opened = request.open_after && launch_output(&paths.video);
    Ok(json!({
        "saved": true,
        "opened": opened,
        "outputPath": paths.video.display().to_string(),
        "nativeManifestPath": paths.native_manifest.display().to_string(),
        "metadataPath": paths.metadata.display().to_string(),
        "mediaType": media_type,
        "mimeType": request.mime_type,
        "bytes": bytes.len(),
        "columns": columns,
        "sha256": verified_sha256,
        "verified": true,
        "atomicBundle": true,
    }))
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
    let output_path = unique_hwpx_output_path(&output_dir, &file_name);
    let staging_token = format!("{}-{}", std::process::id(), unix_time_millis());
    let staged_output_path = temporary_hwpx_path(&output_path, &staging_token);

    let run_dir = unique_run_dir(&app, "generate")?;
    let script_path = run_dir.join("hwp-native.ps1");
    let manifest_path = run_dir.join("drawing.native.json");
    write_utf8_bom(&script_path, HWP_NATIVE_SCRIPT)?;
    fs::write(&manifest_path, &request.manifest_json)
        .map_err(|error| format!("작도 명세를 준비하지 못했습니다: {error}"))?;

    let script_for_task = script_path.clone();
    let manifest_for_task = manifest_path.clone();
    let output_for_task = staged_output_path.clone();
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
    if result.get("verified").and_then(Value::as_bool) != Some(true) {
        let _ = fs::remove_file(&staged_output_path);
        let _ = fs::remove_dir_all(&run_dir);
        return Err("저장한 HWPX의 쪽수 또는 네이티브 객체 수가 명세와 일치하지 않아 최종 파일로 확정하지 않았습니다.".to_string());
    }
    let native_manifest_path = companion_path(&output_path, "native.json");
    let verification_report_path = companion_path(&output_path, "verification.json");
    let legal_evidence_path = companion_path(&output_path, "legal-evidence.json");
    let pretty_manifest = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("재현용 작도 명세를 직렬화하지 못했습니다: {error}"))?;
    let staged_hwpx_bytes = fs::read(&staged_output_path)
        .map_err(|error| format!("검증된 임시 HWPX를 읽지 못했습니다: {error}"))?;
    let expected_sha256 = sha256_hex(&staged_hwpx_bytes);
    if let Some(object) = result.as_object_mut() {
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
        object.insert(
            "legalEvidencePath".to_string(),
            Value::String(legal_evidence_path.display().to_string()),
        );
        object.insert("sha256".to_string(), Value::String(expected_sha256.clone()));
        object.insert("integrityVerified".to_string(), Value::Bool(true));
        object.insert("atomicBundle".to_string(), Value::Bool(true));
    }
    let evidence_document = legal_evidence_document(&manifest);
    let pretty_evidence = serde_json::to_string_pretty(&evidence_document)
        .map_err(|error| format!("법령 근거 리포트를 직렬화하지 못했습니다: {error}"))?;
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
        "integrity": {
            "sha256": expected_sha256,
            "readBackVerified": true,
            "atomicBundle": true,
        },
        "preflight": preflight,
        "result": result.clone(),
    });
    let pretty_verification = serde_json::to_string_pretty(&verification_document)
        .map_err(|error| format!("검증 리포트를 직렬화하지 못했습니다: {error}"))?;
    let (bundle_paths, verified_sha256) = write_atomic_hwpx_bundle(
        &staged_output_path,
        &output_path,
        &format!("{pretty_manifest}\n"),
        &format!("{pretty_verification}\n"),
        &format!("{pretty_evidence}\n"),
    )?;
    if verified_sha256 != sha256_hex(&staged_hwpx_bytes) {
        remove_files(&[
            bundle_paths.hwpx.as_path(),
            bundle_paths.native_manifest.as_path(),
            bundle_paths.verification.as_path(),
            bundle_paths.legal_evidence.as_path(),
        ]);
        let _ = fs::remove_dir_all(&run_dir);
        return Err("HWPX 최종 확정 전후의 SHA-256이 일치하지 않습니다.".to_string());
    }
    let opened = request.open_after && launch_output(&bundle_paths.hwpx);
    if let Some(object) = result.as_object_mut() {
        object.insert("opened".to_string(), Value::Bool(opened));
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
            validate_native_manifest,
            hwp_runtime_info,
            fetch_official_laws,
            list_law_snapshots,
            save_law_snapshot,
            load_law_snapshot,
            save_comparison_video,
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
        assert!(analyze_manifest(&manifest).unwrap_err().contains("용지 밖"));
    }

    #[test]
    fn output_file_name_is_windows_safe_and_bounded() {
        assert_eq!(sanitize_file_name("조직도:검토본"), "조직도-검토본.hwpx");
        assert!(sanitize_file_name(&"가".repeat(200)).chars().count() <= 101);
        assert_eq!(sanitize_file_name("sample.HWPX"), "sample.hwpx");
    }

    #[test]
    fn comparison_video_file_name_forces_supported_extension() {
        assert_eq!(
            sanitize_video_file_name("문화체육관광부:4단.mp4", "mp4"),
            "문화체육관광부-4단.mp4"
        );
        assert_eq!(
            sanitize_video_file_name("..\\위험/경로.webm", "webm"),
            "경로.webm"
        );
        assert!(
            sanitize_video_file_name(&"가".repeat(200), "mp4")
                .chars()
                .count()
                <= 100
        );
    }

    #[test]
    fn unique_output_path_keeps_the_requested_media_extension() {
        let directory =
            env::temp_dir().join(format!("orgchart-video-path-test-{}", unix_time_millis()));
        fs::create_dir_all(&directory).unwrap();
        let original = directory.join("comparison.mp4");
        fs::write(&original, b"first").unwrap();

        let next = unique_output_path(&directory, "comparison.mp4");
        assert_eq!(next.extension().and_then(OsStr::to_str), Some("mp4"));
        assert_ne!(next, original);

        let orphan_video = directory.join("orphan.mp4");
        fs::write(companion_path(&orphan_video, "video.json"), b"{}").unwrap();
        let next_bundle = unique_video_output_path(&directory, "orphan.mp4");
        assert_ne!(next_bundle, orphan_video);
        assert_eq!(next_bundle.extension().and_then(OsStr::to_str), Some("mp4"));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn comparison_video_metadata_requires_exact_a3_frame_contract() {
        let metadata = json!({
            "video": {
                "width": 1680,
                "height": 1188,
                "fps": 30,
                "durationSeconds": 14.0,
                "frameCount": 420,
                "frameCountKind": "requested-render-frames",
                "captureMode": "manual-request-frame",
                "frameRateLocked": true,
                "recordedWallClockSeconds": 14.02,
                "mimeType": "video/mp4;codecs=avc1.42E01E"
            }
        });
        validate_comparison_video_metadata(&metadata, 4, "video/mp4;codecs=avc1.42E01E").unwrap();

        let mut invalid = metadata.clone();
        invalid
            .pointer_mut("/video/frameCount")
            .map(|value| *value = json!(419));
        assert!(
            validate_comparison_video_metadata(&invalid, 4, "video/mp4;codecs=avc1.42E01E")
                .unwrap_err()
                .contains("프레임 수")
        );
    }

    #[test]
    fn comparison_video_bundle_is_read_back_hashed_and_promoted_together() {
        let directory =
            env::temp_dir().join(format!("orgchart-video-bundle-test-{}", unix_time_millis()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("comparison.mp4");
        let bytes = b"deterministic-video-bytes";

        let (paths, digest) =
            write_atomic_video_bundle(&output, bytes, "{\"manifest\":true}\n", "{\"meta\":true}\n")
                .unwrap();
        assert_eq!(digest, sha256_hex(bytes));
        assert_eq!(fs::read(&paths.video).unwrap(), bytes);
        assert!(paths.native_manifest.exists());
        assert!(paths.metadata.exists());
        assert_eq!(
            fs::read_dir(&directory)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
                .count(),
            0
        );
        assert!(write_atomic_video_bundle(&output, bytes, "{}", "{}")
            .unwrap_err()
            .contains("이미 존재"));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn hwpx_bundle_is_read_back_hashed_and_promoted_with_legal_evidence() {
        let directory =
            env::temp_dir().join(format!("orgchart-hwpx-bundle-test-{}", unix_time_millis()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("comparison.hwpx");
        let staged = temporary_hwpx_path(&output, "test");
        let bytes = b"deterministic-hwpx-package-bytes";
        fs::write(&staged, bytes).unwrap();

        let (paths, digest) = write_atomic_hwpx_bundle(
            &staged,
            &output,
            "{\"manifest\":true}\n",
            "{\"verified\":true}\n",
            "{\"evidence\":true}\n",
        )
        .unwrap();
        assert_eq!(digest, sha256_hex(bytes));
        assert_eq!(fs::read(&paths.hwpx).unwrap(), bytes);
        assert!(paths.native_manifest.exists());
        assert!(paths.verification.exists());
        assert!(paths.legal_evidence.exists());
        assert!(!staged.exists());
        assert_eq!(
            fs::read_dir(&directory)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
                .count(),
            0
        );

        let orphan = directory.join("orphan.hwpx");
        fs::write(companion_path(&orphan, "legal-evidence.json"), b"{}").unwrap();
        assert_ne!(unique_hwpx_output_path(&directory, "orphan.hwpx"), orphan);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn legal_evidence_report_deduplicates_line_segments_and_counts_stage_facts() {
        let metadata = json!({
            "role": "correspondence-link",
            "from": "기후문화정책과",
            "to": "녹색문화기획과",
            "basis": "duty-function",
            "confidence": 0.94,
            "matchedFunctions": 2,
            "sourceFunctions": 4,
        });
        let manifest = json!({
            "schema": HWP_NATIVE_MANIFEST_SCHEMA,
            "title": "기능 근거 대비",
            "source": {
                "dutyFactCount": 2,
                "dutyFacts": [
                    { "asOf": "2025-01-01", "facts": [{"id":"a"}] },
                    { "asOf": "2026-01-01", "facts": [{"id":"b"}] }
                ]
            },
            "objects": [
                { "type": "line", "metadata": metadata.clone() },
                { "type": "line", "metadata": metadata }
            ]
        });
        let report = legal_evidence_document(&manifest);
        assert_eq!(
            report
                .pointer("/stats/dutyFactCount")
                .and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            report
                .pointer("/stats/lineEvidenceCount")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            report
                .get("lineEvidence")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn native_preflight_reports_a3_landscape_without_relabeling_it_as_a4() {
        let mut manifest: Value = serde_json::from_str(SAMPLE_NATIVE_MANIFEST).unwrap();
        manifest
            .pointer_mut("/page/paper")
            .map(|value| *value = json!("A3"));
        manifest
            .pointer_mut("/page/orientation")
            .map(|value| *value = json!("landscape"));
        manifest
            .pointer_mut("/page/widthMm")
            .map(|value| *value = json!(420.0));
        manifest
            .pointer_mut("/page/heightMm")
            .map(|value| *value = json!(297.0));

        let report = analyze_manifest(&manifest).unwrap();
        assert_eq!(
            report.pointer("/summary/paper").and_then(Value::as_str),
            Some("A3")
        );
        assert_eq!(
            report
                .pointer("/summary/orientation")
                .and_then(Value::as_str),
            Some("landscape")
        );
    }

    #[test]
    fn comparison_video_payload_accepts_mp4_and_rejects_unknown_media() {
        let request = ComparisonVideoRequest {
            video_base64: BASE64_STANDARD.encode(b"video-bytes"),
            mime_type: "video/mp4;codecs=avc1.42E01E".to_string(),
            file_name: "sample.mp4".to_string(),
            manifest_json: "{}".to_string(),
            metadata_json: "{}".to_string(),
            open_after: false,
        };
        let (bytes, extension, media_type) = decode_comparison_video(&request).unwrap();
        assert_eq!(bytes, b"video-bytes");
        assert_eq!(extension, "mp4");
        assert_eq!(media_type, "MP4");

        let invalid = ComparisonVideoRequest {
            mime_type: "video/avi".to_string(),
            ..request
        };
        assert!(decode_comparison_video(&invalid)
            .unwrap_err()
            .contains("MP4 또는 WebM"));

        let spoofed = ComparisonVideoRequest {
            video_base64: BASE64_STANDARD.encode(b"video-bytes"),
            mime_type: "video/mp4-malicious".to_string(),
            file_name: "sample.mp4".to_string(),
            manifest_json: "{}".to_string(),
            metadata_json: "{}".to_string(),
            open_after: false,
        };
        assert!(decode_comparison_video(&spoofed)
            .unwrap_err()
            .contains("MP4 또는 WebM"));
    }
}
