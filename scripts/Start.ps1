param([switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'Runtime.ps1')
& (Join-Path $PSScriptRoot 'Provision.ps1')
$paths = Get-TempoPaths
Import-TempoEnvironment
$dataPath = Join-Path $script:TempoRuntime 'postgres'
$pgCtl = Join-Path $paths.postgresBin 'pg_ctl.exe'
& $pgCtl -D $dataPath status *> $null
if ($LASTEXITCODE -ne 0) {
    & $pgCtl -D $dataPath -l (Join-Path $script:TempoRuntime 'postgres.log') -o '-p 55432 -h 127.0.0.1' -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start' }
}
$previousPassword = $env:PGPASSWORD
$env:PGPASSWORD = 'tempo_local_demo'
try {
    $databaseExists = & (Join-Path $paths.postgresBin 'psql.exe') -h 127.0.0.1 -p 55432 -U tempo -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='tempo'"
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL connection failed' }
    if ($databaseExists -ne '1') { & (Join-Path $paths.postgresBin 'createdb.exe') -h 127.0.0.1 -p 55432 -U tempo tempo }
} finally { if ($null -eq $previousPassword) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $previousPassword } }
Push-Location $script:TempoRoot
try {
    & (Join-Path $paths.nodeDir 'node.exe') 'backend/initialize.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed' }
} finally { Pop-Location }
Remove-Item -LiteralPath (Join-Path $script:TempoRuntime 'stop.request') -Force -ErrorAction SilentlyContinue
$records = [Collections.Generic.List[object]]::new()
foreach ($entry in Get-TempoProcesses) { if (Test-TempoProcess $entry) { $records.Add($entry) } }
function Start-TempoService([string]$name, [string]$executable, [string[]]$arguments, [hashtable]$variables) {
    if ($records | Where-Object { $_.name -eq $name }) { return }
    $savedVariables = @{}
    foreach ($key in $variables.Keys) { $savedVariables[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, [string]$variables[$key], 'Process') }
    try {
        $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $script:TempoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:TempoRuntime "$name.log") -RedirectStandardError (Join-Path $script:TempoRuntime "$name.error.log")
        $records.Add([pscustomobject]@{ name = $name; id = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o'); executable = $executable })
        $records | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $script:TempoRuntime 'processes.json') -Encoding utf8
    } finally {
        foreach ($key in $variables.Keys) { if ($null -eq $savedVariables[$key]) { Remove-Item -LiteralPath ('Env:\' + $key) -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($key, $savedVariables[$key], 'Process') } }
    }
}
$node = Join-Path $paths.nodeDir 'node.exe'
$python = $paths.pythonExe
$apiEntrypoint = '"' + (Join-Path $script:TempoRoot 'backend\index.mjs') + '"'
Start-TempoService 'api1' $node @($apiEntrypoint) @{ PORT=3101; SERVER_ID='API_1'; HOST='127.0.0.1' }
Start-TempoService 'api2' $node @($apiEntrypoint) @{ PORT=3102; SERVER_ID='API_2'; HOST='127.0.0.1' }
Start-TempoService 'worker1' $python @('-m','backend.python.worker') @{ WORKER_ID='WORKER_1'; WORKER_SLOT=1 }
Start-TempoService 'worker2' $python @('-m','backend.python.worker') @{ WORKER_ID='WORKER_2'; WORKER_SLOT=2 }
Start-TempoService 'autoscaler' $python @('-m','backend.python.autoscaler') @{}
Start-TempoService 'supervisor' $python @('-m','backend.python.supervisor') @{}
Wait-TempoHttp 'http://127.0.0.1:3101/api/health' | Out-Null
Wait-TempoHttp 'http://127.0.0.1:3102/api/health' | Out-Null
$openssl = @('C:\Program Files\Git\usr\bin\openssl.exe','C:\Program Files\Git\mingw64\bin\openssl.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($openssl -and -not (Test-Path -LiteralPath (Join-Path $script:TempoRuntime 'localhost.crt'))) {
    Push-Location $script:TempoRuntime
    try {
        & $openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout localhost.key -out localhost.crt -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2> certificate.log
        if ($LASTEXITCODE -ne 0) { throw 'Could not generate local HTTPS certificate' }
    } finally { Pop-Location }
}
Start-TempoService 'balancer' $python @('-m','backend.python.balancer') @{ UPSTREAM_URLS='http://127.0.0.1:3101,http://127.0.0.1:3102'; BALANCER_HOST='127.0.0.1'; BALANCER_PORT=8088; BALANCER_HTTPS_PORT=8443 }
Wait-TempoHttp 'http://127.0.0.1:8088/api/health' | Out-Null
Write-Host 'Tempo: http://localhost:8088'
Write-Host 'Balancer and workers: Python. API: Node.js.'
if (Test-Path -LiteralPath (Join-Path $script:TempoRuntime 'localhost.crt')) { Write-Host 'HTTPS: https://localhost:8443 (local self-signed certificate)' }
Write-Host 'Logs: .runtime/'
if (-not $NoBrowser) { Start-Process 'http://localhost:8088' }
