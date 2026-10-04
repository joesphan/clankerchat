---
title: daemon.json semantics (overseer config)
tags: [daemon, overseer, config, routing, workers]
updated: 2026-10-04
owner: joesp-desktop
---

The overseer daemon's config: per-machine, gitignored, templated by
daemon.example.json (setup walk = SETUP.md Step 11). Read once at
start; `!ov reload` re-reads it without a restart; routing inferences
the router marks high-confidence are written BACK into the file
(learned) — expect it to change under you between edits.

## Keys (defaults from src/daemon.ts loadConfig)

- `allow` — digit-string Discord user IDs; THE human security
  boundary: anyone listed can drive sessions on this machine.
  Required unless `allowAllHumans: true` (then the private channel is
  the perimeter; bots stay gated by `botAllow` either way).
- `allowBots` + `botAllow` — peer-bot triggers (agent-to-agent).
  Empty `botAllow` = every bot in-channel can trigger; only safe when
  every bot is trusted. The own bot never triggers itself, and
  bot-triggered workers reply as new messages (not Discord replies) so
  peer daemons aren't auto-mentioned into loops.
- `triggerRoles` — role IDs that trigger like a bot mention; a role
  NAMED "clanker" always triggers regardless of the list.
- `threads` — thread name → repo path HINT map. Unmapped threads
  route by inference against `reposRoot`; learned entries land here.
  Every thread is watched either way.
- `reposRoot` — folder holding this machine's repos; the inference
  search space. Default: the repo's parent.
- `sandbox` — neutral cwd for tasks routing can't place. Must exist
  on disk; unset → unplaceable tasks are refused.
- `wake` (default true) + `wakeGraceMs` (default 4 min, floor 1) —
  try waking a matching idle live session first; spawn a worker
  fallback after the grace expires.
- `fullAuto` (default false) — workers get chat + repo read ONLY
  (the five clankerchat tools). True adds
  --dangerously-skip-permissions.
- `pollMs` (default 5000, floor 1000) · `timeoutMs` (default 15 min,
  the worker kill) · `maxConcurrent` (default 3, clamp 1–8; never two
  workers on one thread) · `ack` (default true — short dispatch note
  in-thread).
- `pausedThreads` — refuse that thread's triggers outright; circuit
  breaker for work that crashes the machine.

## Companions

- `daemon.state.json` — cursors (thread → last processed message id)
  plus per-thread claude session ids for --resume continuity.
  Gitignored like the config.
- `daemon.log` — one line per event; the `router:` line explains
  every routing decision — read it before blaming inference.

## Boot failures (fatal, exact message)

Missing file, invalid JSON, `allow` empty or non-digit, `threads` not
a name→path map — each dies at start with a message naming the key;
nothing half-boots.
