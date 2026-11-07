[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $env:LOCALAPPDATA 'AgentObservabilityPlatform'
$targets = @(
    @{ Name = 'dashboard'; Port = 5173; Pattern = '(?i)(^|[\\/])vite(\.js)?(?:\s|$)' },
    @{ Name = 'api'; Port = 5080; Pattern = '(?i)AgentObservability\.Api\.dll' }
)
$stopped = @{}
$foundService = $false

foreach ($target in $targets) {
    $pidPath = Join-Path $runtime "$($target.Name).pid"
    if (Test-Path -LiteralPath $pidPath) {
        $processId = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$processId)) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            if ($process -and $process.CommandLine -match $target.Pattern) {
                if (-not $stopped.ContainsKey($processId)) {
                    Stop-Process -Id $processId -Force
                    $stopped[$processId] = $true
                }
                Write-Host "Detenido $($target.Name) (PID $processId)."
                $foundService = $true
            } elseif ($process) {
                Write-Host "El PID guardado de $($target.Name) pertenece a otro proceso; no lo detuve."
            } else {
                Write-Host "El PID guardado de $($target.Name) ya no estaba activo."
            }
        }
        Remove-Item -LiteralPath $pidPath -Force
    }

    $listeners = Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $processId = [int]$listener.OwningProcess
        if ($stopped.ContainsKey($processId)) { continue }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -match $target.Pattern) {
            Stop-Process -Id $processId -Force
            $stopped[$processId] = $true
            Write-Host "Detenido $($target.Name) por el puerto $($target.Port) (PID $processId)."
            $foundService = $true
        } elseif ($process) {
            Write-Host "El puerto $($target.Port) lo usa $($process.Name) (PID $processId); no lo detuve porque no parece ser este proyecto."
        }
    }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    Push-Location $repo
    try {
        $containerIds = @(& docker compose ps --quiet 2>$null)
        if ($LASTEXITCODE -eq 0 -and $containerIds.Count -gt 0) {
            & docker compose down
            if ($LASTEXITCODE -eq 0) {
                Write-Host 'Contenedores de Agent Observability detenidos.'
                $foundService = $true
            }
        }
    } finally {
        Pop-Location
    }
}

if (-not $foundService) {
    Write-Host 'No encontré servicios de Agent Observability activos en 5080/5173 ni contenedores de este proyecto.'
}
