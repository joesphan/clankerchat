# Improvement backlog

Owner-set 2026-10-04: "improve everything — botlink, expo/clankerchat, discord, together."
Bilateral: both sides mine this file; take an item, ship it, strike it. Reference docs
live locally at `~/projects/reference-docs/` (discord-api-docs, discordjs guide, expo,
react-native) — mine them before designing.

## Working rules (standing)

- No Claude session restarts to deliver — everything lands in the service layer
  (watcher/daemon/companion/metro) or repo code.
- Clanker↔clanker work rides botlink; Discord is human-eyes only.
- Prompt COUNT is the cost unit (Tyler's law) — efficiency wins are real wins.

## Now (high value, low risk)

- [ ] **Biometric gate on owner actions** (expo-local-authentication — SDK 57 page in
  reference-docs): FaceID/fingerprint before Allow/Approve on the phone. The ask surface
  is possession-gated today (the enrolled key); biometrics make it presence-gated.
  Rejection/fallback behavior must fail CLOSED (no biometrics enrolled → button works,
  because the key is still the trust root — decide this explicitly).
- [x] ~~SecureStore for the phone signing key~~ — already done (K_SEED via
  expo-secure-store in App.tsx; verified 2026-10-04).
- [ ] **Phone-prompt history navigation**: SENT list is newest-20 only; a "load more"
  or per-prompt detail view (full excerpt, timestamps) once real usage shows the need.
- [ ] **Lane inject round-trip metric on the phone**: MACHINE card shows peer
  injects_total; add the median received→consumed from `botlink-server report`
  (already computed) as a lane health line.

## Next (design first)

- [ ] **Components V2 ask cards** (Discord): reference `developers/components/reference.mdx`
  — Container/Section/Text Display (types 9/10/17) would give ask cards real structure
  (question as text display, buttons as section accessory). VERIFY discord.js/raw-REST
  support for the IS_COMPONENTS_V2 message flag in our pinned versions before designing.
- [ ] **Ask expiry countdown edit**: watcher edits the ask message with a live-ish
  countdown once per minute while pending (one PATCH/min, stop at decision) — humans
  see the lazy-consensus fuse burning.
- [ ] **Prompt search on the phone** (server-side): GET /prompts?q= — promptId lookup
  so the owner can find "that thing I asked Tuesday" without scroll.
- [ ] **Doctor → phone**: the doctor's FAIL lines (sweep down, stale bundle) are exactly
  what the MACHINE card should escalate in red, not just journal text.

## Ideas (parked — owner decision or bigger design)

- [ ] Local notification when a prompt is answered (expo-notifications). NOTE: push was
  rejected for pairing SAS display; this is a different surface but the same
  "app as attention channel" question — Tyler's call.
- [ ] Slash commands (/status, /ask) for humans in #clankerchat — less typo friction,
  but a new bot surface to review. Only if humans actually want it.
- [ ] Multi-machine machine-switch state: prompts/asks are per-machine; a "this prompt
  was answered on the OTHER machine" cross-reference needs a shared registry shape.
- [ ] Watcher-side own-post noise meter: count own posts per thread per hour, journal
  a NOISE line past a threshold — enforcement visibility for the quiet-discord law.

## Done (strike-through recent)

- [x] Round 5.1 answer excerpts (a784022) · Round 6 pocket lane dashboard (d4c7d94)
