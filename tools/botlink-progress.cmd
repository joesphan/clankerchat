@echo off
rem progress page launcher — started by Task Scheduler (clankerchat-progress).
rem Retries the bind: at boot the Tailscale interface may not be up yet.
set /a tries=0
:loop
"C:\Program Files\nodejs\node.exe" "C:\Users\joesp\Documents\GitHub\clankerchat\tools\progress-server.mjs"
set /a tries+=1
if %tries% geq 12 exit /b 1
timeout /t 10 /nobreak >nul
goto loop
