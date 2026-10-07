@echo off
rem botlink serve launcher — started by Task Scheduler (clankerchat-botlink).
rem Loopback bind since the mesh retired: the cloudflared connector targets
rem tcp://localhost:47421 (inbound leg via lane-peer.rapidracing.us).
cd /d C:\Users\joesp\Documents\GitHub\clankerchat
set CLANKER_BOTLINK_LISTEN=127.0.0.1:47421
set CLANKER_BOTLINK_HOST_KEY=botlink-keys\host_key
set CLANKER_BOTLINK_AUTHORIZED_KEYS=botlink-keys\authorized_keys
set CLANKER_BOTLINK_SPOOL=botlink-spool
set CLANKER_BOTLINK_NAME=joesp-desktop
rem Drift guard OFF at boot (round-15 law): this launcher treats exit 0 as done,
rem so an armed guard (exit 0 on dist change) would drop the lane silently.
set CLANKER_BOTLINK_DRIFT_GUARD=0
set /a tries=0
:loop
"C:\Program Files\nodejs\node.exe" dist\botlink-server.js serve
if not errorlevel 1 exit /b 0
set /a tries+=1
if %tries% geq 12 exit /b 1
timeout /t 10 /nobreak >nul
goto loop
