[CmdletBinding()]
param(
    # 한글이 죽는 객체 번호(작도 순서 기준 1부터, "120,260" 처럼 여러 개 가능). 비어 있으면 크래시 없음.
    [string]$CrashAt = "",
    # 같은 자리에서 몇 번 연속으로 죽는지(재개 한도 검증용)
    [int]$CrashTimes = 1,
    [int]$ChunkSize = 150,
    [int]$MaxRecoveries = 3,
    [int]$ObjectCount = 575,
    # 단절(RPC)이 아닌 일반 오류로 죽는 상황
    [switch]$PlainError,
    # 문서 객체 수가 이 값 이상이면 한글 메모리가 한도를 넘은 것으로 흉내 낸다(조기 체크포인트 검증). 0이면 없음
    [int]$MemorySpikeAt = 0
)

<#
hwp-native.ps1 의 Generate 제어 흐름(청크 체크포인트·크래시 재개·최종 저장·검증)을
한글 COM 없이 검증하는 시뮬레이션. 스크립트를 dot-source 한 뒤 COM 을 만지는 함수만
가짜로 바꿔 끼운다. 실제 도형 생성·저장 품질은 Windows 실기 검증(verify-windows.ps1)의 몫이다.
#>
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path (Split-Path -Parent $here) "desktop/src-tauri/resources/hwp-native.ps1"
$work = Join-Path ([IO.Path]::GetTempPath()) ("hwp-native-sim-" + [Guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $work | Out-Null

# 시뮬레이션용 명세: 선 → 사각형 → 글상자 순서가 지켜지는지도 본다
$objects = @()
for ($i = 0; $i -lt $ObjectCount; $i++) {
    $kind = if ($i % 3 -eq 0) { "textbox" } elseif ($i % 3 -eq 1) { "line" } else { "rectangle" }
    if ($kind -eq "line") {
        $objects += @{ id = "o$i"; type = "line"; geometry = @{ x1 = 10; y1 = 10; x2 = 50; y2 = 50 }; style = @{ stroke = "#000000"; strokeWidthMm = 0.3; dash = "solid" } }
    } elseif ($kind -eq "rectangle") {
        $objects += @{ id = "o$i"; type = "rectangle"; geometry = @{ x = 10; y = 10; width = 20; height = 10 }; style = @{ stroke = "#000000"; strokeWidthMm = 0.3; dash = "solid"; fill = "none" } }
    } else {
        $objects += @{ id = "o$i"; type = "textbox"; text = "t$i"; geometry = @{ x = 10; y = 10; width = 20; height = 10 }; style = @{ stroke = "#000000"; strokeWidthMm = 0.3; dash = "solid"; fill = "#FFFFFF"; textColor = "#000000"; fontSizePt = 6; bold = $true; align = "center"; verticalAlign = "center"; paddingMm = 0.5 } }
    }
}
$lines = @($objects | Where-Object { $_.type -eq "line" }).Count
$rects = @($objects | Where-Object { $_.type -eq "rectangle" }).Count
$texts = @($objects | Where-Object { $_.type -eq "textbox" }).Count
$manifest = @{
    schema = "kr.go.mois.orgchart.hwp-native/v1"
    page = @{ paper = "A3"; orientation = "landscape"; widthMm = 420; heightMm = 297; marginMm = @{ left = 10; right = 10; top = 10; bottom = 10 } }
    objects = $objects
    verification = @{ expectedPageCount = 1; expectedNativeObjectCount = $objects.Count; expectedLineObjectCount = $lines; expectedRectangleObjectCount = $rects; expectedTextBoxObjectCount = $texts; expectedEditableTextObjectCount = $texts }
}
$manifestPath = Join-Path $work "drawing.native.json"
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$outputPath = Join-Path $work "out.hwpx"
$progressPath = Join-Path $work "progress.json"
$pidPath = Join-Path $work "hwp.pid"

# ---- 스크립트를 dot-source 해 함수와 파라미터를 이 스코프에 들인다 ----
# 본문은 ValidateManifest 모드로 실행돼 COM 을 건드리지 않고(한글이 설치된 PC 에서도 안전) 위 명세를 실제로 검증한다.
# dot-source 가 param 블록을 다시 실행하므로 값은 여기서 한 번에 넘긴다.
$global:__simOut = $null
. $scriptPath -Mode ValidateManifest -ManifestPath $manifestPath -OutputPath $outputPath -ProgressPath $progressPath -PidPath $pidPath -ChunkSize $ChunkSize -MaxRecoveries $MaxRecoveries *> $null

# ---- 가짜 한글: 파일에 객체 수를 적어 '문서' 상태를 흉내 낸다 ----
$script:SimDocObjects = 0          # 열린 문서 안의 객체 수
$script:SimCreated = @()           # 실제로 만든 순서(id)
$script:SimSessions = 0
# 위치별 남은 크래시 횟수
$script:SimCrashPlan = @{}
foreach ($token in ($CrashAt -split ",")) { if ($token.Trim() -match '^\d+$' -and [int]$token -gt 0) { $script:SimCrashPlan[[int]$token] = $CrashTimes } }

# 살아 있는 프로세스(이 pwsh 자신)를 한글 PID 로 두어 실제 Test-HwpDisconnected 의 생존 검사가 "살아 있음"으로 나오게 한다.
function New-HwpObject { param([switch]$Visible) $script:SimSessions += 1; $script:HwpProcessId = $PID; return @{ Hwp = [pscustomobject]@{ Sim = $true }; SecurityModuleRegistered = $true; Attached = $false } }
function Set-PageSetup { param($Page) $script:SimDocObjects = 0 }
function Open-HwpSession {
    param([string]$CheckpointPath, $Page, [bool]$Fresh)
    $holder = New-HwpObject
    $script:Hwp = $holder.Hwp
    if ($Fresh) { Set-PageSetup $Page }
    else {
        if (-not (Test-Path -LiteralPath $CheckpointPath)) { throw "체크포인트 HWPX를 다시 열지 못했습니다: $CheckpointPath" }
        $script:SimDocObjects = [int](Get-Content -LiteralPath $CheckpointPath -Raw)
    }
    return $holder
}
function Add-NativeObject {
    param($Object)
    $ordinal = $script:SimDocObjects + 1
    if ($script:SimCrashPlan.ContainsKey($ordinal) -and $script:SimCrashPlan[$ordinal] -gt 0) {
        $script:SimCrashPlan[$ordinal] -= 1
        if ($PlainError) { throw "선 객체를 만들지 못했습니다: $($Object.id)" }
        throw [Runtime.InteropServices.COMException]::new("RPC 서버를 사용할 수 없습니다. (0x800706BA)")
    }
    $script:SimDocObjects = $ordinal
    $script:SimCreated += [string]$Object.id
}
# Save-HwpCheckpoint 는 실제 함수를 쓴다 — $fake.SaveAs 가 '문서'(객체 수)를 파일에 적는다. lock 옵션·rename 순서가 실제로 돈다.
function Get-NativeObjectCount { param($Hwp) return @{ All = $script:SimDocObjects; Shapes = $script:SimDocObjects } }
function Release-HwpObject { param($Hwp, [switch]$LeaveOpen) $script:SimReleases += 1; $script:HwpProcessId = 0 }
function Stop-HwpProcess { param([int]$GraceMs = 0) $script:HwpProcessId = 0 }
$script:SimReleases = 0
function Stop-OrphanAutomationHwp { return 0 }
function Hide-HwpWindows { param($Hwp) }
function Get-HwpMemoryBytes { if ($MemorySpikeAt -gt 0 -and $script:SimDocObjects -ge $MemorySpikeAt) { return [long](2000 * 1024 * 1024) } else { return [long](300 * 1024 * 1024) } }
function Write-JsonResult { param([hashtable]$Value) $global:__simOut = $Value }

# 검증 단계는 체크포인트 사본을 '열어' 객체 수를 읽는 것으로 대신한다
$script:SimVerifyOpen = {
    param($path)
    return [int](Get-Content -LiteralPath $path -Raw)
}

$failure = $null
try {
    # Invoke-Generate 는 검증 재열기에서 $script:Hwp.Open/PageCount 를 부르므로 가짜 객체에 메서드를 붙인다
    $fake = [pscustomobject]@{}
    $fake | Add-Member -MemberType ScriptMethod -Name Open -Value { param($p, $f, $o) $script:SimDocObjects = [int](Get-Content -LiteralPath $p -Raw); return $true }
    $fake | Add-Member -MemberType ScriptMethod -Name SaveAs -Value { param($p, $f, $o) if ($o -notmatch 'lock:false') { throw "SaveAs 는 lock:false 로 저장해야 한다" }; [IO.File]::WriteAllText($p, [string]$script:SimDocObjects); return $true }
    $fake | Add-Member -MemberType ScriptMethod -Name Clear -Value { param($o) return $true }
    $fake | Add-Member -MemberType ScriptMethod -Name Quit -Value { return $true }
    $fake | Add-Member -MemberType ScriptProperty -Name PageCount -Value { 1 }
    $fake | Add-Member -MemberType ScriptProperty -Name XHwpWindows -Value { [pscustomobject]@{} }
    function New-HwpObject { param([switch]$Visible) $script:SimSessions += 1; $script:HwpProcessId = $PID; return @{ Hwp = $fake; SecurityModuleRegistered = $true; Attached = $false } }
    Invoke-Generate
} catch {
    $failure = $_.Exception.Message
}

$result = @{
    failure = $failure
    sessions = $script:SimSessions
    releases = $script:SimReleases
    createdOrder = $script:SimCreated
    output = $global:__simOut
    progress = $(if (Test-Path -LiteralPath $progressPath) { Get-Content -LiteralPath $progressPath -Raw | ConvertFrom-Json } else { $null })
    logTail = $(if (Test-Path -LiteralPath "$progressPath.log") { @(Get-Content -LiteralPath "$progressPath.log" | Select-Object -Last 6 | ForEach-Object { [string]$_ }) } else { @() })
    logAll = $(if (Test-Path -LiteralPath "$progressPath.log") { @(Get-Content -LiteralPath "$progressPath.log" | ForEach-Object { [string]$_ }) } else { @() })
    leftovers = @(Get-ChildItem -LiteralPath $work | ForEach-Object { $_.Name })
    outputExists = (Test-Path -LiteralPath $outputPath)
    outputObjects = $(if (Test-Path -LiteralPath $outputPath) { [int](Get-Content -LiteralPath $outputPath -Raw) } else { -1 })
}
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
