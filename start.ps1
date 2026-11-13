# Arranca Clipping Studio en http://127.0.0.1:8765 y lo abre en el navegador.
# Lo normal es lanzarlo con Iniciar.bat. Opciones: -NoBrowser para no abrir el navegador; -Port 8766 para otro puerto.
param([switch]$NoBrowser, [int]$Port = 8765)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$url = "http://127.0.0.1:$Port"
$env:CLIPPING_URL = $url

function Test-Url($u) {
    try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

# Si ya está abierto, solo se abre el navegador.
if (Test-Url "$url/api/health") {
    Write-Host ""
    Write-Host "Clipping Studio ya está en marcha en $url, en otra ventana."
    Write-Host "Esa otra ventana es la que mantiene la herramienta abierta: no la cierres mientras trabajas."
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host ""
    Read-Host "Pulsa Enter para cerrar esta ventana (la herramienta sigue funcionando)"
    exit 0
}

# Ollama (IA local, opcional): se arranca si está instalado y no responde.
if (-not (Test-Url "http://127.0.0.1:11434/api/tags")) {
    $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
    if (Test-Path $ollama) {
        Write-Host "Arrancando Ollama..."
        Start-Process $ollama
    } else {
        Write-Host "Ollama no está instalado: solo funcionará Claude Code como IA (es opcional)."
    }
}

# Python se instala dentro del proyecto (.python) para no depender del que haya en el sistema.
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root ".python"
$env:UV_LINK_MODE = "copy"
$venv = Join-Path $root "backend\.venv"
$python = Join-Path $venv "Scripts\python.exe"
$cfg = Join-Path $venv "pyvenv.cfg"
$venvOk = (Test-Path $python) -and (Test-Path $cfg)
if ($venvOk) {
    $home_ = (Select-String -Path $cfg -Pattern '^home\s*=\s*(.+)$').Matches[0].Groups[1].Value.Trim()
    $venvOk = Test-Path (Join-Path $home_ "python.exe")
}
if (-not $venvOk) {
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if (-not $uv) {
        $uv = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe"
    }
    if (-not (Test-Path $uv)) { throw "No se encuentra uv. Instálalo con: winget install astral-sh.uv" }
    Write-Host "Preparando el entorno de Python (solo la primera vez, puede tardar unos minutos)..."
    if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
    Push-Location (Join-Path $root "backend")
    & $uv python install 3.12
    & $uv sync
    $ok = $LASTEXITCODE -eq 0
    Pop-Location
    if (-not $ok) { throw "uv sync falló" }
}

$dist = Join-Path $root "frontend\dist\index.html"
if (-not (Test-Path $dist)) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "No se encuentra Node.js. Instálalo con: winget install OpenJS.NodeJS.LTS" }
    Write-Host "Instalando y compilando el panel (solo la primera vez)..."
    Push-Location (Join-Path $root "frontend")
    npm install
    npm run build
    $ok = $LASTEXITCODE -eq 0
    Pop-Location
    if (-not $ok) { throw "No se pudo compilar el panel (frontend)" }
}

# El navegador se abre en cuanto el servidor responde.
if (-not $NoBrowser) {
    Start-Job -ArgumentList $url -ScriptBlock {
        param($u)
        for ($i = 0; $i -lt 60; $i++) {
            try { Invoke-WebRequest -Uri "$u/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $u; return } catch { Start-Sleep -Milliseconds 500 }
        }
    } | Out-Null
}

Write-Host "Clipping Studio en $url  (cierra esta ventana para pararlo)"
$ErrorActionPreference = "Continue"  # uvicorn escribe en stderr; no debe tratarse como error de PowerShell
& $python -m uvicorn clipping.api:app --app-dir (Join-Path $root "backend") --host 127.0.0.1 --port $Port
# Sin esto PowerShell devolvería 0 aunque Python falle, y el .bat cerraría la ventana sin dejar leer el error.
exit $LASTEXITCODE
