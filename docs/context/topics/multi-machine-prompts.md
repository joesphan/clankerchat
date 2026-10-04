---
title: Multi-machine prompt routing (design draft)
tags: [prompts, phone, botlink, cross-machine, design]
updated: 2026-10-04
owner: tjbtiller
---

Cross-referencing and ROUTING phone prompts across the two machines (owner
green-lit 2026-10-04, design-first per TODO). This is a DRAFT for bilateral
review — joesp-desktop's input wanted before any code: both sides must ship
halves for any phase past 0.

## Problem

Prompts/asks are per-machine today: the phone is enrolled to ONE machine
(tyler-cachy), its prompts land in that machine's registry, and the SENT list
never learns what happened anywhere else. Two distinct gaps:

1. VISIBILITY — the phone can't see the peer machine's health/activity blend
   (it gets lane facts for US, not their run outcomes).
2. ROUTING — a pocket prompt cannot ASK the other machine at all.

## Phase 0 (trivial, zero protocol): peer line on the MACHINE card

`/machine` already receives the peer's status payload via the lane heartbeat
(their `bot`, `spool_pending`, `injects_total`, `load.last_run_at` all ride
`laneFacts` today). Render one line: `peer: joesp-desktop · pool 1/4 · last
run 12m ago`. App-side display change only; no registry shape, no new verbs.
SHIP INDEPENDENTLY of the rest.

## Phase 1 (the registry shape): optional route hint + outcome echo

PromptRecord gains an optional field:

    route?: "peer"   // absent/own = this machine runs it (default, back-compat)

- The companion route accepts `route` in POST /prompt (signed body — no
  signing-surface change; it rides the JSON body like `text`).
- THIS machine's watcher claims the record as today, but instead of
  enqueuing a local run, sends a botlink inject with the phone provenance
  block and `task_kind: "question"`, `task_correlation: promptId`. The
  record stays `enqueued` HERE — this machine owes the phone an outcome.
- The PEER's run finishes and posts in ITS Discord venue (their record).
- Outcome echo: the peer calls a NEW lane verb `prompt-outcome`
  (daemon-side, not Discord) carrying `{ promptId, exit, posted, excerpt }`.
  Our daemon verifies size/shape, then OUR watcher's stamp path applies it
  via finishPrompt — the phone resolves answered/failed as if local.

Trust: the echo arrives over the mutual-key SSH lane from the pinned peer —
same channel as injects today. The excerpt is DISPLAY DATA on the phone
exactly like local excerpts (never instructions), leak-shape-checked at
finishPrompt's boundary as usual. promptIds are caller-chosen; the echo only
ever touches a record WE created (registry miss = drop + journal).

## Phase 2 (maybe): cross-reference without routing

A shared "what happened on the other machine" view needs either a shared
store (rejected — registries are deliberately local files) or a lane-served
peer index (`GET`-class verb returning their newest N prompt outcomes).
Defer until routing (phase 1) shows real use.

## Open questions for joesp-desktop

1. `prompt-outcome` verb: agree the daemon accepts it (their side must add
   the send), and WHERE it lands in their flow (daemon → their watcher's
   stamp? or direct into our spool as a consumed-style file?).
2. Should the peer's answer ALSO post into OUR channel root (visible ping
   for the owner) or only their venue + phone excerpt? Venue law says
   Discord posts are human-eyes; a cross-post doubles the audience —
   owner call, leaning excerpt-only.
3. Expiry semantics when routed: the 15-min pending TTL assumes a local
  watcher claim; a lane round-trip needs a wider window (30m?).

## Non-goals

- No shared database, no registry sync (both are deliberate non-features).
- No push to the phone (notifications stay local — separate 2026-10-04 ship).
