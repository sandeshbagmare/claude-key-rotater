# Auto-start Claude Key Rotation Proxy via Windows Task Scheduler
# Run this script ONCE to register the proxy as a startup task

$taskName = "ClaudeKeyRotationProxy"
$proxyScript = Join-Path $PSScriptRoot "proxy.js"
$nodePath = (Get-Command node).Source

# Remove existing task if it exists
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing scheduled task." -ForegroundColor Yellow
}

# Create a new scheduled task that runs at logon
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$proxyScript`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Claude CLI API Key Rotation Proxy - Runs on startup" | Out-Null

Write-Host ""
Write-Host "SUCCESS: Scheduled task '$taskName' registered!" -ForegroundColor Green
Write-Host "The proxy will auto-start every time you log in." -ForegroundColor Cyan
Write-Host ""
Write-Host "To manage:" -ForegroundColor White
Write-Host "  Start now:   Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host "  Stop:        Stop-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
Write-Host "  Remove:      Unregister-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
