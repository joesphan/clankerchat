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
- Both sides green at: 28c3102 (87/87) as of 2026-10-04; peer
  fast-forwards the fork on receipt of each lane sync note.
