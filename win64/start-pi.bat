@echo off
setlocal EnableExtensions

set "PWSH_EXE="
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe" (
  set "PWSH_EXE=%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe"
) else (
  for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do (
    if not defined PWSH_EXE set "PWSH_EXE=%%P"
  )
)

if not defined PWSH_EXE (
  if exist "C:\Program Files\PowerShell\7\pwsh.exe" (
    set "PWSH_EXE=C:\Program Files\PowerShell\7\pwsh.exe"
  )
)

if not defined PWSH_EXE (
  echo [ERROR] PowerShell 7 ^(pwsh.exe^) not found. Install via: winget install Microsoft.PowerShell
  if /i "%PI_NO_PAUSE%"=="1" exit /b 1
  if "%~1"=="" pause
  exit /b 1
)

set "PI_PS1_SCRIPT=%~dp0start-pi.ps1"
set "WT_EXE="
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe" (
  set "WT_EXE=%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe"
) else (
  for /f "delims=" %%W in ('where wt.exe 2^>nul') do (
    if not defined WT_EXE set "WT_EXE=%%W"
  )
)

if "%~1"=="" if /i not "%PI_NO_PAUSE%"=="1" if defined WT_EXE (
  net session >nul 2>&1
  if errorlevel 1 (
    "%PWSH_EXE%" -NoLogo -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%WT_EXE%' -Verb RunAs -ArgumentList @('-p', 'PowerShell', '-d', '%CD%', '%PWSH_EXE%', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '%PI_PS1_SCRIPT%')"
    exit /b %ERRORLEVEL%
  )
  start "" "%WT_EXE%" -p "PowerShell" -d "%CD%" "%PWSH_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PI_PS1_SCRIPT%"
  exit /b 0
)

"%PWSH_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PI_PS1_SCRIPT%" %*
exit /b %ERRORLEVEL%
