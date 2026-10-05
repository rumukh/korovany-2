#Requires -Version 7.0
<#
.SYNOPSIS
Shared guard for local GPU model jobs (WanGP/Qwen and TRELLIS): one job at a time across all sessions.

A job is busy while any of these runs: WanGP (`python.exe ... wgp.py`), a TRELLIS generation (`wsl.exe ... generate_asset.py`,
TRELLIS runs inside WSL so it never appears as a Windows python.exe), or a hold process whose command line carries
`k2-gpu-hold` (a sleeping python that reserves the GPU between two queues). Never stops or touches any of them.
#>
function Get-K2GpuJobs {
    param([int[]]$Except = @(), [switch]$IgnoreHold)
    @(Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -notin $Except -and $_.CommandLine -and (
                ($_.Name -in 'python.exe', 'pythonw.exe' -and $_.CommandLine -match 'wgp\.py|generate_asset\.py|k2-gpu-hold') -or
                ($_.Name -eq 'wsl.exe' -and $_.CommandLine -match 'generate_asset\.py')) -and
            $_.CommandLine -notmatch 'http\.server' -and -not ($IgnoreHold -and $_.CommandLine -match 'k2-gpu-hold')
        })
}

function Wait-K2GpuIdle {
    param([int[]]$Except = @(), [switch]$IgnoreHold, [int]$MaxMinutes = 240)
    for ($wait = 0; $wait -lt $MaxMinutes * 2; $wait++) {
        $busy = Get-K2GpuJobs -Except $Except -IgnoreHold:$IgnoreHold
        if (-not $busy.Count) { return }
        "$(Get-Date -Format HH:mm:ss) waiting: another GPU model job is running ($($busy.ProcessId -join ','))"
        Start-Sleep -Seconds 30
    }
    throw 'GPU-WAIT: another GPU model job is still running; nothing was started.'
}
