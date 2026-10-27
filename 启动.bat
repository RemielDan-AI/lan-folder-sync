@echo off
chcp 65001 >nul
title Communication LAN Sync
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Please install Node.js 20 or newer from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server.js

echo.
echo   Server stopped.
pause
