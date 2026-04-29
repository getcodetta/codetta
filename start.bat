@echo off
cd /d "%~dp0"

echo Refreshing PATH from registry (so cargo/link.exe are visible without restarting the shell)...
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%i"

if not exist node_modules (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 goto err
)
echo.
echo Launching Lite Coder Pro (dev mode with hot reload)...
echo.
call npm run tauri dev
goto end

:err
echo.
echo Setup failed. See errors above.
pause

:end
