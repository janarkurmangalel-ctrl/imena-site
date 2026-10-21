@echo off
chcp 65001 >nul
title Имена — анализ резюме
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-resumes.ps1"
echo.
echo Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
