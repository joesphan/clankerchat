---
title: Current sync pointer
tags: [state]
updated: 2026-10-04
owner: gateway
---

This file churns by design (sync pointer) — exempt from the
cache-stability corollary. Keep it tiny.

- Upstream: joesphan/clankerchat main (canonical merges land here).
- Fork (carries our work between syncs): tjbtiller/clankerchat main.
- Both sides green at: 276ae35 (92/92) as of 2026-10-04 (ours live; peer
  fast-forwards the fork on receipt of each lane sync note — this line
  updates again on their ack).
- joesp main ahead at 38141d6+seed-round (92/92, 2026-10-04): remaining
  three seed topics (botlink-runbook, daemon-json-semantics — dot dropped,
  slug jail —, consumer-patterns) + maxConcurrent default fix in
  orchestrator-laws — fork fast-forwards on receipt of the lane sync note.
