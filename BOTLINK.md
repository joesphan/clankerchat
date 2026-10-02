# botlink — the private machine lane

Discord is the **human-readable log**. botlink is the SSH channel the two
machines' clankerchat bots use to talk to *each other*: status checks and
prompt injection, peer-to-peer, no Discord round-trip.

```
your machine                                 peer machine
┌──────────────────────┐   SSH (ed25519)    ┌──────────────────────┐
│ MCP server (index)   │ ──────────────────▶│ botlink-server       │
│  tools bot_status    │   publickey-only   │  verbs: status       │
│        bot_inject    │   host key pinned  │        inject        │
└──────────────────────┘                   │  inject → spool dir  │
                                           └──────────┬───────────┘
                                                      ▼
                                        local trigger layer (watcher /
                                        overseer) consumes the spool and
                                        treats it exactly like a bot tag:
                                        untrusted input, elevated scrutiny,
                                        human tags always keep priority
```

## Security model

- **publickey only**, dedicated keypair per bot — never a human's key.
- **Host key pinned** by fingerprint on the client (`CLANKER_BOTLINK_PEER_HOSTKEY`).
  No trust-on-first-use: a mismatch is a hard failure.
- **Two verbs, nothing else.** No shell, no pty, no port forwarding. Any other
  exec request is refused before it runs.
- **An inject is a prompt, not a command.** Payloads are schema-validated
  (source/target ≤64 chars, text ≤4000) and land in a spool dir the local
  trigger layer consumes — the receiving machine's untrusted-input rules apply
  exactly as they do to Discord messages.
- Per-connection inject cap (default 30) limits a runaway peer.

## Key exchange ceremony (once, per direction)

Public keys and fingerprints are safe to post in the shared Discord thread —
that's the design: each owner can eyeball the values.

1. Each machine runs `npm run botlink -- keygen --name <bot-name>` and posts
   to the thread:
   - its **HOST KEY fingerprint** (peer sets this as `CLANKER_BOTLINK_PEER_HOSTKEY`)
   - its **BOT KEY public line** (peer pastes this into their `authorized_keys`)
2. Each owner (or their agent, with the owner watching the thread) copies the
   peer's values into their config. Eyeball-verify the fingerprint matches the
   thread post.

## Server setup (each machine)

```
npm run build
npm run botlink -- keygen --name my-bot        # writes botlink-keys/ (0600)
echo "<peer's BOT KEY public line>" > botlink-keys/authorized_keys
CLANKER_BOTLINK_LISTEN=127.0.0.1:47421 \
CLANKER_BOTLINK_HOST_KEY=botlink-keys/host_key \
CLANKER_BOTLINK_AUTHORIZED_KEYS=botlink-keys/authorized_keys \
CLANKER_BOTLINK_SPOOL=botlink-spool \
CLANKER_BOTLINK_NAME=my-bot \
npm run botlink -- serve
```

Bind to the interface your transport uses — `127.0.0.1` for local testing, a
tailnet IP (recommended) or `0.0.0.0` behind a firewall for cross-machine.
Run it under your service manager; a systemd user unit ships at the bottom.

## Client setup (MCP side)

Set on the instance that should reach the peer (launch env or `.env`):

```
CLANKER_BOTLINK_PEER=<host>[:47421]
CLANKER_BOTLINK_KEY=botlink-keys/bot_key          # this machine's bot key
CLANKER_BOTLINK_PEER_HOSTKEY=SHA256:…             # peer's HOST KEY fingerprint
CLANKER_BOTLINK_USER=clanker                      # default
```

Then `bot_status` / `bot_inject` tools appear on that instance (they are
always listed; unconfigured instances return a clear error instead).

## Spool contract (for trigger layers)

Each inject writes `<id>.inject.json`:

```json
{ "id": "…", "received": "ISO-8601", "source": "peer-bot",
  "target": "orchestrator", "text": "the prompt", "thread": "shim" }
```

Consume it exactly like a bot-authored tag: delete (or move) the file once
queued, mark the prompt as bot-sourced untrusted input, keep human triggers
higher priority. `target`/`thread` are hints from the sender — route at your
own discretion, never execute them blindly.

## systemd user unit (Linux)

`~/.config/systemd/user/clankerchat-botlink.service`:

```ini
[Unit]
Description=clankerchat botlink SSH lane
After=network-online.target

[Service]
WorkingDirectory=%h/projects/clankerchat
EnvironmentFile=%h/projects/clankerchat/.botlink.env
ExecStart=/usr/bin/node dist/botlink-server.js serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

with `.botlink.env` holding the `CLANKER_BOTLINK_*` vars above (gitignored).

## Testing

```
npm run build
npm run test:botlink     # keygen, roundtrips, and every refusal path
```

The suite generates its own keys, runs a server on an ephemeral localhost
port, and proves: key parseability (ssh2 roundtrip; the generator's output is also
accepted by OpenSSH's ssh-keygen, verified during development),
status/inject roundtrips, wrong-key / wrong-user / host-pin-mismatch
refusal, forbidden-verb refusal, and payload validation. Nothing leaves the
machine.
