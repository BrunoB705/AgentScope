$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:LOCALAPPDATA 'AgentObservabilityPlatform'
foreach ($name in @('dashboard', 'api')) {
    $pidPath = Join-Path $runtime "$name.pid"
    if (Test-Path $pidPath) {
        $processId = [int](Get-Content $pidPath -Raw)
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) { Stop-Process -Id $processId -ErrorAction SilentlyContinue; Write-Host "Detenido $name (PID $processId)." }
        Remove-Item -LiteralPath $pidPath -Force
    }
}
