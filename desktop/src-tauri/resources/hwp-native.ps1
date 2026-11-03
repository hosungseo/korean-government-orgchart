[CmdletBinding()]
param(
    [ValidateSet("Probe", "ValidateManifest", "Generate")]
    [string]$Mode = "Probe",
    [string]$ManifestPath,
    [string]$OutputPath,
    [switch]$KeepVisible,
    # 한 번의 한글 세션에서 만들 객체 수. 세션마다 체크포인트 저장 → 한글 종료 → 새 프로세스로
    # 이어 그린다. 실행 취소 이력·메모리·레이아웃 재계산 부하가 세션 안에서만 쌓이게 한다.
    [int]$ChunkSize = 150,
    # 진행 상태 JSON(앱이 읽어 화면에 표시하고, 타임아웃 시 마지막 지점을 오류에 붙인다)
    [string]$ProgressPath,
    # 이 스크립트가 띄운 한글 프로세스 PID(앱이 강제 종료할 때 고아 한글을 함께 정리)
    [string]$PidPath,
    # 한글이 죽었을 때 체크포인트에서 다시 이어 그리는 최대 횟수
    [int]$MaxRecoveries = 3,
    # 한글 프로세스 메모리(Private Bytes)가 이 값을 넘으면 청크를 기다리지 않고 바로 체크포인트 저장 후
    # 프로세스를 갈아 끼운다. Windows용 한글은 2024까지 32비트라 2GB(LAA 시 4GB) 상한이 있다.
    [int]$MemoryLimitMb = 1200,
    # 한 세션이 이 시간을 넘어도 조기 체크포인트(객체당 시간이 늘어지는 상황 방어)
    [int]$SessionMaxSeconds = 120,
    # 서로 다른 자리에서 끊긴 것까지 합친 재개 총량 상한(확률형 단절이 계속되면 여기서 멈춘다)
    [int]$MaxTotalRecoveries = 20,
    # 체크포인트를 둘 폴더(기본: 작도 명세 옆 = 앱 임시 폴더). 실패 시 부분 저장본이 여기에 남는다.
    [string]$CheckpointDir
)

$ErrorActionPreference = "Stop"
$script:Hwp = $null
$script:HwpProcessId = 0
$script:HwpAttached = $false
$script:HwpStartTime = $null
$script:ProgressLog = $null
$script:Stopwatch = [Diagnostics.Stopwatch]::StartNew()

function Write-JsonResult {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 12 -Compress))
}

function Convert-ToHwpUnit {
    param([double]$Millimeters)
    return [int][Math]::Round($Millimeters * 283.464566929)
}

function Convert-HexColor {
    param([string]$Hex)
    if ([string]::IsNullOrWhiteSpace($Hex) -or $Hex -eq "none") {
        return $script:Hwp.RGBColor(255, 255, 255)
    }
    $normalized = $Hex.Trim().TrimStart('#')
    if ($normalized.Length -ne 6) { throw "지원하지 않는 색상 값입니다: $Hex" }
    $red = [Convert]::ToInt32($normalized.Substring(0, 2), 16)
    $green = [Convert]::ToInt32($normalized.Substring(2, 2), 16)
    $blue = [Convert]::ToInt32($normalized.Substring(4, 2), 16)
    return $script:Hwp.RGBColor($red, $green, $blue)
}

function Test-HexColorValue {
    param([object]$Value, [switch]$AllowNone)
    $text = [string]$Value
    if ($AllowNone -and $text -eq "none") { return $true }
    return $text -match '^#[0-9A-Fa-f]{6}$'
}

function Get-NativeNumber {
    param([object]$Value, [string]$Label)
    if ($null -eq $Value) { throw "$Label 값이 없습니다." }
    try { $number = [double]$Value } catch { throw "$Label 값은 숫자여야 합니다." }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { throw "$Label 값은 유한한 숫자여야 합니다." }
    return $number
}

function Assert-NativeStyle {
    param($Object)
    $id = [string]$Object.id
    $style = $Object.style
    if ($null -eq $style) { throw "$id 객체의 서식(style) 정보가 없습니다." }
    if (-not (Test-HexColorValue $style.stroke -AllowNone)) { throw "$id 객체의 선 색상은 #RRGGBB 또는 none이어야 합니다." }
    $strokeWidth = Get-NativeNumber $style.strokeWidthMm "$id 선 굵기"
    if ($strokeWidth -lt 0 -or $strokeWidth -gt 10) { throw "$id 객체의 선 굵기는 0~10mm여야 합니다." }
    if (@("solid", "dash") -notcontains [string]$style.dash) { throw "$id 객체의 선 종류는 solid 또는 dash여야 합니다." }
    if ($Object.type -eq "line") {
        if ($style.stroke -eq "none" -or $strokeWidth -eq 0) { throw "$id 선 객체가 보이지 않는 서식입니다." }
        return
    }
    if (-not (Test-HexColorValue $style.fill -AllowNone)) { throw "$id 객체의 채우기 색상은 #RRGGBB 또는 none이어야 합니다." }
    if ($Object.type -ne "textbox") { return }
    if (-not (Test-HexColorValue $style.textColor)) { throw "$id 글상자의 문자 색상은 #RRGGBB여야 합니다." }
    $fontSize = Get-NativeNumber $style.fontSizePt "$id 글자 크기"
    if ($fontSize -lt 2 -or $fontSize -gt 72) { throw "$id 글상자의 글자 크기는 2~72pt여야 합니다." }
    if (@("left", "center", "right") -notcontains [string]$style.align) { throw "$id 글상자의 가로 정렬 값이 올바르지 않습니다." }
    if (@("top", "center", "bottom") -notcontains [string]$style.verticalAlign) { throw "$id 글상자의 세로 정렬 값이 올바르지 않습니다." }
    $padding = Get-NativeNumber $style.paddingMm "$id 안쪽 여백"
    if ($padding -lt 0) { throw "$id 글상자의 안쪽 여백은 0 이상이어야 합니다." }
    foreach ($axis in @("paddingXMm", "paddingYMm")) {
        if ($null -eq $style.PSObject.Properties[$axis]) { continue }
        $value = Get-NativeNumber $style.$axis "$id $axis"
        if ($value -lt 0) { throw "$id 글상자의 $axis 값은 0 이상이어야 합니다." }
    }
}

