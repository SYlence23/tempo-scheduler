. (Join-Path $PSScriptRoot 'Runtime.ps1')
$paths = Get-TempoPaths
foreach ($record in Get-TempoProcesses) { [pscustomobject]@{ Service = $record.name; PID = $record.id; Running = (Test-TempoProcess $record) } }
$pgReady = & (Join-Path $paths.postgresBin 'pg_isready.exe') -h 127.0.0.1 -p 55432 2>&1
Write-Host $pgReady
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/health' -TimeoutSec 3
    Write-Host "Nginx -> $($health.server): $($health.status), PostgreSQL: $($health.database)"
} catch { Write-Host 'Nginx/API is not available on localhost:8088' }
