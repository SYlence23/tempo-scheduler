param([string]$PostgresBin)
. (Join-Path $PSScriptRoot 'Runtime.ps1')
New-Item -ItemType Directory -Force -Path $script:TempoTools, $script:TempoRuntime, (Join-Path $script:TempoRuntime 'logs'), (Join-Path $script:TempoRuntime 'temp') | Out-Null
if ($PostgresBin) { $env:TEMPO_POSTGRES_BIN = [IO.Path]::GetFullPath($PostgresBin) }
$paths = Get-TempoPaths
if (-not (Test-Path -LiteralPath (Join-Path $paths.nodeDir 'node.exe'))) {
    $archive = Join-Path $script:TempoTools 'node.zip'
    Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip' -OutFile $archive
    $sums = (Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.23.5/SHASUMS256.txt').Content
    $expected = ($sums -split "`n" | Where-Object { $_ -match '\snode-v22\.23\.5-win-x64\.zip\s*$' } | Select-Object -First 1).Trim().Split(' ')[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Node.js checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $script:TempoTools -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $paths.nginxDir 'nginx.exe'))) {
    $archive = Join-Path $script:TempoTools 'nginx.zip'
    Invoke-WebRequest -Uri 'https://nginx.org/download/nginx-1.30.6.zip' -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $script:TempoTools -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $paths.postgresBin 'initdb.exe'))) { throw 'PostgreSQL binaries not found. Install PostgreSQL or use -PostgresBin C:\path\to\pgsql\bin. Docker Compose is an alternative.' }
$paths | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:TempoRuntime 'tool-paths.json') -Encoding UTF8
$environmentPath = Join-Path $script:TempoRoot '.env'
if (-not (Test-Path -LiteralPath $environmentPath)) {
    $secretBytes = New-Object byte[] 48
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($secretBytes)
    $generator.Dispose()
    $secret = [Convert]::ToBase64String($secretBytes)
    @("DATABASE_URL=postgresql://tempo:tempo_local_demo@127.0.0.1:55432/tempo", "JWT_SECRET=$secret", 'SEED_DEMO=true', 'HOST=127.0.0.1', 'MAX_ACTIVE_JOBS=6', 'MAX_TASKS=80', 'MAX_RESOURCES=8', 'MAX_ITERATIONS=2000000', 'TASK_TIMEOUT_SECONDS=120') | Set-Content -LiteralPath $environmentPath -Encoding UTF8
}
Import-TempoEnvironment
$dataPath = Join-Path $script:TempoRuntime 'postgres'
if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'PG_VERSION'))) {
    $passwordPath = Join-Path $script:TempoRuntime 'pg-password.txt'
    Set-Content -LiteralPath $passwordPath -Value 'tempo_local_demo' -NoNewline
    try {
        & (Join-Path $paths.postgresBin 'initdb.exe') -D $dataPath -U tempo "--pwfile=$passwordPath" --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C -c max_connections=60 -c shared_buffers=32MB
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed' }
    } finally { Remove-Item -LiteralPath $passwordPath -Force -ErrorAction SilentlyContinue }
}
if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'global\pg_control'))) { throw 'PostgreSQL cluster initialization is incomplete. Inspect .runtime/postgres before retrying.' }
if (-not (Test-Path -LiteralPath (Join-Path $script:TempoRoot 'node_modules\express\package.json'))) {
    Push-Location $script:TempoRoot
    try {
        $npmCommand = if (Test-Path -LiteralPath (Join-Path $script:TempoRoot 'package-lock.json')) { 'ci' } else { 'install' }
        & (Join-Path $paths.nodeDir 'node.exe') (Join-Path $paths.nodeDir 'node_modules\npm\bin\npm-cli.js') $npmCommand --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed' }
    } finally { Pop-Location }
}
Write-Host 'Tempo runtime is ready.'
