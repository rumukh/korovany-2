[CmdletBinding()]
param(
    [string[]]$Cue = @(),
    [switch]$MasterAfterEach,
    [switch]$Finalize,
    [string]$Helper = "$HOME\.copilot\skills\ace-step-music\scripts\generate-music.ps1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Inherited by a newly launched ACE service; the upstream 600s limit is too short for XL-SFT.
$env:ACESTEP_GENERATION_TIMEOUT = "5400"
$recipe = Get-Content -LiteralPath (Join-Path $PSScriptRoot "score-cues.json") -Raw | ConvertFrom-Json
$tooling = "C:\AI\ACE-Step-1.5\outputs\$($recipe.production)\tooling"
New-Item -ItemType Directory -Path $tooling -Force | Out-Null
foreach ($source in @($Helper, "C:\AI\ACE-Step-1.5\Start-ACE-Step.ps1")) {
    $archived = Join-Path $tooling ([IO.Path]::GetFileName($source))
    if (Test-Path -LiteralPath $archived) {
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $archived).Hash) {
            throw "ACE tooling changed since this production was archived: $source"
        }
    }
    else {
        Copy-Item -LiteralPath $source -Destination $archived
    }
}
$selected = @($recipe.cues | Where-Object { $Cue.Count -eq 0 -or $_.id -in $Cue })
foreach ($id in $Cue) {
    if ($id -notin $recipe.cues.id) { throw "Unknown score cue: $id" }
}
foreach ($item in $selected) {
    $outputName = "$($recipe.production)-$($item.id)"
    $audio = "C:\AI\ACE-Step-1.5\outputs\$outputName.flac"
    $metadata = "C:\AI\ACE-Step-1.5\outputs\$outputName.json"
    if ((Test-Path -LiteralPath $audio) -and (Test-Path -LiteralPath $metadata)) {
        $existing = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
        if ($existing.request.seed -ne $item.seed -or $existing.request.prompt -ne $item.prompt -or
            $existing.request.inference_steps -ne 50 -or $existing.request.model -ne $recipe.model -or
            $existing.request.audio_duration -ne ($item.duration + $item.crossfade)) {
            throw "Existing master has different production parameters: $metadata"
        }
        Write-Output "REUSING_VERIFIED_RECIPE=$audio"
    }
    else {
        $logPath = "C:\AI\ACE-Step-1.5\outputs\$($recipe.production)\$($item.id)-generation.log"
        & "C:\AI\ACE-Step-1.5\.venv\Scripts\python.exe" -B `
            (Join-Path $PSScriptRoot "render_score_local.py") $item.id *> $logPath
        if ($LASTEXITCODE -ne 0) {
            Get-Content -LiteralPath $logPath -Tail 20
            throw "Score generation failed for $($item.id); no further model job submitted."
        }
        Get-Content -LiteralPath $logPath -Tail 3
    }
    if ($MasterAfterEach) {
        & python -B (Join-Path $PSScriptRoot "produce_soundtrack.py") --music $item.id --review-samples
        if ($LASTEXITCODE -ne 0) { throw "Mastering failed for $($item.id); no further model job submitted." }
    }
}
if ($Finalize) {
    & python -B (Join-Path $PSScriptRoot "produce_soundtrack.py") --validate --review-samples
    if ($LASTEXITCODE -ne 0) { throw "Final soundtrack validation failed." }
}
