[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Oc,
    [Parameter(Mandatory = $true)][string]$Institution,
    [Parameter(Mandatory = $true)][string]$AsOf
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Invoke-LawApi {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Parameters
    )

    $pairs = foreach ($entry in $Parameters.GetEnumerator()) {
        "{0}={1}" -f [Uri]::EscapeDataString([string]$entry.Key), [Uri]::EscapeDataString([string]$entry.Value)
    }
    $uri = "http://www.law.go.kr/DRF/${Path}?" + ($pairs -join "&")
    $client = New-Object System.Net.WebClient
    $client.Encoding = [System.Text.Encoding]::UTF8
    try {
        $raw = $client.DownloadString($uri)
    }
    finally {
        $client.Dispose()
    }
    try {
        return $raw | ConvertFrom-Json
    }
    catch {
        throw "국가법령정보센터 응답을 읽지 못했습니다: $($_.Exception.Message)"
    }
}

function Select-LawAtDate {
    param(
        [Parameter(Mandatory = $true)][object[]]$Entries,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$TargetDate
    )

    $candidate = $Entries |
        Where-Object {
            $Names -contains [string]$_.법령명한글 -and
            [string]$_.시행일자 -match '^\d{8}$' -and
            [string]$_.시행일자 -le $TargetDate
        } |
        Sort-Object { [string]$_.시행일자 } -Descending |
        Select-Object -First 1
    if ($null -eq $candidate) {
        throw "$TargetDate 기준 현행 법령을 찾지 못했습니다: $($Names -join ', ')"
    }
    return $candidate
}

$targetDate = ($AsOf -replace '\D', '')
if ($targetDate -notmatch '^\d{8}$') {
    throw "기준일은 YYYY-MM-DD 형식이어야 합니다."
}

$search = Invoke-LawApi -Path "lawSearch.do" -Parameters @{
    OC = $Oc
    target = "eflaw"
    type = "JSON"
    query = $Institution
    display = "100"
    sort = "efdes"
}
$entries = @($search.LawSearch.law) | Where-Object { $null -ne $_ }
if ($entries.Count -eq 0) {
    throw "기관명으로 법령 검색 결과를 찾지 못했습니다: $Institution"
}

$decreeNames = @(
    "${Institution}와 그 소속기관 직제",
    "${Institution}과 그 소속기관 직제",
    "$Institution 직제"
)
$decree = Select-LawAtDate -Entries $entries -Names $decreeNames -TargetDate $targetDate
$decreeName = [string]$decree.법령명한글
$ruleNames = @("$decreeName 시행규칙", "$Institution 직제 시행규칙")
$rule = Select-LawAtDate -Entries $entries -Names $ruleNames -TargetDate $targetDate

function Get-LawBody {
    param([Parameter(Mandatory = $true)]$Entry)
    return Invoke-LawApi -Path "lawService.do" -Parameters @{
        OC = $Oc
        target = "eflaw"
        type = "JSON"
        MST = [string]$Entry.법령일련번호
        efYd = [string]$Entry.시행일자
        BD = "on"
    }
}

$result = [ordered]@{
    institution = $Institution
    requestedDate = $targetDate
    decree = [ordered]@{
        lawName = $decreeName
        effectiveDate = [string]$decree.시행일자
        json = Get-LawBody -Entry $decree
    }
    rule = [ordered]@{
        lawName = [string]$rule.법령명한글
        effectiveDate = [string]$rule.시행일자
        json = Get-LawBody -Entry $rule
    }
}
$result | ConvertTo-Json -Depth 100 -Compress
