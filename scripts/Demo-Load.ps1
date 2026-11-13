param(
    [ValidateRange(1,6)][int]$Count = 6,
    [ValidateRange(1000,2000000)][int]$Iterations = 2000000,
    [ValidateRange(0,120)][int]$CancelAfterSeconds = 0,
    [string]$BaseUrl = 'http://127.0.0.1:8088'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sample = Get-Content -Raw -LiteralPath (Join-Path $root 'public\examples\load-test.json') | ConvertFrom-Json
$submittedIds = [Collections.Generic.List[string]]::new()
function Invoke-TempoRequest([string]$Method, [string]$Path, $Body, [string]$Token) {
    $arguments = @{ Method = $Method; Uri = ($BaseUrl.TrimEnd('/') + $Path); TimeoutSec = 10 }
    if ($Token) { $arguments.Headers = @{ Authorization = "Bearer $Token" } }
    if ($null -ne $Body) {
        $arguments.ContentType = 'application/json; charset=utf-8'
        $arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress))
    }
    return Invoke-RestMethod @arguments
}
function Show-TempoLoad {
    $metrics = Invoke-TempoRequest 'GET' '/api/admin/metrics' $null $adminToken
    $workers = @($metrics.nodes | Where-Object { $_.kind -in @('worker','standby') })
    $ids = ($workers | Select-Object -ExpandProperty id) -join ', '
    Write-Host ("{0:HH:mm:ss}  ціль={1}, живі воркери={2} [{3}], виконуються={4}, у черзі={5}" -f (Get-Date), $metrics.desiredWorkers, $workers.Count, $ids, $metrics.queue.running, $metrics.queue.queued)
    return $metrics
}
$student = Invoke-TempoRequest 'POST' '/api/auth/login' @{ email = 'student@tempo.local'; password = 'TempoDemo2026!' } ''
$admin = Invoke-TempoRequest 'POST' '/api/auth/login' @{ email = 'admin@tempo.local'; password = 'TempoDemo2026!' } ''
$studentToken = $student.token
$adminToken = $admin.token
$existing = Invoke-TempoRequest 'GET' '/api/jobs' $null $studentToken
$active = @($existing.jobs | Where-Object { $_.status -in @('queued','running') }).Count
if ($active + $Count -gt 6) { throw "У демо-користувача вже є $active активних задач. Зменште Count або дочекайтеся їх завершення." }
Write-Host "Tempo: $Count розрахунків, 80 робіт, 4 ресурси, $Iterations ітерацій кожен."
Show-TempoLoad | Out-Null
try {
    for ($index = 1; $index -le $Count; $index++) {
        $sample.name = "Навантажувальний тест #$index"
        $sample.iterations = $Iterations
        $sample.seed = 4200 + $index
        $created = Invoke-TempoRequest 'POST' '/api/jobs' $sample $studentToken
        $submittedIds.Add([string]$created.job.id)
        Write-Host ("Створено #{0}: {1}; API={2}" -f $index, $created.job.id, $created.job.handled_by)
    }
    if ($CancelAfterSeconds -gt 0) {
        $until = [DateTime]::UtcNow.AddSeconds($CancelAfterSeconds)
        do {
            Start-Sleep -Seconds 2
            Show-TempoLoad | Out-Null
        } while ([DateTime]::UtcNow -lt $until)
    } else {
        Write-Host 'Задачі залишені в роботі. Прогрес і скасування доступні в історії student@tempo.local.'
    }
} finally {
    if ($CancelAfterSeconds -gt 0) {
        foreach ($jobId in $submittedIds) {
            $snapshot = Invoke-TempoRequest 'GET' "/api/jobs/$jobId" $null $studentToken
            if ($snapshot.job.status -in @('queued','running')) {
                try {
                    $cancelled = Invoke-TempoRequest 'POST' "/api/jobs/$jobId/cancel" @{} $studentToken
                    Write-Host "Скасовано лише власну тестову задачу: $jobId"
                } catch {
                    $latest = Invoke-TempoRequest 'GET' "/api/jobs/$jobId" $null $studentToken
                    if ($latest.job.status -in @('queued','running')) { throw }
                    Write-Host "Задача вже завершилася: $jobId"
                }
            } else { Write-Host ("Задача {0}: {1}" -f $jobId, $snapshot.job.status) }
        }
    }
}
if ($CancelAfterSeconds -gt 0) {
    Write-Host 'Спостереження за зменшенням кількості воркерів після 20 секунд без черги:'
    $until = [DateTime]::UtcNow.AddSeconds(32)
    do {
        Start-Sleep -Seconds 2
        $metrics = Show-TempoLoad
        $workers = @($metrics.nodes | Where-Object { $_.kind -in @('worker','standby') })
        if ($metrics.desiredWorkers -eq 2 -and $workers.Count -eq 2) { break }
    } while ([DateTime]::UtcNow -lt $until)
    if ($metrics.desiredWorkers -eq 2 -and $workers.Count -eq 2) { Write-Host 'Підтверджено повернення до двох основних воркерів.' } else { Write-Host 'Система ще обробляє задачі або завершує резервні процеси. Перевірте адмін-панель.' }
}
