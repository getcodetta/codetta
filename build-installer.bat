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
echo Building Lite Coder Pro release installer (first build takes 5-15 minutes)...
echo.
call npm run tauri build
if errorlevel 1 goto err

echo.
echo === Build complete ===
echo Outputs:
echo   Portable EXE:  src-tauri\target\release\lite-coder-pro.exe
echo   NSIS setup:    src-tauri\target\release\bundle\nsis\
echo   MSI setup:     src-tauri\target\release\bundle\msi\
echo.
explorer "src-tauri\target\release\bundle"
goto end

:err
echo.
echo Build failed. See errors above.
pause

:end
