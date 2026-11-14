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

    if (-not ('AgentScopeWindowMonitor' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentScopeWindowMonitor
{
    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);

    public static string[] GetVisibleWindowTitles()
    {
        var titles = new List<string>();
        EnumWindows((handle, state) => {
            if (!IsWindowVisible(handle)) return true;
            var text = new StringBuilder(512);
            if (GetWindowText(handle, text, text.Capacity) > 0 && text.Length > 0)
                titles.Add(text.ToString());
            return true;
        }, IntPtr.Zero);
        return titles.ToArray();
    }
}
'@
    }

    $windowPattern = '^AgentScope(?:$|\s|[-–—])'
    $launchDeadline = (Get-Date).AddSeconds(60)
    $windowFound = $false
    while ((Get-Date) -lt $launchDeadline) {
        if ([AgentScopeWindowMonitor]::GetVisibleWindowTitles() | Where-Object { $_ -match $windowPattern }) {
            $windowFound = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if (-not $windowFound) {
        [Console]::Error.WriteLine('La PWA se lanzó, pero no pude detectar su ventana. Los servicios siguen activos; ejecuta .\stop.ps1 para apagarlos.')
        exit 2
    }

    while ([AgentScopeWindowMonitor]::GetVisibleWindowTitles() | Where-Object { $_ -match $windowPattern }) {
        Start-Sleep -Seconds 1
    }

    # Grace period prevents a quick app restart from stopping services in use.
    Start-Sleep -Seconds 3
    if ([AgentScopeWindowMonitor]::GetVisibleWindowTitles() | Where-Object { $_ -match $windowPattern }) {
        while ([AgentScopeWindowMonitor]::GetVisibleWindowTitles() | Where-Object { $_ -match $windowPattern }) {
            Start-Sleep -Seconds 1
        }
    }

    $stopScript = Join-Path $repo 'stop.ps1'
    & $stopScript
    if ($LASTEXITCODE -ne 0) {
        throw "La ventana se cerró, pero stop.ps1 devolvió el código $LASTEXITCODE. Ejecuta .\stop.ps1 manualmente."
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
