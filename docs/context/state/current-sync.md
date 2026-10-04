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
- Both sides green at: fa56548 (96/96, 2026-10-04) — round 4 shipped ours at
  0cab171, peer ported + added the daemon-side companion-decision sweep and
  unsigned /asks→401 (fa56548); phone-approve E2E verified live both sides.
- Peer openwolf seed half (botlink-runbook, daemon-json-semantics,
  consumer-patterns + maxConcurrent correction) merged at 89fab54.
