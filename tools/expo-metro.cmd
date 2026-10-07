@echo off
rem Expo metro bundler for the companion app — CI=1 keeps it non-interactive
rem Port 8082 = the instance the phone demonstrably renders (8081 killed 2026-10-04)
cd /d "%~dp0..\companion-app"
set CI=1
npx expo start --go --port 8082
