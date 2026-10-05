#Requires -Version 7.0
<#
.SYNOPSIS
Cooks accepted TRELLIS farm props for version 3 worlds with the shipped static-prop chain, unchanged:
cook_landmark.py (Blender 5.2.2 LTS) -> repair_tangents.py -> quantize_prop_glb.py -> meshopt_glb.mjs.
Recipes are scripts/world/assets/<id>/recipe.json; outputs go to <authoring>\<id>\cook\<revision> and, with -Publish, to
public/world/<id>/<id>.glb. The authoring root (-Authoring or $env:K2_AUTHORING) holds the raw TRELLIS output and the
_pipeline folder with meshopt_glb.mjs and its node_modules; Blender is -Blender or $env:K2_BLENDER.

    cook-props.ps1 -Revision r1 -Ids prop-haystack,prop-barrels [-Publish]
#>
param(
    [Parameter(Mandatory)][string]$Revision,
    [Parameter(Mandatory)][string[]]$Ids,
    [string]$Authoring = $env:K2_AUTHORING,
    [string]$Blender = $env:K2_BLENDER,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
if (-not $Authoring) { throw 'Set K2_AUTHORING (the authoring root) or pass -Authoring.' }
if (-not $Blender) { throw 'Set K2_BLENDER (blender.exe of Blender 5.2.2 LTS) or pass -Blender.' }
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$shipped = "$repo\scripts\models\pipeline"
$pipeline = Join-Path $Authoring '_pipeline'
if ((Get-FileHash "$pipeline\meshopt_glb.mjs").Hash -ne (Get-FileHash "$shipped\meshopt_glb.mjs").Hash) { throw 'meshopt_glb.mjs copies differ' }
$results = @()
foreach ($id in $Ids) {
    $recipePath = "$repo\scripts\world\assets\$id\recipe.json"
    $recipe = Get-Content $recipePath -Raw | ConvertFrom-Json
    $raw = Join-Path $Authoring "$id\raw\$($recipe.source.candidate)\asset.glb"
    if ((Get-FileHash $raw -Algorithm SHA256).Hash.ToLowerInvariant() -ne $recipe.source.glbSha256) { throw "$id raw GLB does not match its recipe" }
    $out = Join-Path $Authoring "$id\cook\$Revision"
    if (Test-Path $out) { throw "$out exists; use a new revision" }
    $started = Get-Date
    $log = & $Blender -b --factory-startup --python "$shipped\cook_landmark.py" -- --raw $raw --recipe $recipePath --out $out 2>&1
    $cook = $log | Select-String '^K2_COOK=' | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0 -or -not $cook -or $cook.Line -notmatch 'cooked-pending-review') { $log | Select-Object -Last 30; throw "$id cook failed" }
    $glb = "$id-albedo$($recipe.albedoSizes[0]).glb"
    python "$shipped\repair_tangents.py" $out $glb | Out-Null; if ($LASTEXITCODE) { throw "$id tangent repair failed" }
    python "$shipped\quantize_prop_glb.py" $out $glb | Out-Null; if ($LASTEXITCODE) { throw "$id quantization failed" }
    Push-Location $pipeline
    try { node "$pipeline\meshopt_glb.mjs" $out $glb | Out-Null; if ($LASTEXITCODE) { throw "$id meshopt failed" } } finally { Pop-Location }
    $receipt = Get-Content "$out\cook.json" -Raw | ConvertFrom-Json
    $results += [pscustomobject]@{ id = $id; triangles = $receipt.topology.triangles; height = [math]::Round($receipt.normalization.heightMeters, 2)
        footprint = ($receipt.normalization.footprintMeters | ForEach-Object { [math]::Round($_, 2) }) -join ' x '; bytes = (Get-Item "$out\$glb").Length
        seconds = [math]::Round(((Get-Date) - $started).TotalSeconds) }
    if ($Publish) {
        New-Item -ItemType Directory -Force "$repo\public\world\$id" | Out-Null
        Copy-Item "$out\$glb" "$repo\public\world\$id\$id.glb" -Force
    }
}
$results | Format-Table -AutoSize | Out-String
