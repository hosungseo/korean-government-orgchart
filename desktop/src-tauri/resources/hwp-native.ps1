[CmdletBinding()]
param(
    [ValidateSet("Probe", "ValidateManifest", "Generate")]
    [string]$Mode = "Probe",
    [string]$ManifestPath,
    [string]$OutputPath,
    [switch]$KeepVisible
)

$ErrorActionPreference = "Stop"
$script:Hwp = $null

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

function Read-NativeManifest {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "-ManifestPath 값이 필요합니다." }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "작도 명세를 찾지 못했습니다: $Path" }
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schema -ne "kr.go.mois.orgchart.hwp-native/v1") {
        throw "지원하지 않는 네이티브 작도 명세입니다: $($manifest.schema)"
    }
    if ($manifest.page.paper -ne "A4" -or $manifest.page.orientation -ne "portrait") {
        throw "시제품은 A4 세로 명세만 지원합니다."
    }
    $objects = @($manifest.objects)
    if ($objects.Count -eq 0) { throw "네이티브 작도 객체가 없습니다." }
    $ids = @{}
    foreach ($object in $objects) {
        if ([string]::IsNullOrWhiteSpace([string]$object.id)) { throw "ID가 없는 네이티브 객체가 있습니다." }
        if ($ids.ContainsKey([string]$object.id)) { throw "중복 네이티브 객체 ID입니다: $($object.id)" }
        $ids[[string]$object.id] = $true
        if (@("line", "rectangle", "textbox") -notcontains [string]$object.type) {
            throw "지원하지 않는 네이티브 객체 유형입니다: $($object.type)"
        }
    }
    $lineCount = @($objects | Where-Object { $_.type -eq "line" }).Count
    $rectangleCount = @($objects | Where-Object { $_.type -eq "rectangle" }).Count
    $textBoxCount = @($objects | Where-Object { $_.type -eq "textbox" }).Count
    if ([int]$manifest.verification.expectedNativeObjectCount -ne $objects.Count) {
        throw "작도 명세의 예상 객체 수가 실제 객체 수와 다릅니다."
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
    $section.ApplyClass = 24
    $section.ApplyTo = 3
    if (-not $script:Hwp.HAction.Execute("PageSetup", $section.HSet)) {
        throw "A4 세로 쪽 설정을 적용하지 못했습니다."
    }
}