function Read-NativeManifest {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "-ManifestPath 값이 필요합니다." }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "작도 명세를 찾지 못했습니다: $Path" }
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schema -ne "kr.go.mois.orgchart.hwp-native/v1") {
        throw "지원하지 않는 네이티브 작도 명세입니다: $($manifest.schema)"
    }
    $pageWidth = Get-NativeNumber $manifest.page.widthMm "용지 너비"
    $pageHeight = Get-NativeNumber $manifest.page.heightMm "용지 높이"
    $a4Portrait = $manifest.page.paper -eq "A4" -and $manifest.page.orientation -eq "portrait" -and [Math]::Abs($pageWidth - 210) -le 0.02 -and [Math]::Abs($pageHeight - 297) -le 0.02
    $a3Landscape = $manifest.page.paper -eq "A3" -and $manifest.page.orientation -eq "landscape" -and [Math]::Abs($pageWidth - 420) -le 0.02 -and [Math]::Abs($pageHeight - 297) -le 0.02
    if (-not $a4Portrait -and -not $a3Landscape) { throw "현재 앱은 A4 세로 또는 A3 가로 명세를 지원합니다." }
    $marginLeft = Get-NativeNumber $manifest.page.marginMm.left "왼쪽 여백"
    $marginRight = Get-NativeNumber $manifest.page.marginMm.right "오른쪽 여백"
    $marginTop = Get-NativeNumber $manifest.page.marginMm.top "위쪽 여백"
    $marginBottom = Get-NativeNumber $manifest.page.marginMm.bottom "아래쪽 여백"
    if ($marginLeft -lt 0 -or $marginRight -lt 0 -or $marginTop -lt 0 -or $marginBottom -lt 0) { throw "용지 여백은 0 이상이어야 합니다." }
    if ($marginLeft + $marginRight -ge $pageWidth -or $marginTop + $marginBottom -ge $pageHeight) { throw "용지 여백 값이 본문 영역보다 큽니다." }
    $objects = @($manifest.objects)
    if ($objects.Count -eq 0) { throw "네이티브 작도 객체가 없습니다." }
    if ($objects.Count -gt 5000) { throw "네이티브 객체는 최대 5000개까지 지원합니다." }
    $ids = @{}
    foreach ($object in $objects) {
        if ([string]::IsNullOrWhiteSpace([string]$object.id)) { throw "ID가 없는 네이티브 객체가 있습니다." }
        if ($ids.ContainsKey([string]$object.id)) { throw "중복 네이티브 객체 ID입니다: $($object.id)" }
        $ids[[string]$object.id] = $true
        if (@("line", "rectangle", "textbox") -notcontains [string]$object.type) {
            throw "지원하지 않는 네이티브 객체 유형입니다: $($object.type)"
        }
        if ($null -eq $object.geometry) { throw "$($object.id) 객체의 좌표가 없습니다." }
        if ($object.type -eq "line") {
            $x1 = Get-NativeNumber $object.geometry.x1 "$($object.id) x1"
            $y1 = Get-NativeNumber $object.geometry.y1 "$($object.id) y1"
            $x2 = Get-NativeNumber $object.geometry.x2 "$($object.id) x2"
            $y2 = Get-NativeNumber $object.geometry.y2 "$($object.id) y2"
            if ($x1 -lt 0 -or $y1 -lt 0 -or $x2 -lt 0 -or $y2 -lt 0 -or $x1 -gt ($pageWidth + 0.02) -or $x2 -gt ($pageWidth + 0.02) -or $y1 -gt ($pageHeight + 0.02) -or $y2 -gt ($pageHeight + 0.02)) {
                throw "$($object.id) 선이 용지 밖으로 나갑니다."
            }
            if ([Math]::Sqrt([Math]::Pow($x2 - $x1, 2) + [Math]::Pow($y2 - $y1, 2)) -lt 0.01) { throw "$($object.id) 선의 길이가 0입니다." }
        } else {
            $x = Get-NativeNumber $object.geometry.x "$($object.id) x"
            $y = Get-NativeNumber $object.geometry.y "$($object.id) y"
            $width = Get-NativeNumber $object.geometry.width "$($object.id) width"
            $height = Get-NativeNumber $object.geometry.height "$($object.id) height"
            if ($width -le 0 -or $height -le 0 -or $x -lt 0 -or $y -lt 0 -or $x + $width -gt ($pageWidth + 0.02) -or $y + $height -gt ($pageHeight + 0.02)) {
                throw "$($object.id) 객체가 용지 밖으로 나갑니다."
            }
            if ($object.type -eq "textbox" -and $null -eq $object.text) { throw "$($object.id) 글상자의 text 값이 없습니다." }
        }
        Assert-NativeStyle $object
    }
    $lineCount = @($objects | Where-Object { $_.type -eq "line" }).Count
    $rectangleCount = @($objects | Where-Object { $_.type -eq "rectangle" }).Count
    $textBoxCount = @($objects | Where-Object { $_.type -eq "textbox" }).Count
    $expected = @{
        expectedPageCount = 1
        expectedNativeObjectCount = $objects.Count
        expectedLineObjectCount = $lineCount
        expectedRectangleObjectCount = $rectangleCount
        expectedTextBoxObjectCount = $textBoxCount
        expectedEditableTextObjectCount = $textBoxCount
    }
    foreach ($entry in $expected.GetEnumerator()) {
        $property = $manifest.verification.PSObject.Properties[$entry.Key]
        if ($null -eq $property -or [int]$property.Value -ne [int]$entry.Value) { throw "검증 예상값 $($entry.Key)가 실제값 $($entry.Value)와 다릅니다." }
    }
    return @{
        Manifest = $manifest
        ObjectCount = $objects.Count
        LineCount = $lineCount
        RectangleCount = $rectangleCount
        TextBoxCount = $textBoxCount
    }
}

function Set-PageSetup {
    param($Page)
    $section = $script:Hwp.HParameterSet.HSecDef
    $script:Hwp.HAction.GetDefault("PageSetup", $section.HSet) | Out-Null
    $section.PageDef.PaperWidth = Convert-ToHwpUnit ([double]$Page.widthMm)
    $section.PageDef.PaperHeight = Convert-ToHwpUnit ([double]$Page.heightMm)
    $section.PageDef.Landscape = 0
    $section.PageDef.LeftMargin = Convert-ToHwpUnit ([double]$Page.marginMm.left)
    $section.PageDef.RightMargin = Convert-ToHwpUnit ([double]$Page.marginMm.right)
    $section.PageDef.TopMargin = Convert-ToHwpUnit ([double]$Page.marginMm.top)
    $section.PageDef.BottomMargin = Convert-ToHwpUnit ([double]$Page.marginMm.bottom)
    $section.PageDef.HeaderLen = 0
    $section.PageDef.FooterLen = 0
    $section.PageDef.GutterLen = 0
    # Some Hancom Office releases do not expose these action parameters as
    # COM properties. HSet.SetItem works across both the old and new type
    # libraries and is the native way to populate action-only parameters.
    $section.HSet.SetItem("ApplyClass", 24)
    $section.HSet.SetItem("ApplyTo", 3)
    if (-not $script:Hwp.HAction.Execute("PageSetup", $section.HSet)) {
        throw "쪽 설정을 적용하지 못했습니다."
    }
}

