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
- [x] ~~**Lane inject round-trip metric on the phone**~~ SHIPPED: /machine
  serves `laneHealthMs`/`lanePaired` from the chain-verified inject.log
  (deriveInjectMetrics — survives watcher death, omitted honestly on a
  corrupt log); MACHINE card renders "injects: X.Xs median · N paired".
- [x] ~~**Prompt search on the phone** (server-side)~~ SHIPPED: GET
  /prompts?q= searches the WHOLE registry (promptId or text substring,
  case-insensitive, newest 50) — signature covers pathname only, so the
  query never breaks auth. App-side search box = next round.
- [ ] **Phone-prompt history navigation**: SENT list is newest-20 only; a "load more"
  or per-prompt detail view (full excerpt, timestamps) once real usage shows the need.

## Next (design first)

- [x] **daemon.ts audit findings (fork-1 audit 2026-10-04) — ALL FIVE fixed
  in the joesp-desktop port (audit round 2, 2026-10-04)**: (2) quarantine
  gate — ChannelBlocklist (src/daemon-guard.ts) mirrors index.ts's
  CLANKER_BLOCKED_IDS/FILE contract on the trigger path (isTrigger) AND the
  daemon's own outbound posts (sendToThread); (4) router prompt frames
  job.prompt as UNTRUSTED data + router-inferred cwds must resolve inside
  reposRoot (isUnderRoot — existsSync alone was the hole); (5) handleLiveMessage
  never jumps a cursor past unseen messages — behind-cursor live messages
  sweep the missed REST range (sweepMissedRange, one sweep per channel,
  bounded rounds), resume/identify each backstop-sweep every held cursor,
  redeliveries at/below cursor are skipped (exactly-once); (6) advanceCursor
  is monotonic everywhere a cursor is written — stale poll positions can no
  longer regress live writes; (9) daemon.json/daemon.state.json writes are
  tmp+rename atomic (atomicWrite) + a corrupt daemon.json at boot quarantines
  a copy and boots DEAF (alive, loud) instead of bricking. Guard logic lives
  in src/daemon-guard.ts (daemon.ts is an unimportable composition root) —
  tests in tests/daemon-guard.test.mjs, suite 116/116.
- [ ] **Components V2 ask cards** (Discord): reference `developers/components/reference.mdx`
  — Container/Section/Text Display (types 9/10/17) would give ask cards real structure
  (question as text display, buttons as section accessory). VERIFY discord.js/raw-REST
  support for the IS_COMPONENTS_V2 message flag in our pinned versions before designing.
- [ ] **Prompt search on the phone** (app-side): search box wired to GET
  /prompts?q= (server half shipped — see Now section).
- [ ] **Ask expiry countdown edit**: watcher edits the ask message with a live-ish
  countdown once per minute while pending (one PATCH/min, stop at decision) — humans
  see the lazy-consensus fuse burning.
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
