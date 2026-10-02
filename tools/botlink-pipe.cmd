@echo off
rem cloudflared access pipe to the headscale — started by Task Scheduler
rem (clankerchat-pipe). Retries: at boot the tunnel/DNS may lag. A second
rem instance while one already holds 18080 exits harmlessly.
set /a tries=0
:loop
"C:\Users\joesp\Documents\GitHub\clankerchat\tools\bin\cloudflared.exe" access tcp --hostname https://ts.epicefi.com --url 127.0.0.1:18080
set /a tries+=1
if %tries% geq 12 exit /b 1
timeout /t 10 /nobreak >nul
goto loop
