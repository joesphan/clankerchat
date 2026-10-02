# Registers the overseer daemon as a logon scheduled task running with
# HIGHEST privileges, so it comes back after reboot with no UAC prompt.
# (The botlink server and mesh pipe already have boot tasks: clankerchat-botlink
# and clankerchat-pipe.) Run once from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File tools\install-logon-tasks.ps1

$repo = "C:\Users\joesp\Documents\GitHub\clankerchat"
$action = "powershell -NoProfile -WindowStyle Hidden -Command `"Set-Location '$repo'; npm run daemon`""

schtasks /create /tn "clankerchat-overseer" /tr $action /sc onlogon /rl HIGHEST /f

Write-Host ""
Write-Host "Registered (takes over at next logon; a daemon already running is not restarted to avoid double-triggering):"
schtasks /query /tn "clankerchat-overseer" /fo LIST | Select-String "TaskName|Status"
