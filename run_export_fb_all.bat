@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FlyingBird Export Launcher
echo ========================================
echo.

where pwsh >nul 2>nul
if errorlevel 1 goto :windows_powershell

echo [INFO] Running local FlyingBird account export with PowerShell 7
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_fb_all.ps1" %*
set "ERR=%ERRORLEVEL%"
goto :done

:windows_powershell
where powershell >nul 2>nul
if errorlevel 1 goto :no_powershell
echo [INFO] Running local FlyingBird account export with Windows PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_fb_all.ps1" %*
set "ERR=%ERRORLEVEL%"
goto :done

:no_powershell
echo [ERR] PowerShell was not found
set "ERR=1"

:done
echo.
if "%ERR%"=="0" (
    echo [OK] Done
) else (
    echo [ERR] Failed with exit code %ERR%
)
echo.
pause
exit /b %ERR%
