#Requires -Version 7.0
<#
.SYNOPSIS
Serial TRELLIS-image-large jobs (trellis-3d skill, network-isolated) for accepted world-asset concepts, one GPU model job at
a time across all sessions. Writes only under <authoring>\<asset-id>\raw\<candidate>-s<seed>; the authoring root is
-Authoring or $env:K2_AUTHORING.

    texture-queue.ps1 ... ; trellis-queue.ps1 -Jobs 'prop-haystack:a:1201','char-sheep:a:1301' [-IgnoreHold]

`-IgnoreHold` lets this queue run while its own `k2-gpu-hold` reservation (a sleeping python that keeps the texture queue
waiting) is alive; every other GPU model job still blocks it.
#>
param(
    [Parameter(Mandatory)][string[]]$Jobs,
    [string]$Authoring = $env:K2_AUTHORING,
    [switch]$IgnoreHold,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if (-not $Authoring) { throw 'Set K2_AUTHORING (the authoring root) or pass -Authoring.' }
. "$PSScriptRoot\gpu-guard.ps1"
$skill = "$HOME\.copilot\skills\trellis-3d\scripts\generate-asset.ps1"
$rights = 'Concept image generated for Korovany II with the owner''s Azure OpenAI deployment (gpt-image-2.5-sunburst); cloud concept generation approved by the owner on 2026-10-04 (_reviews/cloud-generation-2026-10-04.json).'
foreach ($job in $Jobs) {
    $id, $candidate, $seedText = $job.Split(':')
    $base = Join-Path $Authoring $id
    $image = "$base\concepts\candidate-$candidate.png"
    if (-not (Test-Path $image)) { throw "missing concept $image" }
    New-Item -ItemType Directory -Force "$base\raw" | Out-Null
    $out = "$base\raw\$candidate-s$seedText"
    if (Test-Path $out) { "skip $id $candidate s$seedText (exists)"; continue }
    & $skill -InputImage $image -OutputDirectory $out -InputRights $rights -Seed ([uint32]$seedText) -ValidateOnly
    if ($ValidateOnly) { "validated $id $candidate s$seedText"; continue }
    Wait-K2GpuIdle -IgnoreHold:$IgnoreHold
    $started = Get-Date
    $result = & $skill -InputImage $image -OutputDirectory $out -InputRights $rights -Seed ([uint32]$seedText) -Offline | Out-String
    "{0} done {1} {2} s{3} in {4:N1} min" -f (Get-Date -Format HH:mm:ss), $id, $candidate, $seedText, ((Get-Date) - $started).TotalMinutes
    $result.Trim()
}
