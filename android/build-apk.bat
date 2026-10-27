@echo off
rem Build the Android APK (debug, installable by sideloading).
rem All messages are ASCII on purpose: cmd reads .bat with the OEM codepage.
chcp 65001 >nul
title Build CommSync APK
cd /d "%~dp0"

set "JAVA_HOME=C:\Program Files\Java\jdk-17"
if not exist "%JAVA_HOME%\bin\java.exe" set "JAVA_HOME=C:\Program Files\Java\jdk-21.0.10"
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo [ERROR] No JDK found. Install JDK 17 and edit JAVA_HOME in this file.
  pause
  exit /b 1
)
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%JAVA_HOME%\bin;%PATH%"

if not exist "tools\gradle-8.9\bin\gradle.bat" (
  echo [ERROR] Gradle not found. Run: powershell -ExecutionPolicy Bypass -File tools\fetch-gradle.ps1
  pause
  exit /b 1
)

echo Building...
call "tools\gradle-8.9\bin\gradle.bat" assembleDebug --console=plain
if errorlevel 1 (
  echo.
  echo BUILD FAILED
  pause
  exit /b 1
)

if not exist out mkdir out
copy /y "app\build\outputs\apk\debug\app-debug.apk" "out\commsync-mobile.apk" >nul
echo.
echo BUILD OK
echo APK: %~dp0out\commsync-mobile.apk
echo Install: adb install -r out\commsync-mobile.apk
pause
