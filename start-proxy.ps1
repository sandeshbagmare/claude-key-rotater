# Claude CLI API Key Rotation Proxy v2.0 - PowerShell Launcher
# Run this script to start the proxy

$proxyDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxyScript = Join-Path $proxyDir "proxy.js"

# Check if Node.js is available
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check if proxy is already running
$existingProcess = Get-NetTCPConnection -LocalPort 4891 -ErrorAction SilentlyContinue
if ($existingProcess) {
    Write-Host "Proxy is already running on port 4891!" -ForegroundColor Yellow
    Write-Host "Dashboard: http://127.0.0.1:4891/dashboard" -ForegroundColor Cyan
    Write-Host "To restart, first kill the existing process." -ForegroundColor Yellow
    exit 0
}

Write-Host "" -ForegroundColor Cyan
Write-Host "  Starting Claude Key Rotation Proxy v2.0..." -ForegroundColor Cyan
Write-Host "  Dashboard will be available at: http://127.0.0.1:4891/dashboard" -ForegroundColor Green
Write-Host ""

# Run the proxy
node $proxyScript
