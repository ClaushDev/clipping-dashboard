# Instala el entorno opcional de modelos locales del editor (PyTorch CUDA + transformers). Unos 3-4 GB de descarga.
# Necesita una GPU NVIDIA. Sin él, la herramienta funciona igual; solo se desactivan «Recortar sujeto»,
# «Seguir un punto» y «Buscar objetos» del editor.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root ".python"
$env:UV_LINK_MODE = "copy"
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { $uv = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe" }
if (-not (Test-Path $uv)) { Write-Host "No encuentro uv. Instálalo con: winget install astral-sh.uv"; exit 1 }
Push-Location $PSScriptRoot
& $uv python install 3.12
& $uv sync
$code = $LASTEXITCODE
Pop-Location
if ($code -eq 0) { Write-Host "Entorno ML listo." } else { Write-Host "La instalación falló (código $code)." }
exit $code
