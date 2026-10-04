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

- [x] ~~**Biometric gate on owner actions**~~ SHIPPED 4b91769: requirePresence()
  before rotation Allow + ask Approve/Deny; key = trust root (fail-open on no
  hardware/enrolled/API error), hard refusal only on a failed/canceled real
  prompt; rotation-Deny ungated by design (friction-free rejection);
  FaceID-in-Expo-Go degrades to key-possession (SDK limitation).
- [x] ~~SecureStore for the phone signing key~~ — already done (K_SEED via
  expo-secure-store in App.tsx; verified 2026-10-04).
- [ ] **Phone-prompt history navigation**: SENT list is newest-20 only; a "load more"
  or per-prompt detail view (full excerpt, timestamps) once real usage shows the need.
- [ ] **Lane inject round-trip metric on the phone**: MACHINE card shows peer
  injects_total; add the median received→consumed from `botlink-server report`
  (already computed) as a lane health line.

## Next (design first)

- [ ] **daemon.ts audit findings (fork-1 audit 2026-10-04, PEER-OWNED file —
  their trigger layer, fixes land via their port or a coordinated PR)**:
  (2) MED-HIGH no quarantine gate on the trigger path — tagged message in a
  forbidden channel spawns a fullAuto worker (index.ts tools enforce
  CLANKER_BLOCKED_IDS/blocked file; daemon.ts has zero refs — the one
  enforcement layer with no gate); (4) router decisions embed untrusted
  job.prompt verbatim and the cwd is existsSync-validated only — crafted
  `{"cwd":"...\\.ssh"}` steers a worker anywhere existing; (5) handleLiveMessage
  jumps cursors to newest unconditionally — triggers missed during a gateway
  resume gap are permanently silent (partial gaps undetectable by
  construction); (6) pollOnce overwrites cursors after its await — a live
  write regresses → false GATEWAY STALE → re-login → double dispatch; (9)
  daemon.json written non-atomically + loadConfig fatals on parse failure at
  boot — one torn write bricks the daemon at start.
- [ ] **daemon.ts audit findings (fork-1 audit 2026-10-04, PEER-OWNED file —
  their trigger layer, fixes land via their port or a coordinated PR)**:
  (2) MED-HIGH no quarantine gate on the trigger path — tagged message in a
  forbidden channel spawns a fullAuto worker (index.ts tools enforce
  CLANKER_BLOCKED_IDS/blocked file; daemon.ts has zero refs — the one
  enforcement layer with no gate); (4) router decisions embed untrusted
  job.prompt verbatim and the cwd is existsSync-validated only — crafted
  `{"cwd":"...\\.ssh"}` steers a worker anywhere existing; (5) handleLiveMessage
  jumps cursors to newest unconditionally — triggers missed during a gateway
  resume gap are permanently silent (partial gaps undetectable by
  construction); (6) pollOnce overwrites cursors after its await — a live
  write regresses → false GATEWAY STALE → re-login → double dispatch; (9)
  daemon.json written non-atomically + loadConfig fatals on parse failure at
  boot — one torn write bricks the daemon at start.
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

- [x] ~~**pairing.ts audit findings 7+8 + botlink spool atomicity 11**~~
  SHIPPED (fork-1 audit round 2, our side): (7) listener tracks the OWNING
  socket — a second connection dropping (scanner, LAN probe) or revealing
  can never wipe a live half-exchange, and a non-owner phase 2 is refused
  non-destructively; (8) rollbackInterruptedCommit now completes the four
  cutover key renames (journal carries cutoverSelfKeys so a later arm's
  .next is never promoted by a lingering older journal; idempotent
  stamp-tied backups heal mid-cutover mixed keys); (11) `.inject.json` +
  `files/<id>/<name>` land via same-dir tmp+rename — the .tmp suffix never
  matches the consumer's filter, so a torn write can't archive silently.
  112/112.
- [x] Cross-fork audit round 1 (57fd25d + follow-up): fork-2's 7 findings ALL
  fixed (stuck-enqueued sweep, signedFetch counter serialization, enroll
  timeout, settle-once spawn finish, per-run posted marks, noCoalesce ask
  clicks, stale comment) + fork-1's 1/3/10/12 fixed same hour (rotation
  rebind error handler, atomic counters write + loud fail-open,
  withSender composed-length chokepoint, decideAsk O_EXCL cross-process
  claim). 109/109.
- [x] Round 5.1 answer excerpts (a784022) · Round 6 pocket lane dashboard (d4c7d94)
