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
- Both sides green at: 6e64b85 (origin) + 16af9e1 (fork), our merge-back
  19b725b, 119/119, 2026-10-04. Full audit arc closed BOTH sides: fork-1's
  12 findings = 1/3/10/12 ours (061e014) + 7/8/11 ours (16af9e1: owner-
  scoped pairing wipe, cutover journal recovery, atomic spool writes) +
  daemon.ts 2/4/5/6/9 ALL ported by the peer (bcae024: daemon-guard.ts
  quarantine gate, cwd containment, sweepMissedRange, monotonic cursors,
  atomic config + deaf-not-dead boot; reload residual 6e64b85). Fork-2's
  7 findings shipped 57fd25d.
- Peer owes: 16af9e1 pickup (shared files, plain merge). After that the
  forks converge at 119/119 with zero open audit items.
