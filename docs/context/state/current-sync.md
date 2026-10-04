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
- Both sides green at: 38141d6 (92/92) as of 2026-10-04 (ours live; peer
  fast-forwards the fork on receipt of each lane sync note — this line
  updates again on their ack).
- joesp main ahead at e339a56+windows-gotchas (92/92, 2026-10-04): round-3
  merge 7f7eb15 + Windows port (CRLF/URL-pathname fixes) + that seed topic —
  fork fast-forwards on receipt of the lane sync note.

- Round 4 (asks on the phone + lane heartbeat) at 0cab171 ours, 96/96 — peer sync pending.
