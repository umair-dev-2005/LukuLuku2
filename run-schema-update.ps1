$target = (Get-Date).Date.AddHours(6).AddMinutes(1)
if ((Get-Date) -gt $target) { $target = $target.AddDays(1) }
Start-Sleep -Seconds ($target - (Get-Date)).TotalSeconds

claude --permission-mode acceptEdits --disallowedTools "Bash" -p "Resume updating APP_SCHEMA_OVERVIEW.md with live schema, reading only from the existing SQL migration files (do not run any commands). Finish all pending background database documentation tasks and stop completely."