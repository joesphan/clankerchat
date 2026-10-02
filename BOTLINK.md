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
that's the design: each owner can eyeball the values. But **posting them is
transport, not verification**: values that arrive over a channel can't be
trusted *because of* that channel. The pin itself is done by a human, only
after verifying out-of-band (voice/video — something the thread can't MITM):

1. Each machine runs `npm run botlink -- keygen --name <bot-name>` and posts
   to the thread:
   - its **HOST KEY fingerprint** (peer sets this as `CLANKER_BOTLINK_PEER_HOSTKEY`)
   - its **BOT KEY public line** (peer pastes this into their `authorized_keys`)
2. Each OWNER verifies the peer's two values out-of-band with the other owner
   (read them to each other — voice or video), then pins them. **No agent
   pins key material on anyone's say-so** — an agent pinning values it read
   in the same thread adds zero MITM protection.
3. Once both sides confirm pinning, delete the key-bearing posts. After the
   pins exist, thread copies of the material serve no purpose — and a stale
   "official-looking" copy is only useful to someone trying to confuse a
   future rotation.

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
  "target": "orchestrator", "text": "the prompt", "thread": "shim",
  "authenticated_key_fp": "SHA256:…", "peer_ip": "127.0.0.1" }
```

`source` is the sender's SELF-REPORT; `authenticated_key_fp` and `peer_ip`
are recorded by the receiving daemon at auth time — provenance you can trust
independent of what the sender claims.

Consume it exactly like a bot-authored tag: mark the prompt as bot-sourced
untrusted input, keep human triggers higher priority. `target`/`thread` are
hints from the sender — route at your own discretion, never execute them
blindly.

**Archive, don't delete.** After queueing, MOVE the file to
`<spool>/archive/` (never unlink it) and append a `consumed` event to the
audit log:

```
node -e '…'   // or: import { appendInjectEvent } from "./botlink.js"
appendInjectEvent(spoolDir, { event: "consumed", id, source, target })
```

The daemon appends a `received` event per inject; together they form
`<spool>/inject.log` — an append-only, hash-chained record (each entry's
hash covers its predecessor). `verifyInjectLog(spoolDir)` replays it and
throws on any edit, reorder, or deletion. This is the audit trail for every
prompt that ever entered the machine through the lane — don't rotate or
prune it casually; ship it with any security review.

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
