@echo off
rem inject consumer launcher — started by Task Scheduler (clankerchat-consumer).
set /a tries=0
:loop
"C:\Program Files\nodejs\node.exe" "C:\Users\joesp\Documents\GitHub\clankerchat\tools\inject-consumer.mjs"
set /a tries+=1
if %tries% geq 12 exit /b 1
timeout /t 10 /nobreak >nul
goto loop
