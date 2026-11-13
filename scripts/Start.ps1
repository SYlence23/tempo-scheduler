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
    if ($databaseExists -ne '1') {
        & (Join-Path $paths.postgresBin 'createdb.exe') -h 127.0.0.1 -p 55432 -U tempo tempo
        if ($LASTEXITCODE -ne 0) { throw 'Could not create tempo database' }
    }
} finally { if ($null -eq $previousPassword) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $previousPassword } }
Push-Location $script:TempoRoot
try {
    & (Join-Path $paths.nodeDir 'node.exe') 'server/initialize.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Database schema initialization failed' }
} finally { Pop-Location }
$stopRequest = Join-Path $script:TempoRuntime 'stop.request'
if (Test-Path -LiteralPath $stopRequest) { Remove-Item -LiteralPath $stopRequest -Force }
$records = [Collections.Generic.List[object]]::new()
foreach ($entry in Get-TempoProcesses) { if (Test-TempoProcess $entry) { $records.Add($entry) } }
function Start-TempoNode([string]$name, [string]$entrypoint, [hashtable]$variables) {
    if ($records | Where-Object { $_.name -eq $name }) { return }
    $savedVariables = @{}
    foreach ($key in $variables.Keys) { $savedVariables[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, [string]$variables[$key], 'Process') }
    try {
        $stdout = Join-Path $script:TempoRuntime "$name.log"
        $stderr = Join-Path $script:TempoRuntime "$name.error.log"
        $process = Start-Process -FilePath (Join-Path $paths.nodeDir 'node.exe') -ArgumentList ('"' + (Join-Path $script:TempoRoot $entrypoint) + '"') -WorkingDirectory $script:TempoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $records.Add([pscustomobject]@{ name = $name; id = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o'); executable = (Join-Path $paths.nodeDir 'node.exe') })
        $records | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $script:TempoRuntime 'processes.json') -Encoding UTF8
    } finally { foreach ($key in $variables.Keys) { if ($null -eq $savedVariables[$key]) { Remove-Item -LiteralPath ('Env:\' + $key) -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($key, $savedVariables[$key], 'Process') } } }
}
Start-TempoNode 'api1' 'server/index.mjs' @{ PORT = 3101; SERVER_ID = 'API_1'; HOST = '127.0.0.1' }
Start-TempoNode 'api2' 'server/index.mjs' @{ PORT = 3102; SERVER_ID = 'API_2'; HOST = '127.0.0.1' }
Start-TempoNode 'worker1' 'server/worker.mjs' @{ WORKER_ID = 'WORKER_1'; WORKER_SLOT = 1 }
Start-TempoNode 'worker2' 'server/worker.mjs' @{ WORKER_ID = 'WORKER_2'; WORKER_SLOT = 2 }
Start-TempoNode 'autoscaler' 'server/autoscaler.mjs' @{}
Start-TempoNode 'supervisor' 'server/supervisor.mjs' @{}
Wait-TempoHttp 'http://127.0.0.1:3101/api/health' | Out-Null
Wait-TempoHttp 'http://127.0.0.1:3102/api/health' | Out-Null
$openssl = @('C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files\Git\mingw64\bin\openssl.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$certificatePath = Join-Path $script:TempoRuntime 'localhost.crt'
$keyPath = Join-Path $script:TempoRuntime 'localhost.key'
if ($openssl -and (-not (Test-Path -LiteralPath $certificatePath))) {
    Push-Location $script:TempoRuntime
    try {
        & $openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout localhost.key -out localhost.crt -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2> certificate.log
        if ($LASTEXITCODE -ne 0) { throw 'Could not generate local HTTPS certificate' }
    } finally { Pop-Location }
}
$ssl = if ((Test-Path -LiteralPath $certificatePath) -and (Test-Path -LiteralPath $keyPath)) { "listen 8443 ssl;`n        ssl_certificate localhost.crt;`n        ssl_certificate_key localhost.key;`n        ssl_protocols TLSv1.2 TLSv1.3;" } else { '' }
$configuration = @'
worker_processes 1;
pid nginx.pid;
error_log nginx-error.log;
events { worker_connections 1024; }
http {
    log_format tempo '$remote_addr [$time_local] "$request_method $uri $server_protocol" $status upstream=$upstream_addr';
    access_log nginx-access.log tempo;
    upstream api_servers {
        least_conn;
        server 127.0.0.1:3101;
        server 127.0.0.1:3102;
    }
    server {
        listen 8088;
        __SSL__
        server_name localhost;
        client_max_body_size 2m;
        add_header X-Handled-By $upstream_addr always;
        location / {
            proxy_pass http://api_servers;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Connection "";
            proxy_buffering off;
            proxy_read_timeout 180s;
        }
    }
}
'@
[IO.File]::WriteAllText((Join-Path $script:TempoRuntime 'nginx.conf'), $configuration.Replace('__SSL__', $ssl), [Text.UTF8Encoding]::new($false))
$prefix = './'
$nginx = Join-Path $paths.nginxDir 'nginx.exe'
Push-Location $script:TempoRuntime
try {
    & $nginx -p $prefix -c nginx.conf -t
    if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration is invalid' }
} finally { Pop-Location }
$nginxPidPath = Join-Path $script:TempoRuntime 'nginx.pid'
$nginxRunning = $false
if (Test-Path -LiteralPath $nginxPidPath) {
    $nginxPid = [int](Get-Content -LiteralPath $nginxPidPath)
    $existingNginx = Get-Process -Id $nginxPid -ErrorAction SilentlyContinue
    $nginxRunning = $existingNginx -and $existingNginx.ProcessName -eq 'nginx'
}
if ($nginxRunning) {
    Push-Location $script:TempoRuntime
    try { & $nginx -p $prefix -c nginx.conf -s reload } finally { Pop-Location }
} else { Start-Process -FilePath $nginx -ArgumentList @('-p', $prefix, '-c', 'nginx.conf') -WorkingDirectory $script:TempoRuntime -WindowStyle Hidden | Out-Null }
Wait-TempoHttp 'http://127.0.0.1:8088/api/health' | Out-Null
Write-Host 'Tempo: http://localhost:8088'
if ($ssl) { Write-Host 'HTTPS: https://localhost:8443 (local self-signed certificate)' }
Write-Host 'Demo administrator: admin@tempo.local'
Write-Host 'Logs: .runtime/'
if (-not $NoBrowser) { Start-Process 'http://localhost:8088' }
