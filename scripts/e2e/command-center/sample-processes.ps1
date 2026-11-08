param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($config.processes.Count -ne 3) { throw 'Exactly three owned processes are required' }
foreach ($entry in $config.processes) {
    if ($entry.pid -le 0 -or $entry.role -notin @('coordinator', 'host', 'sidecar')) { throw 'Invalid owned process' }
}
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$stopwatchLimit = [double]$config.deadlineMs
$sampleMs = if ($config.sampleMs) { [double]$config.sampleMs } else { 100.0 }
if ($sampleMs -lt 100 -or $sampleMs -gt 1000) { throw 'Invalid sampling interval' }
$target = 0.0
while ($clock.Elapsed.TotalMilliseconds -lt $stopwatchLimit) {
    if (Test-Path -LiteralPath $config.stopFile) { break }
    $began = $clock.Elapsed.TotalMilliseconds
    $rows = @()
    foreach ($entry in $config.processes) {
        try {
            $owned = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
            $owned.Refresh()
            $rows += @{role=$entry.role;pid=[int]$entry.pid;startTime=$owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();privateBytes=[double]$owned.PrivateMemorySize64;workingSetBytes=[double]$owned.WorkingSet64;cpuSeconds=[double]$owned.TotalProcessorTime.TotalSeconds;handles=[int]$owned.HandleCount;threads=[int]$owned.Threads.Count}
            $owned.Dispose()
        } catch {
            $rows += @{role=$entry.role;pid=[int]$entry.pid;missing=$true}
        }
    }
    $sample = @{timestampMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();collectionMs=($clock.Elapsed.TotalMilliseconds-$began);processes=$rows}
    [Console]::WriteLine(($sample | ConvertTo-Json -Compress -Depth 5))
    $target += $sampleMs
    $wait = $target - $clock.Elapsed.TotalMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) } else { $target = $clock.Elapsed.TotalMilliseconds }
}