function Set-ShapePosition {
    param($Shape, [double]$X, [double]$Y, [double]$Width, [double]$Height)
    $Shape.TreatAsChar = 0
    $Shape.HSet.SetItem("FlowWithText", 0)
    # 종이 기준 절대 배치 도형이 빈 본문 문단을 다음 쪽으로 밀어내지 않도록 한다.
    $Shape.TextWrap = $script:Hwp.TextWrapType("BehindText")
    $Shape.TextFlow = $script:Hwp.TextFlowType("BothSides")
    $Shape.VertOffset = Convert-ToHwpUnit $Y
    $Shape.VertAlign = $script:Hwp.VAlign("Top")
    $Shape.VertRelTo = $script:Hwp.VertRel("Paper")
    $Shape.HorzOffset = Convert-ToHwpUnit $X
    $Shape.HorzAlign = $script:Hwp.HAlign("Justify")
    $Shape.HorzRelTo = $script:Hwp.HorzRel("Paper")
    $Shape.HeightRelTo = $script:Hwp.HeightRel("Absolute")
    $Shape.Height = Convert-ToHwpUnit ([Math]::Max($Height, 0.01))
    $Shape.WidthRelTo = $script:Hwp.WidthRel("Absolute")
    $Shape.Width = Convert-ToHwpUnit ([Math]::Max($Width, 0.01))
    $Shape.NumberingType = $script:Hwp.Numbering("Figure")
    $Shape.HSet.SetItem("ShapeCreationMode", 0)
}

function Set-LineAttributes {
    param($Shape, $Style)
    $line = $Shape.ShapeDrawLineAttr
    $line.Alpha = 0
    $line.OutLineStyle = $script:Hwp.HwpOutLineStyle("Normal")
    $line.TailFill = 0
    $line.HeadFill = 0
    $line.TailSize = $script:Hwp.EndSize("SmallSmall")
    $line.HeadSize = $script:Hwp.EndSize("SmallSmall")
    $line.EndCap = 1
    $line.TailStyle = $script:Hwp.EndStyle("Normal")
    $line.HeadStyle = $script:Hwp.EndStyle("Normal")
    $line.Width = Convert-ToHwpUnit ([Math]::Max([double]$Style.strokeWidthMm, 0.01))
    $line.Style = $script:Hwp.HwpLineType($(if ($Style.dash -eq "dash") { "Dash" } else { "Solid" }))
    $line.Color = Convert-HexColor ([string]$Style.stroke)
}

function Set-FillAttributes {
    param($Shape, $Style)
    $fill = $Shape.ShapeDrawFillAttr
    if ([string]$Style.fill -eq "none") {
        $fill.Type = $script:Hwp.BrushType("NullBrush")
        return
    }
    $fill.Type = $script:Hwp.BrushType("NullBrush|WinBrush")
    $fill.WinBrushAlpha = 0
    $fill.WinBrushFaceStyle = $script:Hwp.HatchStyle("None")
    $fill.WinBrushHatchColor = $script:Hwp.RGBColor(0, 0, 0)
    $fill.WinBrushFaceColor = Convert-HexColor ([string]$Style.fill)
    $fill.WindowsBrush = 1
    $fill.GradationBrush = 0
    $fill.ImageBrush = 0
}

function Set-RectanglePoints {
    param($Shape, [double]$Width, [double]$Height)
    $widthUnit = Convert-ToHwpUnit $Width
    $heightUnit = Convert-ToHwpUnit $Height
    $layout = $Shape.ShapeDrawLayOut
    $layout.CreateNumPt = 4
    $layout.CreateItemArray("CreatePt", 8)
    $layout.CreatePt.Item(0) = 0
    $layout.CreatePt.Item(1) = 0
    $layout.CreatePt.Item(2) = $widthUnit
    $layout.CreatePt.Item(3) = 0
    $layout.CreatePt.Item(4) = $widthUnit
    $layout.CreatePt.Item(5) = $heightUnit
    $layout.CreatePt.Item(6) = 0
    $layout.CreatePt.Item(7) = $heightUnit
}

function Add-NativeLine {
    param($Object)
    $x1 = [double]$Object.geometry.x1
    $y1 = [double]$Object.geometry.y1
    $x2 = [double]$Object.geometry.x2
    $y2 = [double]$Object.geometry.y2
    $left = [Math]::Min($x1, $x2)
    $top = [Math]::Min($y1, $y2)
    $width = [Math]::Max([Math]::Abs($x2 - $x1), 0.01)
    $height = [Math]::Max([Math]::Abs($y2 - $y1), 0.01)
    $localX1 = Convert-ToHwpUnit ($x1 - $left)
    $localY1 = Convert-ToHwpUnit ($y1 - $top)
    $localX2 = Convert-ToHwpUnit ($x2 - $left)
    $localY2 = Convert-ToHwpUnit ($y2 - $top)

    $shape = $script:Hwp.HParameterSet.HShapeObject
    $script:Hwp.HAction.GetDefault("DrawObjCreatorLine", $shape.HSet) | Out-Null
    Set-ShapePosition $shape $left $top $width $height
    Set-LineAttributes $shape $Object.style
    $layout = $shape.ShapeDrawLayOut
    $layout.CreateNumPt = 2
    $layout.CreateItemArray("CreatePt", 4)
    $layout.CreatePt.Item(0) = $localX1
    $layout.CreatePt.Item(1) = $localY1
    $layout.CreatePt.Item(2) = $localX2
    $layout.CreatePt.Item(3) = $localY2
    $shape.HSet.SetItem("ShapeCreationType", 0)
    if (-not $script:Hwp.HAction.Execute("DrawObjCreatorLine", $shape.HSet)) {
        throw "선 객체를 만들지 못했습니다: $($Object.id)"
    }
    $script:Hwp.HAction.Run("Cancel") | Out-Null
}

function Set-TextFormatting {
    param($Style)
    $character = $script:Hwp.HParameterSet.HCharShape
    $script:Hwp.HAction.GetDefault("CharShape", $character.HSet) | Out-Null
    $font = if ([string]::IsNullOrWhiteSpace([string]$Style.fontFamily)) { "맑은 고딕" } else { [string]$Style.fontFamily }
    $character.FaceNameHangul = $font
    $character.FaceNameLatin = $font
    $character.FaceNameHanja = $font
    $character.FaceNameJapanese = $font
    $character.FaceNameOther = $font
    $character.FaceNameSymbol = $font
    $character.FaceNameUser = $font
    $character.Height = [int][Math]::Round([double]$Style.fontSizePt * 100)
    $character.Bold = $(if ($Style.bold) { 1 } else { 0 })
    $character.TextColor = Convert-HexColor ([string]$Style.textColor)
    $script:Hwp.HAction.Execute("CharShape", $character.HSet) | Out-Null

    switch ([string]$Style.align) {
        "center" { $script:Hwp.HAction.Run("ParagraphShapeAlignCenter") | Out-Null }
        "right" { $script:Hwp.HAction.Run("ParagraphShapeAlignRight") | Out-Null }
        default { $script:Hwp.HAction.Run("ParagraphShapeAlignLeft") | Out-Null }
    }
}

