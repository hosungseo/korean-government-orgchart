[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "직제기구도")
)

$ErrorActionPreference = "Stop"
$desktopDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryDirectory = Split-Path -Parent $desktopDirectory
$manifestBuilder = Join-Path $repositoryDirectory "scripts\build-mois-ai-participation-native-manifest.mjs"
$manifestPath = Join-Path $desktopDirectory "src-tauri\resources\mois-ai-participation-left.native.json"
$automationScript = Join-Path $desktopDirectory "src-tauri\resources\hwp-native.ps1"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputPath = Join-Path $OutputDirectory "행정안전부-두실-왼쪽면-편집형-$timestamp.hwpx"

if ($null -eq [Type]::GetTypeFromProgID("HWPFrame.HwpObject")) {
    throw "한컴오피스 한글 Automation(HWPFrame.HwpObject)이 등록되어 있지 않습니다."
}
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "개발 검증에는 Node.js가 필요합니다. 설치본 앱 실행에는 Node.js가 필요하지 않습니다."
}

& node $manifestBuilder $manifestPath
if ($LASTEXITCODE -ne 0) { throw "네이티브 작도 명세 생성에 실패했습니다." }

[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$json = & $automationScript -Mode Generate -ManifestPath $manifestPath -OutputPath $outputPath
if ($LASTEXITCODE -ne 0) { throw "한글 네이티브 HWPX 생성에 실패했습니다." }
$result = $json | Select-Object -Last 1 | ConvertFrom-Json

$result | ConvertTo-Json -Depth 8
if (-not $result.verified) {
    throw "HWPX는 생성됐지만 A4 1쪽 또는 네이티브 객체 수 검증이 일치하지 않습니다: $outputPath"
}

Start-Process -FilePath $outputPath
Write-Host "검증 통과: A4 $($result.pageCount)쪽 · 네이티브 객체 $($result.nativeObjectCount)개" -ForegroundColor Green
Write-Host $outputPath
