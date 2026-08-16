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
}

function Read-NativeManifest {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "-ManifestPath 값이 필요합니다." }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "작도 명세를 찾지 못했습니다: $Path" }
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schema -ne "kr.go.mois.orgchart.hwp-native/v1") {
        throw "지원하지 않는 네이티브 작도 명세입니다: $($manifest.schema)"
    }
    if ($manifest.page.paper -ne "A4" -or $manifest.page.orientation -ne "portrait") { throw "현재 앱은 A4 세로 명세만 지원합니다." }
    $pageWidth = Get-NativeNumber $manifest.page.widthMm "용지 너비"
    $pageHeight = Get-NativeNumber $manifest.page.heightMm "용지 높이"
    if ([Math]::Abs($pageWidth - 210) -gt 0.02 -or [Math]::Abs($pageHeight - 297) -gt 0.02) { throw "A4 세로 크기는 210×297mm여야 합니다." }
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
                throw "$($object.id) 선이 A4 용지 밖으로 나갑니다."
            }
            if ([Math]::Sqrt([Math]::Pow($x2 - $x1, 2) + [Math]::Pow($y2 - $y1, 2)) -lt 0.01) { throw "$($object.id) 선의 길이가 0입니다." }
        } else {
            $x = Get-NativeNumber $object.geometry.x "$($object.id) x"
            $y = Get-NativeNumber $object.geometry.y "$($object.id) y"
            $width = Get-NativeNumber $object.geometry.width "$($object.id) width"
            $height = Get-NativeNumber $object.geometry.height "$($object.id) height"
            if ($width -le 0 -or $height -le 0 -or $x -lt 0 -or $y -lt 0 -or $x + $width -gt ($pageWidth + 0.02) -or $y + $height -gt ($pageHeight + 0.02)) {
                throw "$($object.id) 객체가 A4 용지 밖으로 나갑니다."
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
        throw "A4 세로 쪽 설정을 적용하지 못했습니다."
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
        Write-Verbose "한글 Automation 객체를 초기화합니다."
        $holder = New-HwpObject
        if (-not $holder.SecurityModuleRegistered) {
            throw "한글 파일 접근 보안모듈이 등록되어 있지 않습니다. 한컴 개발자센터의 Automation 보안모듈을 설치·등록한 뒤 다시 시도하세요."
        }
        $script:Hwp = $holder.Hwp
        Write-Verbose "새 문서를 만듭니다."
        $script:Hwp.HAction.Run("FileNew") | Out-Null
        Write-Verbose "새 문서 생성 완료. 쪽 설정을 적용합니다."
        Set-PageSetup $manifest.page
        Write-Verbose "쪽 설정 적용 완료."

        $createdIndex = 0
        foreach ($object in @($manifest.objects | Where-Object { $_.type -eq "line" })) {
            Add-NativeLine $object
            $createdIndex += 1
            Write-Verbose "네이티브 객체 $createdIndex/$($validated.ObjectCount) 생성: $($object.id)"
        }
        foreach ($object in @($manifest.objects | Where-Object { $_.type -eq "rectangle" })) {
            Add-NativeRectangle $object
            $createdIndex += 1
            Write-Verbose "네이티브 객체 $createdIndex/$($validated.ObjectCount) 생성: $($object.id)"
        }
        foreach ($object in @($manifest.objects | Where-Object { $_.type -eq "textbox" })) {
            Add-NativeRectangle $object -WithText
            $createdIndex += 1
            Write-Verbose "네이티브 객체 $createdIndex/$($validated.ObjectCount) 생성: $($object.id)"
        }

        Write-Verbose "생성된 객체를 집계하고 HWPX로 저장합니다."
        $createdCount = Get-NativeObjectCount $script:Hwp
        $saved = [bool]$script:Hwp.SaveAs($resolvedOutput, "HWPX", "")
        if (-not $saved -or -not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) {
            throw "한글이 HWPX 파일을 저장하지 못했습니다. 파일 접근 승인 창을 확인하세요."
        }
        Release-HwpObject $script:Hwp
        $script:Hwp = $null
        $holder = $null

        Write-Verbose "저장한 HWPX를 다시 열어 객체 수와 쪽 수를 검증합니다."
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