function Add-NativeRectangle {
    param($Object, [switch]$WithText)
    $geometry = $Object.geometry
    $style = $Object.style
    $shape = $script:Hwp.HParameterSet.HShapeObject
    $script:Hwp.HAction.GetDefault("DrawObjCreatorRectangle", $shape.HSet) | Out-Null
    Set-ShapePosition $shape ([double]$geometry.x) ([double]$geometry.y) ([double]$geometry.width) ([double]$geometry.height)
    Set-RectanglePoints $shape ([double]$geometry.width) ([double]$geometry.height)
    Set-LineAttributes $shape $style
    Set-FillAttributes $shape $style
    $shape.AdjustTextbox = $(if ($WithText) { 1 } else { 0 })
    $shape.HSet.SetItem("ShapeCreationType", 1)

    if ($WithText) {
        # paddingXMm/paddingYMm(선택)는 좌우·위아래 안쪽 여백을 따로 준다. 없으면 paddingMm.
        $paddingX = Convert-ToHwpUnit ([double]$(if ($null -ne $style.PSObject.Properties["paddingXMm"]) { $style.paddingXMm } else { $style.paddingMm }))
        $paddingY = Convert-ToHwpUnit ([double]$(if ($null -ne $style.PSObject.Properties["paddingYMm"]) { $style.paddingYMm } else { $style.paddingMm }))
        $shape.ShapeListProperites.VertAlign = $script:Hwp.VAlign($(if ($style.verticalAlign -eq "center") { "Center" } else { "Top" }))
        $shape.ShapeListProperites.MarginLeft = $paddingX
        $shape.ShapeListProperites.MarginRight = $paddingX
        $shape.ShapeListProperites.MarginTop = $paddingY
        $shape.ShapeListProperites.MarginBottom = $paddingY
    }

    if (-not $script:Hwp.HAction.Execute("DrawObjCreatorRectangle", $shape.HSet)) {
        throw "사각형 객체를 만들지 못했습니다: $($Object.id)"
    }

    if ($WithText) {
        $script:Hwp.HAction.Run("ShapeObjTextBoxEdit") | Out-Null
        Set-TextFormatting $style
        $insert = $script:Hwp.HParameterSet.HInsertText
        $script:Hwp.HAction.GetDefault("InsertText", $insert.HSet) | Out-Null
        $insert.Text = [string]$Object.text
        if (-not $script:Hwp.HAction.Execute("InsertText", $insert.HSet)) {
            throw "글상자에 문자를 넣지 못했습니다: $($Object.id)"
        }
        $script:Hwp.HAction.Run("Cancel") | Out-Null
    }
    $script:Hwp.HAction.Run("Cancel") | Out-Null
}

