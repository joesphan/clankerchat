# clankerchat companion

Allow/deny botlink pairing confirmations from the owner's phone.
Design + threat model: [`../docs/companion-app.md`](../docs/companion-app.md) —
read that first; this app's security properties are defined there.

## What it does

- **Enroll once per machine**: the machine runs
  `npm run botlink -- companion --enroll [--bind <LAN addr>]` and prints a
  single-use QR (10-minute TTL). The app scans it, generates its **own**
  Ed25519 keypair on-device (private half lives in OS secure storage and
  never leaves), and the machine pins only the public line.
- **Watch**: with `companion --serve` running on the machine, a completed
  pairing exchange appears here automatically (2s poll while foregrounded):
  mode, peer name, fingerprints, and this machine's SAS.
- **Allow**: type the PEER's 8 SAS characters (the same transcription check
  the terminal `pair --confirm` uses) and confirm. The machine runs the same
  journaled two-phase commit + audit append as the CLI.
- **Deny**: one tap; state cleared, nothing written.

The SAS is display-only by design: no copy, no share sheet, no notifications
(agents — and apps — never relay SAS). Compare values the way the pairing
doc says: each owner reads their OWN value and the owners exchange them as
humans.

## Run it (Expo Go — no store, no signing)

```
cd companion-app
npm install
npx expo start
```

Phone: install **Expo Go** (Play Store / App Store), scan the QR/metro URL,
same Wi-Fi as the machine. The dev server must be reachable from the phone
(`npx expo start --tunnel` also works for odd networks).

Notes:
- Android needs the machine reachable over plain HTTP on the LAN — Expo Go
  permits cleartext for development. The auth is the Ed25519 request
  signature, not TLS; the traffic carries only public values (fingerprints,
  SAS) that the screens show anyway.
- Revoking a phone: delete `botlink-keys/companion-keys/<fingerprint>.pub`
  on the machine.
- `npm run verify:protocol` (repo root must be built: `npm run build`)
  re-proves this app's byte-level protocol against the real server —
  run it after touching anything in `App.tsx`'s crypto helpers or
  `src/companion.ts`.
