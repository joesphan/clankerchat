---
title: Multi-machine prompt routing (design + phase 1 shipped our side)
tags: [prompts, phone, botlink, cross-machine, design]
updated: 2026-10-04
owner: tjbtiller
---

Cross-referencing and ROUTING phone prompts across the two machines (owner
green-lit 2026-10-04, design-first per TODO). Phase 1 is DECIDED (owner
delegated the three picks, 2026-10-04 — channel post 1556355104607707247)
and shipped our half (0e5c4ea); the peer ports their half per the fork law.

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

## Phase 1 (the registry shape): optional route hint + outcome echo — DECIDED + SHIPPED OUR SIDE (0e5c4ea)

Decisions (owner-delegated 2026-10-04, channel post 1556355104607707247):
(a) `prompt-outcome` verb ACCEPTED, applied by the existing 15s delivery
sweep — no new loop, no new listener; (b) routed answers EXCERPT-ONLY: the
answer posts in the ANSWERING machine's venue, the asking phone previews
it, no cross-post; (c) routed-expiry 30 MINUTES — one whole-lifecycle
budget (pending expiry AND stuck-enqueued rot both key off it, so a
slow-but-healthy peer survives while a dead one fails honestly).

As shipped (0e5c4ea + machine-local watcher wiring):

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
THREE boundaries (the sending run's exit hook, the lane door, apply).
promptIds are caller-chosen; the echo only ever touches a record WE created
AS ROUTED — `applyPeerPromptOutcome` refuses local records outright (class
separation: a local prompt's outcome is unreachable from the lane, a
stronger property than peer authentication alone). Registry miss or wrong
class = drop + journal; the landed outcome file is archived, never unlinked.

Peer's port (rides the merge as always): their watcher's inject consumer
treats `task.kind === "question" && task.correlation` as a routed run and
sends `prompt-outcome` on exit; their delivery sweep grows the same route
branch + outcome intake; their companion surface passes `canRouteToPeer`.
The verb handler itself is shared code — their daemon speaks it the moment
they merge.

## Phase 2 (maybe): cross-reference without routing

A shared "what happened on the other machine" view needs either a shared
store (rejected — registries are deliberately local files) or a lane-served
peer index (`GET`-class verb returning their newest N prompt outcomes).
Defer until routing (phase 1) shows real use.

## Open questions for joesp-desktop — ANSWERED 2026-10-04 (owner delegated the picks)

1. `prompt-outcome` verb: ACCEPTED. Lands as a daemon-validated file under
   prompt-outcomes/; the watcher's existing 15s sweep applies it (the
   decision: same exactly-once claim class as delivery — no new loop).
2. Peer's answer venue: EXCERPT-ONLY (the leaning won). Their venue keeps
   the post; our phone previews the excerpt; no cross-post to our root.
3. Routed expiry: 30 MINUTES — one whole-lifecycle budget, decided above.

## Non-goals

- No shared database, no registry sync (both are deliberate non-features).
- No push to the phone (notifications stay local — separate 2026-10-04 ship).
