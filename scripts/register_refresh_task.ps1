# Registers the Windows task "QuantPlatform refresh": every 3 hours (01:00, 04:00, ... 22:00 local time) it runs
#   .venv\Scripts\pythonw.exe -m quant.scheduler --refresh
# which updates headlines and the deep tier's prices (with fallback sources) and republishes the site.
# The nightly "QuantPlatform daily cycle" task stays as it is; a lock file keeps the two from overlapping.
# Optional: .github/workflows/refresh.yml already refreshes headlines and prices every 3 hours on GitHub's
# servers. This local task adds the 15-minute bars and the chart's price reactions, which need the local database.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File scripts\register_refresh_task.ps1
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project ".venv\Scripts\pythonw.exe"
$action = New-ScheduledTaskAction -Execute $python -Argument "-m quant.scheduler --refresh" -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -Daily -At "01:00"
$repeat = New-ScheduledTaskTrigger -Once -At "01:00" -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Hours 23)
$trigger.Repetition = $repeat.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "QuantPlatform refresh" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Free Quant Platform: refresh headlines and deep-tier prices every 3 hours (fallback sources when one fails) and republish the website. Logs: data\logs\scheduler.log" `
  -Force | Out-Null
Get-ScheduledTask -TaskName "QuantPlatform refresh" | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime
