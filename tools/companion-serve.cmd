@echo off
rem companion serve — phone allow/deny surface (docs/companion-app.md)
rem bind is the Ethernet LAN IPv4 (192.168.0.12, 2026-10-03) — update if DHCP changes it
cd /d "%~dp0.."
rem Routed prompts (phase 1): canRouteToPeer resolves the lane live per request
rem via resolveBotlinkPeerFromEnv — hand it the same facts tools/lane-send.mjs
rem uses (peer endpoint, bot_key, pin from .env so a rotation needs no edit here).
set "CLANKER_BOTLINK_PEER=100.64.0.1:47421"
set "CLANKER_BOTLINK_KEY=botlink-keys\bot_key"
rem Drift guard OFF (round-15 law) — hand-launched with no restart-on-any-exit
rem wrapper; an armed guard exit would take the phone surface down silently.
set "CLANKER_BOTLINK_DRIFT_GUARD=0"
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "CLANKER_BOTLINK_PEER_HOSTKEY=" .env`) do set "%%A=%%B"
node dist\botlink-server.js companion --serve --bind 192.168.0.12 --port 47423
