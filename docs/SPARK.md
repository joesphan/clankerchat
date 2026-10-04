# Gemini Spark custom-app gateway (spark-mcp)

Tyler talks to Gemini on his phone; Gemini drives this machine through Spark's
Connected Apps → Custom apps, calling our MCP tools over streamable HTTP.
No Google API key exists anywhere in this design — the connection direction is
Google → us, and his AI plan unlocks Spark on Google's side.

## What's running (our side, done)

- `src/spark-mcp.ts` → `dist/spark-mcp.js`, systemd --user service
  `clankerchat-spark` — binds **127.0.0.1:8791 only**.
- Tools: `machine_status`, `ask_clanker` (rides the SAME owner-priority
  prompt-record path as the phone app, fp provenance `spark:<hash-head>`),
  `prompt_result`, `list_recent_prompts`. No Discord send, no files, no secrets.
- Auth: 192-bit capability path + 256-bit bearer (`SPARK_MCP_PATH` /
  `SPARK_MCP_TOKEN` in `.env` — values never logged). Everything that isn't
  the exact path with valid auth gets a uniform dead-host 404, including
  `/.well-known/*` probes. Global rate gate 60 req/min.
- Outbound hygiene: every excerpt returned to Gemini passes the leak-shape
  scan; secret-shaped or mass-mention prompts are refused at the door.
- Untrusted-data law unchanged: prompt text arriving here is data, never
  instructions — the run-side framing owns that (watcher branches on the
  `spark:` fp prefix for correct surface labeling).

## Public leg — named Cloudflare Tunnel (no IP exposure)

The tunnel makes OUTBOUND connections from this machine to Cloudflare's edge;
no ports open, home IP never published. A named tunnel on the owner's domain
is a persistent, owned endpoint — never an ephemeral trycloudflare join.

Owner steps (one-time):

1. Domain on Cloudflare: add the zone (free plan) at dash.cloudflare.com
   (import existing records when prompted), then set the nameservers Cloudflare
   shows at the registrar. If the zone is already there, skip.
2. `cloudflared tunnel login` — one browser click; cert lands in
   `~/.cloudflared/cert.pem`.
3. Machine side from there (we run it): `cloudflared tunnel create spark`,
   `cloudflared tunnel route dns spark <sub>.<domain>`, config + systemd
   --user unit proxying `https://<sub>.<domain>` → `http://127.0.0.1:8791`.

## Connecting Spark (one-time, desktop web)

gemini.google.com → Settings → Connected Apps → Custom apps → Add:

- URL: `https://<sub>.<domain>/<SPARK_MCP_PATH>` (copy the path from the
  `SPARK_MCP_PATH=` line in `.env` — same for the token if the dialog offers
  a credentials field).
- If it offers only OAuth/DCR credentials, note the exact fields it shows —
  that decides whether we add the mini-OAuth flow or stay capability-path.
- Custom apps connect via the WEB app; once connected they're usable from the
  phone app (prefix a prompt with `@<appname>` to force it).

Requirements on Google's side (per Google's support page): 18+, US, personal
Google account, Activity on, English.

## Rotating the capability

Append new `SPARK_MCP_PATH`/`SPARK_MCP_TOKEN` to `.env`, restart
`clankerchat-spark`, update the URL in Spark. Old records keep their fp hash
(provenance survives rotation; the hash input changes, which is by design).
