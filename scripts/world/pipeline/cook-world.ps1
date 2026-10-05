#Requires -Version 7.0
<#
.SYNOPSIS
Cooks the scripted world kits (build_kit.py for W0, build_kit_w1.py for the W1 settlements, build_kit_w2.py for the W2 castles
and ruins) and nature kit (build_nature.py) in
Blender 5.2.2 LTS, compresses each GLB's
geometry with the shipped meshopt_glb.mjs (unchanged; byte-identical to scripts/models/pipeline/meshopt_glb.mjs) and
copies the results to public/world/<id>/<id>.glb. Authoring output stays under <authoring>\<kit>\cook; the authoring root
(-Authoring or $env:K2_AUTHORING) also holds the _pipeline folder with meshopt_glb.mjs and its node_modules. Blender is
-Blender or $env:K2_BLENDER.

    cook-world.ps1 -Revision r1 [-Samples 48] [-Kits kit-w0,kit-w1,kit-w2,nature-w0] [-Publish]
#>
param(
    [Parameter(Mandatory)][string]$Revision,
    [int]$Samples = 48,
    [string[]]$Kits = @('kit-w0', 'kit-w1', 'kit-w2', 'nature-w0'),
    [string]$Authoring = $env:K2_AUTHORING,
    [string]$Blender = $env:K2_BLENDER,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
if (-not $Authoring) { throw 'Set K2_AUTHORING (the authoring root) or pass -Authoring.' }
if (-not $Blender) { throw 'Set K2_BLENDER (blender.exe of Blender 5.2.2 LTS) or pass -Blender.' }
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$pipeline = Join-Path $Authoring '_pipeline'
$meshopt = "$pipeline\meshopt_glb.mjs"
if ((Get-FileHash $meshopt).Hash -ne (Get-FileHash "$repo\scripts\models\pipeline\meshopt_glb.mjs").Hash) { throw 'meshopt_glb.mjs copies differ' }
$jobs = @(
    @{ kit = 'kit-w0'; script = 'build_kit.py' },
    @{ kit = 'kit-w1'; script = 'build_kit_w1.py' },
    @{ kit = 'kit-w2'; script = 'build_kit_w2.py' },
    @{ kit = 'nature-w0'; script = 'build_nature.py' }
) | Where-Object { $Kits -contains $_.kit }
if (-not $jobs) { throw "no kit selected from $($Kits -join ', ')" }
$cooked = @()
foreach ($job in $jobs) {
    $out = Join-Path $Authoring "$($job.kit)\cook\$Revision"
    if (Test-Path $out) { throw "$out exists; use a new revision" }
    New-Item -ItemType Directory -Force $out | Out-Null
    $log = & $Blender -b --factory-startup --python "$repo\scripts\world\pipeline\$($job.script)" -- --out $out --samples $Samples 2>&1
    if ($LASTEXITCODE -ne 0 -or ($log | Select-String 'Traceback')) { $log | Select-Object -Last 30; throw "$($job.script) failed" }
    $report = Get-ChildItem $out -Filter '*-report.json' | Select-Object -First 1
    foreach ($glb in Get-ChildItem $out -Filter '*.glb') {
        $id = $glb.BaseName
        $dir = "$out\$id"
        New-Item -ItemType Directory -Force $dir | Out-Null
        Copy-Item $glb.FullName "$dir\$id.glb"
        $receipt = [ordered]@{
            schema = 'korovany2-world-cook/1'; status = 'cooked-pending-review'; asset = $id
            generator = "scripts/world/pipeline/$($job.script)"
            generatorSha256 = (Get-FileHash "$repo\scripts\world\pipeline\$($job.script)" -Algorithm SHA256).Hash.ToLowerInvariant()
            blender = 'Blender 5.2.2 LTS (d13f752e3b9c)'; samples = $Samples
            report = $report.Name; rawSha256 = (Get-FileHash "$dir\$id.glb" -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        [IO.File]::WriteAllBytes("$dir\cook.json", [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 5) + "`n"))
        Push-Location $pipeline
        try { node $meshopt $dir "$id.glb" | Out-Null; if ($LASTEXITCODE -ne 0) { throw "meshopt failed for $id" } } finally { Pop-Location }
        $cooked += [pscustomobject]@{ id = $id; raw = $glb.Length; compressed = (Get-Item "$dir\$id.glb").Length; dir = $dir }
    }
}
if ($Publish) {
    foreach ($item in $cooked) {
        New-Item -ItemType Directory -Force "$repo\public\world\$($item.id)" | Out-Null
        Copy-Item "$($item.dir)\$($item.id).glb" "$repo\public\world\$($item.id)\$($item.id).glb" -Force
    }
}
$cooked | Format-Table id, raw, compressed -AutoSize | Out-String
