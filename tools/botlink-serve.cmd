@echo off
rem botlink serve launcher — started by Task Scheduler (clankerchat-botlink).
rem Retries the bind: at boot the Tailscale interface may not be up yet.
cd /d C:\Users\joesp\Documents\GitHub\clankerchat
set CLANKER_BOTLINK_LISTEN=100.64.0.4:47421
set CLANKER_BOTLINK_HOST_KEY=botlink-keys\host_key
set CLANKER_BOTLINK_AUTHORIZED_KEYS=botlink-keys\authorized_keys
set CLANKER_BOTLINK_SPOOL=botlink-spool
set CLANKER_BOTLINK_NAME=joesp-desktop
set /a tries=0
:loop
"C:\Program Files\nodejs\node.exe" dist\botlink-server.js serve
if not errorlevel 1 exit /b 0
set /a tries+=1
if %tries% geq 12 exit /b 1
timeout /t 10 /nobreak >nul
goto loop
