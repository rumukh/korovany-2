#Requires -Version 7.0
<#
.SYNOPSIS
Generates TRELLIS-ready concept candidates for world objects with the azure-image-generation skill (cloud deployment
gpt-image-2.5-sunburst, approved by the owner for object concepts on 2026-10-04). Each candidate's request and the
service's reply (without credentials) are recorded beside the PNG. Writes only under <authoring>\<asset-id>\concepts;
the authoring root is -Authoring or $env:K2_AUTHORING.
#>
param(
    [Parameter(Mandatory)][string[]]$Assets,
    [string[]]$Candidates = @('a', 'b', 'c'),
    [ValidateSet('1024x1024', '1024x1536', '1536x1024')][string]$Size = '1024x1024',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max', 'auto')][string]$Quality = 'high',
    [string]$Authoring = $env:K2_AUTHORING
)
$ErrorActionPreference = 'Stop'
if (-not $Authoring) { throw 'Set K2_AUTHORING (the authoring root) or pass -Authoring.' }
$helper = "$HOME\.copilot\skills\azure-image-generation\scripts\generate-image.ps1"
foreach ($asset in $Assets) {
    $id, $assetSize = $asset.Split('@')
    if (-not $assetSize) { $assetSize = $Size }
    $concepts = Join-Path $Authoring "$id\concepts"
    $prompt = Join-Path $concepts 'prompt.txt'
    if (-not (Test-Path $prompt)) { throw "missing prompt for $id" }
    foreach ($candidate in $Candidates) {
        $out = Join-Path $concepts "candidate-$candidate.png"
        if (Test-Path $out) { "skip $id $candidate (exists)"; continue }
        $started = Get-Date
        $text = & $helper -PromptFile $prompt -Size $assetSize -Quality $Quality -OutputPath $out 2>&1 | Out-String
        $reply = $text.Substring($text.IndexOf('{')) | ConvertFrom-Json
        $record = [ordered]@{
            schema = 'korovany2-azure-concept/1'
            asset = $id
            candidate = $candidate
            tool = 'azure-image-generation skill, Azure OpenAI deployment gpt-image-2.5-sunburst (cloud)'
            requestedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz')
            seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
            size = $assetSize
            quality = $Quality
            servedQuality = $reply.quality
            revisedPrompt = $reply.revised_prompt
            promptSha256 = (Get-FileHash $prompt -Algorithm SHA256).Hash.ToLower()
            imageSha256 = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
            width = $reply.width
            height = $reply.height
        }
        [IO.File]::WriteAllText((Join-Path $concepts "candidate-$candidate.json"), ($record | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
        "{0} {1} {2} {3:N0} s" -f (Get-Date -Format HH:mm:ss), $id, $candidate, $record.seconds
    }
}
