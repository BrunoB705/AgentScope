$ErrorActionPreference = 'Stop'

$faltantes = @()
$pythonPaquetesFaltantes = $false

function Test-Comando {
    param([string]$Nombre)
    Get-Command $Nombre -ErrorAction SilentlyContinue
}

$dotnet = Test-Comando 'dotnet'
if ($dotnet) {
    $dotnetVersion = (& dotnet --version 2>$null | Select-Object -First 1)
    $dotnetMajor = [int]($dotnetVersion.Split('.')[0])
    if ($dotnetMajor -ge 10) {
        "OK     dotnet $dotnetVersion"
    }
    else {
        "FALTA  dotnet (se encontro $dotnetVersion, se requiere 10 o superior)"
        $faltantes += 'dotnet'
    }
}
else {
    "FALTA  dotnet (no esta en el PATH)"
    $faltantes += 'dotnet'
}

$node = Test-Comando 'node'
if ($node) {
    $nodeVersion = (& node --version 2>$null | Select-Object -First 1).TrimStart('v')
    $partes = $nodeVersion.Split('.')
    $nodeMajor = [int]$partes[0]
    $nodeMinor = [int]$partes[1]
    if ($nodeMajor -gt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -ge 18)) {
        "OK     node $nodeVersion"
    }
    else {
        "FALTA  node (se encontro $nodeVersion, se requiere 22.18 o superior para la suite de TypeScript)"
        $faltantes += 'node'
    }
}
else {
    "FALTA  node (no esta en el PATH)"
    $faltantes += 'node'
}

$python = Test-Comando 'python'
if ($python) {
    $pythonVersion = (& python --version 2>&1 | Select-Object -First 1)
    & python -c "import fastapi, httpx" 2>$null
    if ($LASTEXITCODE -eq 0) {
        "OK     python ($pythonVersion, con fastapi y httpx)"
    }
    else {
        "FALTA  python (esta $pythonVersion, pero faltan los paquetes fastapi y httpx)"
        $faltantes += 'python'
        $pythonPaquetesFaltantes = $true
    }
}
else {
    "FALTA  python (no esta en el PATH)"
    $faltantes += 'python'
}

$git = Test-Comando 'git'
if ($git) {
    $gitVersion = (& git --version 2>$null | Select-Object -First 1)
    "OK     $gitVersion"
}
else {
    "FALTA  git (no esta en el PATH)"
    $faltantes += 'git'
}

$opencode = Test-Comando 'opencode'
if ($opencode) {
    "OK     opencode"
}
else {
    "FALTA  opencode (no esta en el PATH)"
    $faltantes += 'opencode'
}

if ($faltantes.Count -gt 0) {
    ""
    "Falta: $($faltantes -join ', ')"
    if ($pythonPaquetesFaltantes) {
        "Instala los paquetes de Python con: pip install -r benchmarks/python-fastapi/requirements.txt"
    }
    exit 1
}

""
"Todo listo para correr las suites."
exit 0
