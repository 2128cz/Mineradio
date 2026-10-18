@echo off
setlocal
chcp 65001 >nul
title Mineradio dev restart

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-restart.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo Restart failed with code %RC%.
  echo See startup-error.log inside the Mineradio user data folder.
  pause
)

exit /b %RC%
