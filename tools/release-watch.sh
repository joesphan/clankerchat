#!/usr/bin/env bash
# release-watch.sh — non-AI self-updater for the clankerchat overseer.
# Runs every 5 min via Task Scheduler (clankerchat-release-watch). Checks the
# GitHub repo for a new release; if found: pull, build, restart the daemon,
# announce in-thread. State: .release-state (last deployed tag). Log: release-watch.log.
set -u
ROOT="/c/Users/joesp/Documents/GitHub/clankerchat"
STATE="$ROOT/.release-state"
LOG="$ROOT/release-watch.log"
API="https://api.github.com/repos/joesphan/clankerchat/releases/latest"
say() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

cd "$ROOT" || exit 1

latest=$(curl -sf --max-time 20 "$API" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')
if [ -z "$latest" ]; then exit 0; fi   # no releases yet / API hiccup — silent

last=$(cat "$STATE" 2>/dev/null || echo "")
if [ "$latest" = "$last" ]; then exit 0

say "new release: $latest (had: ${last:-none})"
if ! git fetch origin --tags >>"$LOG" 2>&1; then say "git fetch FAILED"; exit 1; fi
if ! git checkout -q main >>"$LOG" 2>&1 || ! git pull -q origin main >>"$LOG" 2>&1; then say "git pull FAILED"; exit 1; fi
if ! git checkout -q "$latest" >>"$LOG" 2>&1; then say "tag checkout FAILED ($latest)"; exit 1; fi
npm install --silent >>"$LOG" 2>&1 || { say "npm install FAILED"; exit 1; }
npm run build >>"$LOG" 2>&1 || { say "build FAILED"; exit 1; }

# restart the daemon (same user; minimized)
taskkill //F //IM node.exe //FI "WINDOWTITLE eq clankerchat*" >>"$LOG" 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -match '^node' -and \$_.CommandLine -match 'daemon\.js' } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F }" >>"$LOG" 2>&1
sleep 2
powershell -NoProfile -Command "Start-Process powershell -WorkingDirectory 'C:\Users\joesp\Documents\GitHub\clankerchat' -ArgumentList '-NoExit','-Command','npm run daemon' -WindowStyle Minimized"
sleep 12

echo "$latest" > "$STATE"
say "deployed $latest: daemon restarted"

# announce in-thread (raw REST; no AI involved)
TOK=$(grep '^DISCORD_TOKEN=' .env | cut -d= -f2)
curl -sf -X POST -H "Authorization: Bot $TOK" -H "Content-Type: application/json" \
  -d "{\"content\":\"**joesp-desktop**: release \\`$latest\\` deployed — pulled, built, daemon restarted (auto-updater).\"}" \
  "https://discord.com/api/v10/channels/1555113237115314236/messages" >>"$LOG" 2>&1 \
  && say "announced" || say "announce failed (deploy still OK)"
