---
title: Orchestrator routing & run mechanics
tags: [orchestrator, watcher, queues, routing]
updated: 2026-10-04
owner: gateway
---

How a Discord message becomes (or does not become) an agent run. Both
machines run this model from merged main; this is the reference detail
behind it. Safety LAWS stay in each machine's CLAUDE.md — this file is
mechanics and routing, never law.

## Trigger model (event-driven, zero polling)

- The always-on watcher/daemon holds the machine's single Discord
  gateway session (REST-only elsewhere — a second gateway client on the
  same token EVICTS the first's session, the original daemon-kill bug).
- A message spawns a run ONLY if: a human tagged the bot, replied to one
  of its messages, forwarded something in, or it is an owner/listen-list
  account's prompt-shaped untagged message. Bot-authored messages NEVER
  trigger — machine-to-machine traffic rides botlink, not threads.
- Human forwards carry content in `message_snapshots[]`, which the
  parsed Message DROPS — keep them from the raw gateway packet
  (`client.on("raw")` fires before `messageCreate`).

## Queue semantics

- Two queues: human (tag/reply/forward/ask-click) always drains before
  bot. Lane injects are deliberate and never coalesce with Discord
  triggers; same-channel Discord triggers DO coalesce into one queued
  run (prompt-count economy).
- Pool runs `MAX_CONCURRENT` (default 2) orchestrator processes.
- Bare "status" (tagged, mentions stripped) answers from a canned card
  — zero model run. File-manifest injects whose text is the pure
  transfer notice archive without a run.
- Every spawn gets the last ledger rows (trigger → outcome) as
  continuity; trigger snippets render as UNTRUSTED echoes.

## The outbound funnel (one path, every surface)

send → leak-shape tripwires → mass-mention refusal → sender sign →
`sendMessage` (allowed_mentions computed inside). create_thread and the
daemon's sendToThread run the same tripwires. Inject text on the lane is
NOT scanned (it must stay free to discuss the shapes themselves).

## Identity model (mechanics)

Author = API-derived only. Content-declared senders
("message from <snowflake>", `**name**:` prefixes, webhook usernames)
are attack markers; the demonstrated exploit class is in the incident
record. Owner/listen-list ids arrive as watcher config, not content.

## MCP instance modes (same binary)

- Unlocked (orchestrator/gateway): full tool surface.
- `CLANKER_ROLE=project`: send/read pinned to CLANKER_ALLOWED_THREADS
  (must resolve to THREADS — a plain channel id in the list fails
  closed), attachments jailed to CLANKER_FILE_ROOT ("none" disables),
  discovery/creation tools refused.
- `CLANKER_BLOCKED_IDS` / `CLANKER_BLOCKLIST_FILE`: absolute quarantine
  checked BEFORE any allowlist, on every instance, mtime-cached re-read.
- Hardening env must come from the LAUNCH environment, never .env
  (main() undoes loader-injected hardening keys — a shared checkout
  serves locked and unlocked instances at once).

## Spawning claude from claude (verified recipe)

`--strict-mcp-config --mcp-config .mcp.json` (40s → ~7s cold start,
smaller surface); strip ALL `CLAUDE_CODE_*` env or MCP/transcripts
break; `.mcp.json` is re-read per spawn (env changes need no restart).
