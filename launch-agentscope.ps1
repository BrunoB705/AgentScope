$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $repo 'start.ps1'

try {
    if (-not (Test-Path -LiteralPath $startScript)) {
        throw "No encontré start.ps1 en $repo."
    }

    & $startScript -NoBrowser
    if ($LASTEXITCODE -ne 0) {
        throw "La compilación o el inicio falló (código $LASTEXITCODE). Revisa los registros en $env:LOCALAPPDATA\AgentObservabilityPlatform\logs."
    }

    $programs = [Environment]::GetFolderPath('Programs')
    $shell = New-Object -ComObject WScript.Shell
    $appShortcut = Get-ChildItem -LiteralPath $programs -Filter 'AgentScope.lnk' -File -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object {
            $shortcut = $shell.CreateShortcut($_.FullName)
            if ($shortcut.TargetPath -match 'chrome_proxy\.exe$' -and $shortcut.Arguments -match '--app-id=') {
                [pscustomobject]@{ TargetPath = $shortcut.TargetPath; Arguments = $shortcut.Arguments }
            }
        } |
        Select-Object -First 1

    if (-not $appShortcut) {
        throw 'No encontré la PWA instalada de AgentScope en el menú Inicio. Reinstálala desde Chrome y vuelve a probar.'
    }

    Start-Process -FilePath $appShortcut.TargetPath -ArgumentList $appShortcut.Arguments
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
