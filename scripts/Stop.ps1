param([switch]$KeepDatabase, [ValidateRange(10, 600)][int]$DrainSeconds = 150)
. (Join-Path $PSScriptRoot 'Runtime.ps1')
$paths = Get-TempoPaths
if (Test-Path -LiteralPath (Join-Path $script:TempoRuntime 'nginx.pid')) {
    Push-Location $script:TempoRuntime
    try { & (Join-Path $paths.nginxDir 'nginx.exe') -p './' -c nginx.conf -s quit } finally { Pop-Location }
}
Set-Content -LiteralPath (Join-Path $script:TempoRuntime 'stop.request') -Value 'stop'
$records = @(Get-TempoProcesses)
$supervisor = $records | Where-Object { $_.name -eq 'supervisor' } | Select-Object -First 1
$until = [DateTime]::UtcNow.AddSeconds($DrainSeconds)
Write-Host 'Waiting for active optimization jobs to finish...'
while ((($records | Where-Object { ($_.name -in @('supervisor', 'worker1', 'worker2')) -and (Test-TempoProcess $_) }).Count -gt 0) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 250 }
$draining = @($records | Where-Object { ($_.name -in @('supervisor', 'worker1', 'worker2')) -and (Test-TempoProcess $_) })
if ($draining.Count -gt 0) { throw 'Workers are still draining. Database and API remain running. Retry Stop.ps1 after the current job finishes.' }
foreach ($record in $records) {
    if (Test-TempoProcess $record) { Stop-Process -Id $record.id -Force -ErrorAction SilentlyContinue }
}
if (Test-Path -LiteralPath (Join-Path $script:TempoRuntime 'processes.json')) { Remove-Item -LiteralPath (Join-Path $script:TempoRuntime 'processes.json') -Force }
if (-not $KeepDatabase) {
    $dataPath = Join-Path $script:TempoRuntime 'postgres'
    if (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid')) { & (Join-Path $paths.postgresBin 'pg_ctl.exe') -D $dataPath -m fast -w -t 30 stop }
}
Write-Host 'Tempo services stopped. Database files and history are preserved.'
