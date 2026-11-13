param([switch]$KeepDatabase, [ValidateRange(10,600)][int]$DrainSeconds=150)
. (Join-Path $PSScriptRoot 'Runtime.ps1')
$paths = Get-TempoPaths
Set-Content -LiteralPath (Join-Path $script:TempoRuntime 'stop.request') -Value 'stop'
$records = @(Get-TempoProcesses)
$until = [DateTime]::UtcNow.AddSeconds($DrainSeconds)
Write-Host 'Waiting for Python workers to finish active optimization jobs...'
while ((@($records | Where-Object { $_.name -in @('supervisor','worker1','worker2') -and (Test-TempoProcess $_) }).Count -gt 0) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 250 }
if (@($records | Where-Object { $_.name -in @('supervisor','worker1','worker2') -and (Test-TempoProcess $_) }).Count -gt 0) { throw 'Workers are still draining; database remains running. Retry after they finish.' }
foreach ($record in $records) { if (Test-TempoProcess $record) { Stop-Process -Id $record.id -Force -ErrorAction SilentlyContinue } }
Remove-Item -LiteralPath (Join-Path $script:TempoRuntime 'processes.json') -Force -ErrorAction SilentlyContinue
if (-not $KeepDatabase) {
    $dataPath = Join-Path $script:TempoRuntime 'postgres'
    if (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid')) { & (Join-Path $paths.postgresBin 'pg_ctl.exe') -D $dataPath -m fast -w -t 30 stop }
}
Write-Host 'Tempo services stopped. PostgreSQL data and history are preserved.'