function Get-HwpProcessIds {
    return @(Get-Process -Name "Hwp*" -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
}

function Get-WindowProcessId {
    # 프로세스 diff 로 PID 를 못 잡았을 때(한글 2024 단일 인스턴스 등) 창 핸들로 소유 프로세스를 찾는다.
    param($Hwp)
    try {
        if ($null -eq ("W.U32" -as [type])) {
            Add-Type -Namespace W -Name U32 -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' -ErrorAction Stop
        }
        $handle = [IntPtr][int64]$Hwp.XHwpWindows.Item(0).WindowHandle
        if ($handle -eq [IntPtr]::Zero) { return 0 }
        [uint32]$processId = 0
        [void][W.U32]::GetWindowThreadProcessId($handle, [ref]$processId)
        return [int]$processId
    } catch { return 0 }
}

function Hide-HwpWindows {
    # 창이 여러 개(탭·새 창)일 수 있으므로 전부 숨긴다. 숨김 창은 사용자가 건드릴 수 없어 포커스가 깨지지 않는다.
    param($Hwp)
    try {
        $count = [int]$Hwp.XHwpWindows.Count
        for ($k = 0; $k -lt $count; $k++) { try { $Hwp.XHwpWindows.Item($k).Visible = $false } catch {} }
    } catch {
        try { $Hwp.XHwpWindows.Item(0).Visible = $false } catch {}
    }
}

function Stop-OrphanAutomationHwp {
    # 이전 실행이 남긴 자동화 한글(명령줄에 -Automation)을 정리한다. 사용자가 직접 띄운 한글은 -Automation 이
    # 없으므로 건드리지 않는다. 한글 2024 는 인스턴스를 하나만 두기 때문에 고아가 남아 있으면 새 세션이 그
    # 오염된 프로세스에 붙어 버린다.
    $orphans = @()
    try {
        $orphans = @(Get-CimInstance -ClassName Win32_Process -Filter "Name LIKE 'Hwp%'" -ErrorAction Stop | Where-Object { [string]$_.CommandLine -match '-Automation' })
    } catch { $orphans = @() }
    foreach ($orphan in $orphans) {
        Write-ProgressLog "orphan automation hwp pid=$($orphan.ProcessId) killed ($($orphan.CommandLine))"
        try { Stop-Process -Id ([int]$orphan.ProcessId) -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($orphans.Count -gt 0) { Start-Sleep -Milliseconds 800 }
    return $orphans.Count
}

function New-HwpObject {
    param([switch]$Visible)
    $type = [Type]::GetTypeFromProgID("HWPFrame.HwpObject")
    if ($null -eq $type) { throw "Windows에 한컴오피스 한글 Automation이 등록되어 있지 않습니다." }
    $before = Get-HwpProcessIds
    $hwp = New-Object -ComObject HWPFrame.HwpObject
    # 이 호출로 새로 뜬 한글 프로세스를 기억한다 — 강제 종료·고아 정리·메모리 감시에 쓴다.
    $script:HwpProcessId = 0
    $script:HwpAttached = $false
    $script:HwpStartTime = $null
    # 1순위: 이 COM 개체의 창 핸들이 가리키는 프로세스(확정적). 2순위: 기동 전후 차집합이 정확히 하나일 때만.
    # 사용자가 같은 순간 한글을 띄우면 차집합이 둘이 되므로 "첫 항목"을 고르지 않는다(사용자 한글 오살 방지).
    $byWindow = Get-WindowProcessId $hwp
    if ($byWindow -gt 0) {
        if ($before -contains $byWindow) {
            # 새 프로세스가 아니라 이미 떠 있던 한글에 붙었다(한글 2024 단일 인스턴스, 또는 사용자의 한글).
            $script:HwpAttached = $true
        } else {
            $script:HwpProcessId = $byWindow
        }
    } else {
        try {
            $fresh = @(Get-HwpProcessIds | Where-Object { $before -notcontains $_ })
            if ($fresh.Count -eq 1) { $script:HwpProcessId = [int]$fresh[0] }
            elseif ($fresh.Count -gt 1) { Write-ProgressLog "hwp pid ambiguous: candidates $($fresh -join ',') — not tracking" }
        } catch {}
    }
    if ($script:HwpProcessId -gt 0) {
        try { $script:HwpStartTime = (Get-Process -Id $script:HwpProcessId -ErrorAction Stop).StartTime } catch { $script:HwpStartTime = $null }
    }
    if (-not [string]::IsNullOrWhiteSpace($PidPath)) {
        try { [IO.File]::WriteAllText($PidPath, [string]$script:HwpProcessId) } catch {}
    }
    # 삽입 중 창이 보이면 사용자가 클릭·이동해 편집모드 포커스가 깨지고,
    # 모달 대화상자가 뜨면 COM 호출이 영구 대기한다. 생성 작업은 숨겨서 수행하고
    # KeepVisible일 때만 마지막에 창을 보여준다.
    if (-not $Visible) { Hide-HwpWindows $hwp }
    # 한글 메시지박스 자동 응답(지원 버전에서만 동작) — 모달로 인한 영구 대기 방지.
    # 0x00011011 = 확인(MB_OK)→확인 · 확인/취소→확인 · 예/아니오/취소→예 · 예/아니오→예.
    # 파일 닫기 저장 확인창에는 적용되지 않으므로 Quit 전에 Clear(1) 로 dirty 상태를 없앤다.
    $previousMode = -1
    try { $previousMode = [int]$hwp.SetMessageBoxMode(0x00011011) } catch {}
    $registered = $false
    try { $registered = [bool]$hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModuleExample") } catch { $registered = $false }
    $version = ""
    try { $version = [string]$hwp.Version } catch {}
    $imagePath = ""
    try { if ($script:HwpProcessId -gt 0) { $imagePath = [string](Get-Process -Id $script:HwpProcessId -ErrorAction Stop).MainModule.FileName } } catch {}
    Write-ProgressLog "hwp object: pid=$($script:HwpProcessId) attached=$($script:HwpAttached) version=$version image=$imagePath ps64bit=$([Environment]::Is64BitProcess) messageBoxMode(prev)=$previousMode securityModule=$registered"
    return @{ Hwp = $hwp; SecurityModuleRegistered = $registered; Attached = $script:HwpAttached }
}

function Release-HwpObject {
    param($Hwp, [switch]$LeaveOpen)
    if ($null -eq $Hwp) { return }
    if (-not $LeaveOpen) {
        # dirty 문서를 버리고(저장 확인창 원천 차단) 한글을 끝낸다. 한컴 권장 순서: Clear → Quit → Release.
        try { [void]$Hwp.Clear(1) } catch {}
        try { $Hwp.Quit() } catch {}
    }
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Hwp) } catch {}
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if (-not $LeaveOpen) { Stop-HwpProcess -GraceMs 10000 }
}

function Stop-HwpProcess {
    param([int]$GraceMs = 0)
    # Quit 뒤에도 프로세스가 남으면(숨김 창은 사용자가 닫을 수 없다) 직접 종료한다.
    # 단, 기억해 둔 PID 가 정말 우리 한글인지(이름·시작 시각) 확인한 뒤에만 죽인다 — PID 재사용·오인 방어.
    $pidValue = $script:HwpProcessId
    if ($pidValue -le 0) { return }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($GraceMs)
    while ($true) {
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($null -eq $process) { break }
        $isOurs = ($process.ProcessName -like "Hwp*")
        if ($isOurs -and $null -ne $script:HwpStartTime) {
            try { $isOurs = ([Math]::Abs(($process.StartTime - $script:HwpStartTime).TotalSeconds) -lt 2) } catch { $isOurs = $true }
        }
        if (-not $isOurs) { Write-ProgressLog "hwp pid=$pidValue is not our process any more ($($process.ProcessName)) — not killing"; break }
        if ([DateTime]::UtcNow -ge $deadline) {
            Write-ProgressLog "hwp pid=$pidValue did not exit after Quit — force kill"
            try { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue } catch {}
            break
        }
        Start-Sleep -Milliseconds 200
    }
    $script:HwpProcessId = 0
    if (-not [string]::IsNullOrWhiteSpace($PidPath)) {
        try { [IO.File]::WriteAllText($PidPath, "0") } catch {}
    }
}

function Test-HwpDisconnected {
    param($ErrorRecord)
    # 한글 프로세스가 죽거나 응답을 끊으면 COM이 이 오류들을 낸다.
    #   0x800706BA RPC 서버를 사용할 수 없음 · 0x800706BE 원격 프로시저 호출 실패
    #   0x80010108 호출된 개체가 클라이언트에서 연결 끊김 · 0x80004005 E_FAIL(죽는 순간)
    $text = [string]$ErrorRecord.Exception.Message
    $inner = $ErrorRecord.Exception.InnerException
    while ($null -ne $inner) { $text += " " + [string]$inner.Message; $inner = $inner.InnerException }
    if ($text -match '0x800706BA|0x800706BE|0x80010108|0x80010105|0x800706BF|\bRPC\b') { return $true }
    if ($script:HwpProcessId -gt 0) {
        # 죽는 순간에는 일반 예외로 보일 수 있다 — 잠깐 지켜보며 프로세스 생존을 다시 확인한다.
        $until = [DateTime]::UtcNow.AddMilliseconds(2500)
        while ($true) {
            if ($null -eq (Get-Process -Id $script:HwpProcessId -ErrorAction SilentlyContinue)) { return $true }
            if ([DateTime]::UtcNow -ge $until) { break }
            Start-Sleep -Milliseconds 200
        }
    }
    return $false
}

function Move-FileAtomic {
    # PS 5.1 의 Move-Item -Force 는 삭제 후 이동이라 원자적이지 않다. 대상이 있으면 File.Replace 로 바꾼다.
    param([string]$Source, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) {
        # PowerShell 은 $null 을 빈 문자열로 넘기므로 진짜 null([NullString]) 을 써야 한다.
        try { [IO.File]::Replace($Source, $Destination, [NullString]::Value) }
        catch {
            Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $Source -Destination $Destination -Force
        }
    } else {
        Move-Item -LiteralPath $Source -Destination $Destination -Force
    }
}

function Write-ProgressState {
    param([hashtable]$State)
    if ([string]::IsNullOrWhiteSpace($ProgressPath)) { return }
    $State["elapsedMs"] = [int]$script:Stopwatch.ElapsedMilliseconds
    $State["updatedAt"] = [DateTime]::UtcNow.ToString("o")
    try {
        $tmp = "$ProgressPath.tmp"
        [IO.File]::WriteAllText($tmp, ($State | ConvertTo-Json -Compress))
        Move-FileAtomic $tmp $ProgressPath
    } catch {}
}

function Write-ProgressLog {
    param([string]$Message)
    if ([string]::IsNullOrWhiteSpace($ProgressPath)) { return }
    if ($null -eq $script:ProgressLog) {
        try { $script:ProgressLog = [IO.StreamWriter]::new("$ProgressPath.log", $true, [Text.UTF8Encoding]::new($false)) } catch { return }
    }
    try {
        # 메서드 인자 안의 쉼표는 인자 구분자로 읽히므로 문자열을 먼저 만든다.
        $line = "[{0:HH:mm:ss.fff}] +{1,7}ms {2}" -f @([DateTime]::Now, $script:Stopwatch.ElapsedMilliseconds, $Message)
        $script:ProgressLog.WriteLine($line)
        $script:ProgressLog.Flush()
    } catch {}
}

function Get-HwpMemoryBytes {
    if ($script:HwpProcessId -le 0) { return [long]0 }
    try {
        $process = Get-Process -Id $script:HwpProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) { return [long]0 }
        return [long]$process.PrivateMemorySize64
    } catch { return [long]0 }
}

function Invoke-WithComRetry {
    # 0x8001010A(지금은 처리 불가)·0x80010001(호출 거부)은 한글이 모달·바쁨 상태일 때 나온다. MS 지침대로
    # 조용히 재시도한다. 객체 단위 재시도라 드물게 중복 생성이 날 수 있지만, 마지막 재열기 검증(객체 수 대조)이
    # 그런 결과를 걸러내므로 잘못된 파일이 확정되지는 않는다.
    param([scriptblock]$Action, [string]$Label)
    $delay = 100
    $waited = 0
    while ($true) {
        try { & $Action; return } catch {
            $text = [string]$_.Exception.Message
            if (($text -match '0x8001010A|0x80010001') -and $waited -lt 30000) {
                Write-ProgressLog "busy ($Label): $text — retry in ${delay}ms"
                Start-Sleep -Milliseconds $delay
                $waited += $delay
                $delay = [Math]::Min(5000, $delay * 2)
                continue
            }
            throw
        }
    }
}

function Get-NativeObjectCount {
    param($Hwp)
    $all = 0
    $shapes = 0
    $control = $Hwp.HeadCtrl
    while ($null -ne $control) {
        $all += 1
        if (@('$lin', '$rec', 'gso') -contains [string]$control.CtrlID) { $shapes += 1 }
        $control = $control.Next
    }
    return @{ All = $all; Shapes = $shapes }
}

function Invoke-Probe {
    $type = [Type]::GetTypeFromProgID("HWPFrame.HwpObject")
    if ($null -eq $type) {
        Write-JsonResult @{ available = $false; platform = "windows"; reason = "HWPFrame.HwpObject COM 미등록" }
        return
    }
    $holder = $null
    try {
        $holder = New-HwpObject
        $version = ""
        try { $version = [string]$holder.Hwp.Version } catch {}
        Write-JsonResult @{
            available = $true
            platform = "windows"
            version = $version
            securityModuleRegistered = [bool]$holder.SecurityModuleRegistered
        }
    } finally {
        if ($null -ne $holder) { Release-HwpObject $holder.Hwp }
    }
}

function Invoke-ValidateManifest {
    $validated = Read-NativeManifest $ManifestPath
    Write-JsonResult @{
        valid = $true
        schema = $validated.Manifest.schema
        objectCount = $validated.ObjectCount
        lineCount = $validated.LineCount
        rectangleCount = $validated.RectangleCount
        textBoxCount = $validated.TextBoxCount
        expectedPageCount = [int]$validated.Manifest.verification.expectedPageCount
    }
}

function Add-NativeObject {
    param($Object)
    switch ([string]$Object.type) {
        "line" { Add-NativeLine $Object }
        "rectangle" { Add-NativeRectangle $Object }
        "textbox" { Add-NativeRectangle $Object -WithText }
        default { throw "지원하지 않는 네이티브 객체 유형입니다: $($Object.type)" }
    }
}

function Open-HwpSession {
    param([string]$CheckpointPath, $Page, [bool]$Fresh)
    $holder = New-HwpObject
    if ($holder.Attached) {
        # 사용자의 한글(또는 한글 2024 의 단일 인스턴스)에 붙었다. 그 문서를 건드리거나 종료하면 안 되므로 멈춘다.
        try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($holder.Hwp) } catch {}
        throw "한글이 이미 실행 중이라 이 앱이 별도의 숨김 한글을 띄우지 못했습니다(한글 2024는 인스턴스를 하나만 둡니다). 열려 있는 한글 창을 모두 닫은 뒤 다시 시도하세요."
    }
    if (-not $holder.SecurityModuleRegistered) {
        throw "한글 파일 접근 보안모듈이 등록되어 있지 않습니다. 한컴 개발자센터의 Automation 보안모듈을 설치·등록한 뒤 다시 시도하세요."
    }
    $script:Hwp = $holder.Hwp
    if ($Fresh) {
        # 새 HwpObject 는 빈 문서를 이미 갖고 있다. FileNew 는 숨김 인스턴스에서도 보이는 창을 새로 띄울 수
        # 있어(사용자가 건드리면 편집 포커스가 깨진다) 쓰지 않고, 빈 문서를 비운 뒤 쪽 설정만 적용한다.
        try { [void]$script:Hwp.Clear(1) } catch {}
        Set-PageSetup $Page
    } else {
        $opened = [bool]$script:Hwp.Open($CheckpointPath, "", "lock:false;forceopen:true;versionwarning:false;")
        if (-not $opened) { throw "체크포인트 HWPX를 다시 열지 못했습니다: $CheckpointPath" }
        Hide-HwpWindows $script:Hwp
        # 이어 그릴 객체는 (하나뿐인) 첫 문단의 기존 앵커들 뒤에 붙인다 — 세션 간 순서가 뒤집히지 않게.
        $script:Hwp.HAction.Run("MoveDocEnd") | Out-Null
    }
    return $holder
}

