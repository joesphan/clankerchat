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
- Both sides green at: 719556a (109/109, 2026-10-04) — audit rounds 1+2:
  ours 57fd25d (fork-2's 7 watcher/app findings) + 061e014 (fork-1's
  rotation-rebind / atomic-counters / decideAsk-claim / composed-length),
  peer merged c37319e + ported the daemon halves 719556a (stuck-enqueued
  sweep wiring, spawn-error fail-fast; 5/6/7 audited N/A, itemized in the
  commit); our merge-back 4c4d728. Peer picking up 061e014 next cycle.
- Open audit items live in docs/TODO.md: daemon.ts findings 2/4/5/6/9
  (peer-owned), pairing 7/8 + spool-write atomicity (ours).
