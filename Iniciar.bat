@echo off
rem Doble clic para arrancar Clipping Studio (servidor + Ollama si lo tienes + navegador).
title Clipping Studio
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
    echo.
    echo Clipping Studio se ha cerrado con un error. Revisa el mensaje de arriba
    echo y el registro de la app en data\logs\app.log
    pause
)