function Save-HwpCheckpoint {
    # 임시 경로에만 저장한다. lock:false 로 저장 후 잠금을 풀지만, 그래도 rename 은 한글을 완전히 내린 뒤
    # (Release-HwpObject 이후) 호출자가 한다 — 한글이 파일 핸들을 쥔 채 옮기면 공유 위반으로 실패한다.
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    $saved = [bool]$script:Hwp.SaveAs($Path, "HWPX", "lock:false;")
    if (-not $saved -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "한글이 HWPX 파일을 저장하지 못했습니다. 파일 접근 승인 창을 확인하세요."
    }
}

function Get-TextLength {
    param($Object)
    if ([string]$Object.type -eq "textbox") { return ([string]$Object.text).Length }
    return 0
}

function Invoke-Generate {
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { throw "-OutputPath 값이 필요합니다." }
    $validated = Read-NativeManifest $ManifestPath
    $manifest = $validated.Manifest
    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
    if ([IO.Path]::GetExtension($resolvedOutput).ToLowerInvariant() -ne ".hwpx") { throw "출력 파일 확장자는 .hwpx여야 합니다." }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
    if ($ChunkSize -lt 10) { $ChunkSize = 10 }

    # 작도 순서: 선 → 사각형 → 글상자 (z-order — 글상자가 항상 위에 온다)
    $ordered = @()
    $ordered += @($manifest.objects | Where-Object { $_.type -eq "line" })
    $ordered += @($manifest.objects | Where-Object { $_.type -eq "rectangle" })
    $ordered += @($manifest.objects | Where-Object { $_.type -eq "textbox" })
    $total = $ordered.Count
    # 체크포인트는 작도 명세 옆(앱 임시 폴더)에 둔다 — 결과 폴더에 부분 파일을 남기지 않는다.
    $checkpointRoot = if ([string]::IsNullOrWhiteSpace($CheckpointDir)) { [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ManifestPath)) } else { [IO.Path]::GetFullPath($CheckpointDir) }
    [IO.Directory]::CreateDirectory($checkpointRoot) | Out-Null
    $checkpoint = [IO.Path]::Combine($checkpointRoot, "checkpoint.hwpx")
    $saving = "$checkpoint.saving.hwpx"
    foreach ($leftover in @($checkpoint, $saving)) {
        if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Force }
    }

    $done = 0            # 체크포인트에 저장된 객체 수(여기까지는 디스크에 있다)
    $session = 0
    $recoveries = 0      # 보고용 누적 재개 횟수
    $streak = 0          # 같은 체크포인트에서 진전 없이 연속으로 끊긴 횟수
    $chunk = $ChunkSize
    $earlyCheckpoints = 0
    $failedHistory = @()
    $succeeded = $false
    $reopenedCount = @{ All = 0; Shapes = 0 }
    Write-ProgressLog "generate start: objects=$total chunk=$chunk memoryLimitMb=$MemoryLimitMb sessionMaxSeconds=$SessionMaxSeconds checkpoint=$checkpoint output=$resolvedOutput"
    Write-ProgressState @{ phase = "drawing"; done = 0; total = $total; session = 0; chunkSize = $chunk; recoveries = 0 }
    $orphanCount = Stop-OrphanAutomationHwp
    $memoryLimitBytes = [long]$MemoryLimitMb * 1024 * 1024

    try {
        while ($done -lt $total) {
            $session += 1
            $end = [Math]::Min($done + $chunk, $total)
            $holder = $null
            $stage = "open"
            $current = -1
            try {
                Write-ProgressLog "session $session open (resume at $done, target $end)"
                Write-ProgressState @{ phase = "opening"; done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries }
                $holder = Open-HwpSession -CheckpointPath $checkpoint -Page $manifest.page -Fresh ($done -eq 0)
                $sessionStartMs = $script:Stopwatch.ElapsedMilliseconds
                $stage = "draw"
                for ($i = $done; $i -lt $end; $i++) {
                    $current = $i
                    $object = $ordered[$i]
                    $t0 = $script:Stopwatch.ElapsedMilliseconds
                    Invoke-WithComRetry -Label ([string]$object.id) -Action { Add-NativeObject $object }
                    $ms = $script:Stopwatch.ElapsedMilliseconds - $t0
                    Write-ProgressLog ("object {0}/{1} {2} {3} len={4} {5}ms" -f ($i + 1), $total, $object.id, $object.type, (Get-TextLength $object), $ms)
                    if ((($i + 1) % 10) -eq 0 -or ($i + 1) -eq $end) {
                        $memoryBytes = Get-HwpMemoryBytes
                        $sessionSeconds = [int](($script:Stopwatch.ElapsedMilliseconds - $sessionStartMs) / 1000)
                        $handles = -1
                        $workingSet = 0
                        try { if ($script:HwpProcessId -gt 0) { $proc = Get-Process -Id $script:HwpProcessId -ErrorAction SilentlyContinue; if ($null -ne $proc) { $handles = [int]$proc.HandleCount; $workingSet = [long]$proc.WorkingSet64 } } } catch {}
                        Write-ProgressLog ("session {0} at {1}/{2}: hwp private {3}MB, workingset {4}MB, handles {5}, {6}s" -f $session, ($i + 1), $total, [int]($memoryBytes / 1MB), [int]($workingSet / 1MB), $handles, $sessionSeconds)
                        Write-ProgressState @{ phase = "drawing"; done = ($i + 1); total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries; lastId = [string]$object.id; lastObjectMs = $ms; hwpMemoryMb = [int]($memoryBytes / 1MB) }
                        # 메모리·시간이 한도를 넘으면 청크 끝을 기다리지 않고 저장 → 프로세스 교체
                        if (($i + 1) -lt $end -and (($memoryBytes -gt $memoryLimitBytes) -or ($sessionSeconds -ge $SessionMaxSeconds))) {
                            $earlyCheckpoints += 1
                            Write-ProgressLog ("session {0} early checkpoint at {1}/{2} (memory {3}MB, {4}s)" -f $session, ($i + 1), $total, [int]($memoryBytes / 1MB), $sessionSeconds)
                            $end = $i + 1
                            break
                        }
                    }
                }
                $stage = "save"
                $current = -1
                Write-ProgressLog "session $session checkpoint save ($end/$total)"
                Write-ProgressState @{ phase = "checkpointing"; done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries }
                Save-HwpCheckpoint $saving
                # 파일 잠금이 풀리도록 한글을 완전히 내린 뒤에 체크포인트로 확정한다.
                Release-HwpObject $script:Hwp
                $script:Hwp = $null
                $holder = $null
                [GC]::Collect()
                Move-FileAtomic $saving $checkpoint
                $done = $end
                $streak = 0
                Write-ProgressState @{ phase = "checkpoint"; done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries }
                Write-ProgressLog "session $session closed (drawn=$done)"
            } catch {
                $err = $_
                $disconnected = Test-HwpDisconnected $err
                if ($current -ge 0) {
                    $failedIndex = $current + 1
                    $failedObject = $ordered[$current]
                    $failedId = [string]$failedObject.id
                    $failedType = [string]$failedObject.type
                    $failedTextLen = Get-TextLength $failedObject
                } else {
                    $failedIndex = $done + 1
                    $failedId = ""
                    $failedType = ""
                    $failedTextLen = 0
                }
                $stageLabel = switch ($stage) {
                    "open" { "세션 $session 열기 중" }
                    "save" { "세션 $session 체크포인트 저장 중" }
                    default { "객체 $failedIndex/$total ($failedId, $failedType)" }
                }
                Write-ProgressLog ("session {0} error stage={1} object={2}/{3} id={4} type={5} textLen={6} disconnected={7}: {8}" -f $session, $stage, $failedIndex, $total, $failedId, $failedType, $failedTextLen, $disconnected, $err.Exception.Message)
                $failedHistory += $failedIndex
                # 정리: 죽은 한글은 Quit 이 안 먹으니 프로세스를 정리하고, 살아 있으면 정상 종료를 먼저 시도한다.
                if ($disconnected) {
                    try { if ($null -ne $script:Hwp) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:Hwp) } } catch {}
                    $script:Hwp = $null
                    Stop-HwpProcess
                } else {
                    if ($null -ne $script:Hwp) { Release-HwpObject $script:Hwp }
                    $script:Hwp = $null
                }
                $holder = $null
                $where = "$stageLabel (체크포인트 ${done}개)"
                $partial = ""
                if ($done -gt 0 -and (Test-Path -LiteralPath $checkpoint)) { $partial = " 부분 저장본(${done}개, 선→사각형→글상자 순): $checkpoint" }
                $failState = @{ done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries; streak = $streak; failedStage = $stage; failedIndex = $failedIndex; failedId = $failedId; failedType = $failedType; failedTextLen = $failedTextLen; failedHistory = $failedHistory; checkpointPath = $checkpoint; checkpointObjects = $done; disconnected = $disconnected; lastError = [string]$err.Exception.Message }
                if (-not $disconnected) {
                    $failState["phase"] = "failed"
                    Write-ProgressState $failState
                    throw "$where 에서 실패했습니다: $($err.Exception.Message)$partial"
                }
                if ($streak -ge $MaxRecoveries) {
                    $failState["phase"] = "failed"
                    Write-ProgressState $failState
                    throw "한글이 $where 에서 ${MaxRecoveries}회 연속 응답을 끊었습니다(같은 자리에서 반복). progress.json.log 의 마지막 객체 ID와 메모리 추이를 확인하세요. $($err.Exception.Message)$partial"
                }
                if ($recoveries -ge $MaxTotalRecoveries) {
                    $failState["phase"] = "failed"
                    Write-ProgressState $failState
                    throw "한글이 여러 자리($($failedHistory -join ', '))에서 총 ${recoveries}회 응답을 끊었습니다. 대비표 열 수를 줄이거나 실 단위로 나눠 만드세요.$partial"
                }
                $recoveries += 1
                $streak += 1
                $chunk = [Math]::Max(25, [int][Math]::Floor($chunk / 2))
                Write-ProgressLog "recovery $recoveries (streak $streak): chunk -> $chunk, resume at $done"
                $failState["phase"] = "recovering"
                $failState["recoveries"] = $recoveries
                $failState["chunkSize"] = $chunk
                Write-ProgressState $failState
                Start-Sleep -Milliseconds 1500
            }
        }

        Write-ProgressLog "final copy -> $resolvedOutput"
        Write-ProgressState @{ phase = "saving"; done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries }
        Copy-Item -LiteralPath $checkpoint -Destination $resolvedOutput -Force
        if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) { throw "최종 HWPX를 결과 경로에 놓지 못했습니다." }

        Write-ProgressLog "verify reopen"
        Write-ProgressState @{ phase = "verifying"; done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries }
        $verifyHolder = New-HwpObject
        if ($verifyHolder.Attached) {
            try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($verifyHolder.Hwp) } catch {}
            throw "검증 단계에서 한글이 이미 실행 중이라 별도 인스턴스를 띄우지 못했습니다. 열려 있는 한글 창을 모두 닫은 뒤 다시 시도하세요. 부분 저장본: $checkpoint"
        }
        $script:Hwp = $verifyHolder.Hwp
        $opened = [bool]$script:Hwp.Open($resolvedOutput, "", "lock:false;forceopen:true;versionwarning:false;")
        if (-not $opened) { throw "저장된 HWPX를 다시 열지 못했습니다. 부분 저장본: $checkpoint" }
        $reopenedCount = Get-NativeObjectCount $script:Hwp
        $pageCount = -1
        try { $pageCount = [int]$script:Hwp.PageCount } catch {}
        $expectedObjects = [int]$manifest.verification.expectedNativeObjectCount
        $expectedPages = [int]$manifest.verification.expectedPageCount
        $nativeCount = $(if ($reopenedCount.Shapes -gt 0) { $reopenedCount.Shapes } else { $reopenedCount.All })
        $verified = ($pageCount -eq $expectedPages -and $nativeCount -eq $expectedObjects)
        Write-ProgressLog "verify: pages=$pageCount/$expectedPages objects=$nativeCount/$expectedObjects verified=$verified"

        Write-JsonResult @{
            generated = $true
            verified = $verified
            outputPath = $resolvedOutput
            pageCount = $pageCount
            expectedPageCount = $expectedPages
            nativeObjectCount = $nativeCount
            expectedNativeObjectCount = $expectedObjects
            createdControlCount = $reopenedCount.All
            lineCount = $validated.LineCount
            rectangleCount = $validated.RectangleCount
            textBoxCount = $validated.TextBoxCount
            editableTextObjectCount = $validated.TextBoxCount
            securityModuleRegistered = [bool]$verifyHolder.SecurityModuleRegistered
            sessions = $session
            recoveries = $recoveries
            earlyCheckpoints = $earlyCheckpoints
            orphanHwpKilled = $orphanCount
            chunkSize = $chunk
            checkpointPath = $checkpoint
            elapsedMs = [int]$script:Stopwatch.ElapsedMilliseconds
        }
        Write-ProgressState @{ phase = "done"; done = $done; total = $total; session = $session; chunkSize = $chunk; recoveries = $recoveries; verified = $verified }
        $succeeded = $verified

        if ($KeepVisible) {
            $script:Hwp.XHwpWindows.Item(0).Visible = $true
            Release-HwpObject $script:Hwp -LeaveOpen
        } else {
            Release-HwpObject $script:Hwp
        }
        $script:Hwp = $null
    } finally {
        if ($null -ne $script:Hwp) { Release-HwpObject $script:Hwp }
        $script:Hwp = $null
        # 실패하면 부분 저장본(checkpoint.hwpx)은 진단·구제용으로 남기고, 쓰다 만 임시본만 지운다.
        try { if (Test-Path -LiteralPath $saving) { Remove-Item -LiteralPath $saving -Force } } catch {}
        if ($succeeded) { try { if (Test-Path -LiteralPath $checkpoint) { Remove-Item -LiteralPath $checkpoint -Force } } catch {} }
        if ($null -ne $script:ProgressLog) { try { $script:ProgressLog.Dispose() } catch {} }
    }
}

try {
    switch ($Mode) {
        "Probe" { Invoke-Probe }
        "ValidateManifest" { Invoke-ValidateManifest }
        "Generate" { Invoke-Generate }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
