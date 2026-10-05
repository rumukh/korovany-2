#Requires -Version 7.0
<#
.SYNOPSIS
Session-independent queue for local W0 surface textures (Qwen Image Edit Plus 2511 via the wangp-reference-image skill).
Runs one GPU job at a time and refuses to start a job while another GPU model job (WanGP or TRELLIS) is active.
Writes only under <authoring>\<texture-id>\concepts; the authoring root is -Authoring or $env:K2_AUTHORING.
#>
param(
    [Parameter(Mandatory)][string[]]$Jobs,
    [string]$Repository = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
    [string]$Authoring = $env:K2_AUTHORING,
    [switch]$AllCandidates
)
$ErrorActionPreference = 'Stop'
if (-not $Authoring) { throw 'Set K2_AUTHORING (the authoring root) or pass -Authoring.' }
. "$PSScriptRoot\gpu-guard.ps1"
$helper = "$HOME\.copilot\skills\wangp-reference-image\scripts\generate-reference-image.ps1"
foreach ($job in $Jobs) {
    $id, $seedText = $job.Split(':')
    $recipe = Get-Content (Join-Path $Repository "scripts\world\textures\$id\recipe.json") -Raw | ConvertFrom-Json
    $seeds = if ($seedText) { @([long]$seedText) } elseif ($AllCandidates) { @($recipe.candidates.seed) } else { @($recipe.candidates[0].seed) }
    $base = Join-Path $Authoring $id
    foreach ($d in 'concepts', 'raw', 'cook', 'reviews') { New-Item -ItemType Directory -Force "$base\$d" | Out-Null }
    $layout = "$base\concepts\layout.png"
    & python (Join-Path $Repository 'scripts\world\pipeline\make_surface_swatch.py') (Join-Path $Repository "scripts\world\textures\$id\recipe.json") $layout | Out-Null
    [IO.File]::WriteAllText("$base\concepts\prompt.txt", $recipe.prompt, [Text.UTF8Encoding]::new($false))
    foreach ($seed in $seeds) {
        $out = "$base\concepts\candidate-$seed.png"
        if (Test-Path $out) { "skip $id $seed (exists)"; continue }
        Wait-K2GpuIdle
        $started = Get-Date
        $result = & $helper -ReferenceImage $layout -PromptFile "$base\concepts\prompt.txt" -ReferenceMode Scene -Resolution 1328x1328 `
            -Seed $seed -RawPrompt -NegativePrompt $recipe.negativePrompt -OutputPath $out 2>&1 | Out-String
        $json = $result.Substring($result.LastIndexOf('{"'.Substring(0, 1)))
        [IO.File]::WriteAllText("$base\concepts\candidate-$seed.json", $json, [Text.UTF8Encoding]::new($false))
        "{0} done {1} seed {2} in {3:N1} min" -f (Get-Date -Format HH:mm:ss), $id, $seed, ((Get-Date) - $started).TotalMinutes
    }
}
