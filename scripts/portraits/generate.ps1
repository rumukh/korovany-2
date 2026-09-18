[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MasterDirectory,
    [string]$HelperPath = "$HOME\.copilot\skills\azure-image-generation\scripts\generate-image.ps1",
    [ValidateRange(1, 3)][int]$Concurrency = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$catalog = Get-Content -LiteralPath "$PSScriptRoot\catalog.json" -Raw | ConvertFrom-Json
$MasterDirectory = [IO.Path]::GetFullPath($MasterDirectory)
New-Item -ItemType Directory -Path $MasterDirectory -Force | Out-Null
$style = $catalog.style
$settings = $catalog.settings

$results = $catalog.characters | ForEach-Object -Parallel {
    $ErrorActionPreference = "Stop"
    $character = $_
    $directory = $using:MasterDirectory
    $helper = $using:HelperPath
    $config = $using:settings
    $path = Join-Path $directory "$($character.id).png"
    $receiptPath = Join-Path $directory "$($character.id).json"
    $prompt = "$($character.subject)`n`n$using:style"
    try {
        if (Test-Path -LiteralPath $receiptPath) {
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            if ($receipt.prompt -ne $prompt -or !(Test-Path -LiteralPath $path) -or
                (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.sha256) {
                throw "Existing receipt or master does not match; preserve it and use a new master directory."
            }
            return [pscustomobject]@{ id = $character.id; status = "reused" }
        }
        if (Test-Path -LiteralPath $path) {
            throw "Master exists without a receipt; inspect it before recovering provenance."
        }
        $startedAt = [DateTime]::UtcNow.ToString("o")
        $result = & $helper -Prompt $prompt -Size $config.size -Quality $config.quality `
            -Background $config.background -OutputFormat $config.output_format -OutputPath $path | ConvertFrom-Json
        if ($result.status -ne "complete") { throw "Generation helper did not complete." }
        [ordered]@{
            id = $character.id
            model = "gpt-image-2"
            provider = "Azure OpenAI"
            apiVersion = "2024-02-01"
            startedAt = $startedAt
            completedAt = [DateTime]::UtcNow.ToString("o")
            prompt = $prompt
            settings = $config
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            result = $result
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
        [pscustomobject]@{ id = $character.id; status = "generated"; bytes = $result.bytes }
    }
    catch {
        [pscustomobject]@{ id = $character.id; status = "failed"; error = $_.Exception.Message }
    }
} -ThrottleLimit $Concurrency

$results | ConvertTo-Json -Depth 4
if (@($results | Where-Object status -eq "failed").Count) {
    throw "Portrait generation has failed entries. Successful masters are retained; inspect failures before retrying."
}
