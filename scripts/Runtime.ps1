$ErrorActionPreference = 'Stop'
$script:TempoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:TempoRuntime = Join-Path $script:TempoRoot '.runtime'
$script:TempoTools = Join-Path $script:TempoRoot 'tools'

function Get-TempoPaths {
    $savedPath = Join-Path $script:TempoRuntime 'tool-paths.json'
    if (Test-Path -LiteralPath $savedPath) {
        $saved = Get-Content -Raw -LiteralPath $savedPath | ConvertFrom-Json
        if ((Test-Path -LiteralPath (Join-Path $saved.nodeDir 'node.exe')) -and (Test-Path -LiteralPath (Join-Path $saved.postgresBin 'pg_ctl.exe')) -and (Test-Path -LiteralPath (Join-Path $saved.nginxDir 'nginx.exe'))) { return $saved }
    }
    $nodeDir = Join-Path $script:TempoTools 'node-v22.23.5-win-x64'
    $nginxDir = Join-Path $script:TempoTools 'nginx-1.30.6'
    $pgCandidate = Get-ChildItem -Path (Join-Path $env:ProgramFiles 'PostgreSQL\*\bin\pg_ctl.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    $postgresBin = if ($env:TEMPO_POSTGRES_BIN) { $env:TEMPO_POSTGRES_BIN } elseif ($pgCandidate) { $pgCandidate.DirectoryName } else { Join-Path $script:TempoTools 'pgsql\bin' }
    return [pscustomobject]@{ nodeDir = $nodeDir; nginxDir = $nginxDir; postgresBin = $postgresBin }
}

function Import-TempoEnvironment {
    $environmentPath = Join-Path $script:TempoRoot '.env'
    if (Test-Path -LiteralPath $environmentPath) {
        foreach ($line in Get-Content -LiteralPath $environmentPath) {
            if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
                [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"').Trim("'"), 'Process')
            }
        }
    }
    $env:PATH = (Get-TempoPaths).nodeDir + ';' + $env:PATH
}

function Test-TempoProcess($record) {
    if (-not $record) { return $false }
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    try { return [Math]::Abs(($process.StartTime.ToUniversalTime() - ([DateTime]$record.started).ToUniversalTime()).TotalMilliseconds) -lt 10 } catch { return $false }
}

function Get-TempoProcesses {
    $processPath = Join-Path $script:TempoRuntime 'processes.json'
    if (Test-Path -LiteralPath $processPath) { return @(Get-Content -Raw -LiteralPath $processPath | ConvertFrom-Json) }
    return @()
}

function Wait-TempoHttp([string]$url, [int]$seconds = 25) {
    $until = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri $url -TimeoutSec 2
            if ($response.status -eq 'ok') { return $response }
        } catch {}
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $until)
    throw "Service did not become ready: $url. See .runtime logs."
}
