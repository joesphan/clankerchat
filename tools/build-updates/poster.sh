#!/usr/bin/env bash
# build-updates poster — owner phone directives (companion lane, fp
# SHA256:4ceaYGuE…): "build updates every 5 minutes" (2026-10-04) amended
# "I want heartbeat on ALL builds" (2026-10-04, pmtoorlyuuy).
#
# HEARTBEAT semantics: every tick, EVERY registered build posts one update —
# alive or quiet, changed or not. Each heartbeat carries fresh numbers
# (byte growth since last tick, log quiet-age, elapsed since first seen) so
# the owner can tell "building", "stalled", and "log missing" apart.
#
# STATUS LINES ONLY (owner law 2026-10-02 threads-are-human-eyes; bilateral
# build-output detachment law 2026-10-05): never post raw log tails — raw
# logs stay in their file where they can be tailed on demand.
#
# Daemon-side by design (prompt-plan: shell is free, sessions poll nothing):
# WSL systemd build-updates.timer fires this every 300 s.
#
# Registry: /root/build-updates/active   rows: <thread_id>|<log_path>|<label>
# Build sessions append a row when they start a detached build, remove it
# when done. Per-row state lives in /root/build-updates/state/.
set -u
ENV_FILE="/mnt/c/Users/joesp/Documents/GitHub/clankerchat/.env"
REG="/root/build-updates/active"
STATE_DIR="/root/build-updates/state"
mkdir -p "$STATE_DIR"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
[ -n "${DISCORD_TOKEN:-}" ] || exit 0

now="$(date +%s)"
post() { # $1=thread $2=msg
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bot $DISCORD_TOKEN" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:1900]}))' "$2")" \
    "https://discord.com/api/v10/channels/$1/messages"
}

while IFS='|' read -r thread log label; do
  case "$thread" in ''|'#'*) continue ;; esac
  key="$(printf %s "$log" | md5sum | cut -c1-12)"
  st_b="$STATE_DIR/$key.bytes"; st_t="$STATE_DIR/$key.since"
  [ -f "$st_t" ] || printf %s "$now" > "$st_t"
  elapsed=$(( (now - "$(cat "$st_t")") / 60 ))

  if [ ! -f "$log" ]; then
    post "$thread" "heartbeat \`${label}\`: LOG MISSING — \`${log}\` (registered $((elapsed))m ago)"
    continue
  fi
  bytes="$(stat -c %s "$log")"
  prev="$(cat "$st_b" 2>/dev/null || echo "$bytes")"
  printf %s "$bytes" > "$st_b"
  grown=$(( bytes - prev ))
  quiet=$(( (now - "$(stat -c %Y "$log")") / 60 ))
  post "$thread" "heartbeat \`${label}\`: alive ${elapsed}m, +${grown} B since last beat, log quiet ${quiet}m"
done < "$REG"
