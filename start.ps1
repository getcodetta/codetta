# Dev launcher for Lite Coder Pro.
# Refreshes PATH from the registry so cargo / link.exe are visible
# even if you installed Rust / MSVC after VSCode started.

Set-Location -Path $PSScriptRoot

Write-Host "Refreshing PATH from registry..." -ForegroundColor Cyan
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Test-Path -Path 'node_modules')) {
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Launching Lite Coder Pro (dev mode with hot reload)..." -ForegroundColor Cyan
npm run tauri dev
