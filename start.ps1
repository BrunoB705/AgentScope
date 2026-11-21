[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $env:LOCALAPPDATA 'AgentObservabilityPlatform'
$logs = Join-Path $runtime 'logs'
$data = Join-Path $runtime 'telemetry.db'
$keyFile = Join-Path $runtime 'telemetry.key'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (Test-Path $keyFile) {
    $ApiKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
} else {
    $randomBytes = New-Object byte[] 32
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $randomGenerator.GetBytes($randomBytes)
        $ApiKey = [Convert]::ToBase64String($randomBytes)
    } finally {
        $randomGenerator.Dispose()
    }
    [System.IO.File]::WriteAllText($keyFile, $ApiKey)
}
$env:TELEMETRY_API_KEY = $ApiKey
$env:OPENCODE_OBSERVABILITY_KEY = $ApiKey

$repoPlugin = Join-Path $repo 'opencode-plugin/src/index.ts'
$globalPlugin = Join-Path $env:USERPROFILE '.config\opencode\plugins\agent-observability.ts'
if ((Test-Path $repoPlugin) -and (Test-Path $globalPlugin)) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $repoPlugin).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $globalPlugin).Hash) {
        Write-Warning "El plugin global ($globalPlugin) difiere de opencode-plugin/src/index.ts. Copialo para mantener ambos sincronizados."
    }
}

function Test-Endpoint([string]$Url) {
    try { return (Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 }
    catch { return $false }
}
function Test-Port([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
}
function Wait-Endpoint([string]$Url, [int]$TimeoutSeconds, [string]$Service) {
    $until = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $until) {
        if (Test-Endpoint $Url) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "$Service no respondió. Revisa los registros en $logs."
}

if (-not (Test-Path (Join-Path $repo 'dashboard/node_modules'))) {
    Write-Host 'Instalando dependencias del dashboard…'
    Push-Location (Join-Path $repo 'dashboard')
    try { npm.cmd ci } finally { Pop-Location }
}
Write-Host 'Compilando API…'
dotnet build (Join-Path $repo 'backend/AgentObservability.Api.csproj') --configuration Release

$apiUrl = 'http://127.0.0.1:5080'
$dashboardUrl = 'http://127.0.0.1:5173'
if (-not (Test-Endpoint "$apiUrl/api/v1/health")) {
    if (Test-Port 5080) { throw 'El puerto 5080 ya está ocupado por otro proceso.' }
    $env:ASPNETCORE_URLS = $apiUrl
    $env:ASPNETCORE_ENVIRONMENT = 'Production'
    $env:Telemetry__ApiKey = $ApiKey
    $env:ConnectionStrings__Telemetry = "Data Source=$data"
    $apiDll = Join-Path $repo 'backend/bin/Release/net10.0/AgentObservability.Api.dll'
    $api = Start-Process -FilePath 'dotnet.exe' -ArgumentList @("`"$apiDll`"") -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'api.log') -RedirectStandardError (Join-Path $logs 'api-error.log')
    Set-Content -Path (Join-Path $runtime 'api.pid') -Value $api.Id
    Wait-Endpoint "$apiUrl/api/v1/health" 30 'La API'
} else { Write-Host 'API ya estaba activa.' }

if (-not (Test-Endpoint $dashboardUrl)) {
    if (Test-Port 5173) { throw 'El puerto 5173 ya está ocupado por otro proceso.' }
    $viteCli = Join-Path $repo 'dashboard/node_modules/vite/bin/vite.js'
    $dashboard = Start-Process -FilePath 'node.exe' -ArgumentList @("`"$viteCli`"", '--host', '127.0.0.1', '--port', '5173', '--strictPort') -WorkingDirectory (Join-Path $repo 'dashboard') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'dashboard.log') -RedirectStandardError (Join-Path $logs 'dashboard-error.log')
    Set-Content -Path (Join-Path $runtime 'dashboard.pid') -Value $dashboard.Id
    Wait-Endpoint $dashboardUrl 30 'El dashboard'
} else { Write-Host 'Dashboard ya estaba activo.' }

if (-not $NoBrowser) { Start-Process $dashboardUrl }
Write-Host "Dashboard: $dashboardUrl"
Write-Host "API: $apiUrl"
Write-Host "Base SQLite: $data"
Write-Host 'Para apagar los procesos iniciados por este script, ejecuta .\stop.ps1.'