function Set-ShapePosition {
    param($Shape, [double]$X, [double]$Y, [double]$Width, [double]$Height)
    $Shape.TreatAsChar = 0
    $Shape.TextWrap = $script:Hwp.TextWrapType("TopAndBottom")
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
    $Shape.ShapeCreationMode = 0
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
    $points = $layout.CreateItemArray("CreatePt", 8)
    $points.SetItem(0, 0) | Out-Null
    $points.SetItem(1, 0) | Out-Null
    $points.SetItem(2, $widthUnit) | Out-Null
    $points.SetItem(3, 0) | Out-Null
    $points.SetItem(4, $widthUnit) | Out-Null
    $points.SetItem(5, $heightUnit) | Out-Null
    $points.SetItem(6, 0) | Out-Null
    $points.SetItem(7, $heightUnit) | Out-Null
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
    $points = $layout.CreateItemArray("CreatePt", 4)
    $points.SetItem(0, $localX1) | Out-Null
    $points.SetItem(1, $localY1) | Out-Null
    $points.SetItem(2, $localX2) | Out-Null
    $points.SetItem(3, $localY2) | Out-Null
    $shape.ShapeCreationType = 0
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
    $shape.ShapeCreationType = 1

    if ($WithText) {
        $padding = Convert-ToHwpUnit ([double]$style.paddingMm)
        $shape.ShapeListProperites.VertAlign = $script:Hwp.VAlign($(if ($style.verticalAlign -eq "center") { "Center" } else { "Top" }))
        $shape.ShapeListProperites.MarginLeft = $padding
        $shape.ShapeListProperites.MarginRight = $padding
        $shape.ShapeListProperites.MarginTop = $padding
        $shape.ShapeListProperites.MarginBottom = $padding
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

function New-HwpObject {
    $type = [Type]::GetTypeFromProgID("HWPFrame.HwpObject")
    if ($null -eq $type) { throw "Windows에 한컴오피스 한글 Automation이 등록되어 있지 않습니다." }
    $hwp = New-Object -ComObject HWPFrame.HwpObject
    $hwp.XHwpWindows.Item(0).Visible = $true
    $registered = $false
    try { $registered = [bool]$hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModuleExample") } catch { $registered = $false }
    return @{ Hwp = $hwp; SecurityModuleRegistered = $registered }
}

function Release-HwpObject {
    param($Hwp, [switch]$LeaveOpen)
    if ($null -eq $Hwp) { return }
    if (-not $LeaveOpen) {
        try { $Hwp.Quit() } catch {}
    }
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Hwp) } catch {}
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
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

function Invoke-Generate {
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { throw "-OutputPath 값이 필요합니다." }
    $validated = Read-NativeManifest $ManifestPath
    $manifest = $validated.Manifest
    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
    if ([IO.Path]::GetExtension($resolvedOutput).ToLowerInvariant() -ne ".hwpx") { throw "출력 파일 확장자는 .hwpx여야 합니다." }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null

    $holder = $null
    try {
        $holder = New-HwpObject
        $script:Hwp = $holder.Hwp
        $script:Hwp.HAction.Run("FileNew") | Out-Null
        Set-PageSetup $manifest.page

        foreach ($object in @($manifest.objects | Where-Object { $_.type -eq "line" })) {
            Add-NativeLine $object
        }
        foreach ($object in @($manifest.objects | Where-Object { $_.type -eq "rectangle" })) {
            Add-NativeRectangle $object
        }
        foreach ($object in @($manifest.objects | Where-Object { $_.type -eq "textbox" })) {
            Add-NativeRectangle $object -WithText
        }

        $createdCount = Get-NativeObjectCount $script:Hwp
        $saved = [bool]$script:Hwp.SaveAs($resolvedOutput, "HWPX", "")
        if (-not $saved -or -not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) {
            throw "한글이 HWPX 파일을 저장하지 못했습니다. 파일 접근 승인 창을 확인하세요."
        }
        Release-HwpObject $script:Hwp
        $script:Hwp = $null
        $holder = $null

        $verifyHolder = New-HwpObject
        $script:Hwp = $verifyHolder.Hwp
        $opened = [bool]$script:Hwp.Open($resolvedOutput, "", "lock:false;forceopen:true;versionwarning:false;")
        if (-not $opened) { throw "저장된 HWPX를 다시 열지 못했습니다." }
        $reopenedCount = Get-NativeObjectCount $script:Hwp
        $pageCount = -1
        try { $pageCount = [int]$script:Hwp.PageCount } catch {}
        $expectedObjects = [int]$manifest.verification.expectedNativeObjectCount
        $expectedPages = [int]$manifest.verification.expectedPageCount
        $nativeCount = $(if ($reopenedCount.Shapes -gt 0) { $reopenedCount.Shapes } else { $reopenedCount.All })
        $verified = ($pageCount -eq $expectedPages -and $nativeCount -eq $expectedObjects)

        Write-JsonResult @{
            generated = $true
            verified = $verified
            outputPath = $resolvedOutput
            pageCount = $pageCount
            expectedPageCount = $expectedPages
            nativeObjectCount = $nativeCount
            expectedNativeObjectCount = $expectedObjects
            createdControlCount = $createdCount.All
            lineCount = $validated.LineCount
            rectangleCount = $validated.RectangleCount
            textBoxCount = $validated.TextBoxCount
            editableTextObjectCount = $validated.TextBoxCount
            securityModuleRegistered = [bool]$verifyHolder.SecurityModuleRegistered
        }

        if ($KeepVisible) {
            $script:Hwp.XHwpWindows.Item(0).Visible = $true
            Release-HwpObject $script:Hwp -LeaveOpen
        } else {
            Release-HwpObject $script:Hwp
        }
        $script:Hwp = $null
    } finally {
        if ($null -ne $script:Hwp) { Release-HwpObject $script:Hwp }
        elseif ($null -ne $holder) { Release-HwpObject $holder.Hwp }
        $script:Hwp = $null
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
