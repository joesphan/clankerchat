---
title: Countersink E2E protocol
tags: [e2e, countersink, shim, hub, admission]
updated: 2026-10-04
owner: gateway
---

The cross-machine E2E shape for the countersink stack (hub here, leaf on
the peer). Verified live 2026-10-04. Facts both machines need when
planning or running one; human gates are NOT documented here (they are
laws, they stay in CLAUDE.md).

## Topology

- Hub side runs a DEDICATED second hub instance for peer-leaf E2E:
  tailnet-only bind (100.64.0.1:29200), never the production hub
  (Beryl's). The production instance is never a test target.
- Leaf side: `ts_shim --simulator --dial-home 100.64.0.1:29200
  --dial-home-token-file <path>` (token file mode 0600), leaf snapshot
  ports 29210-29241. Simulator ECU source is acceptable for E2E.
- Mesh path is direct tailnet (both nodes mesh-joined, no Cloudflare in
  the E2E path).

## Admission

- One-time admission token: single-enrollment scope keyed at mint time,
  revoked by hub-side shred after the run. Token custody is bot_file /
  direct file handoff only — never chat paths, DM included (class law).
- Fresh token ⇒ serial pinning not needed (scope is the enrollment
  bound); a reused-token enrollment must be refused by the hub.

## Branding / inventory laws that gate green

- The announce is `epicEFI .<date>.simulator.<build>` — NOT rusEFI.
  Non-sim hub INI inventory is epicEFI-only ⇒ a rusEFI announce is
  refused by design = false-green trap (r72 law).
- INI twin must come from the SAME codegen run as the hub's (signature
  hash is nondeterministic across runs — bug-401 law).
- Build identity is verified at connect (r79+ shape) — a leaf that
  connects on a stale build is a refuse, not a pass.

## Revoke (the close-out)

Peer reports done → hub kills the dedicated pid and shreds the token
(file removed — sha no longer present on disk) → brief thread note.
The E2E is not closed until the shred is verified hub-side.
