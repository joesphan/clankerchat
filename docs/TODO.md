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
- [x] ~~**Slash commands (/status, /ask)**~~ SHIPPED 2026-10-04 (owner
  green-lit): one grouped command `/clankerchat` (subcommands `status`, `ask`)
  registered guild-scoped on every watcher boot — repo core in src/slash.ts
  (spec + shared status-card renderer + registration; tests/slash.test.mjs),
  gateway glue in the watcher. `ask` text is a human-priority trigger with
  API-verified identity; leak/mass-mention tripwires refuse at the door;
  `status` renders the same card as the typed fast-path, EPHEMERAL (channel
  stays quiet). One-time portal step: re-auth the bot invite with
  `scope=bot+applications.commands` (SETUP.md).
- [x] ~~**Local notification when a prompt is answered**~~ SHIPPED 2026-10-04
  (expo-notifications ~57.0.21): banner fires only on a poll-OBSERVED
  transition into answered/failed — the first poll after app open seeds the
  status map silently, so stale answers never spam on reopen. NO push
  anywhere (owner call): local-only means the app process must be alive
  (foreground or Android's brief background window); iOS suspension =
  silence until reopen. Header law updated: the no-notifications clause is
  now scoped to pairing/SAS material.

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
- [x] ~~**Components V2 ask cards**~~ SHIPPED: ask posts ride
  IS_COMPONENTS_V2 (flag 32768, verified in discord.js 14.27 raw-REST) as one
  Container tree — question (id 1 TextDisplay), fuse (id 2 clock slot), button
  row (id 3), custom_id contract unchanged. Edit sites fork on shape via
  isAskV2Message (the flag is permanent per-message, so legacy asks stay
  legacy forever); rebuildAskV2ForEdit does the tree surgery with
  disabled-undefined = never re-enable (countdown/decision race closed).
  Decision edits now DISABLE the row (was: remove) — both shapes render the
  same decided card. 123/123. joesp-desktop watcher port (merged bb068ec):
  daemon edit sites forked (click/retire/companion/expiry) + the 60s
  countdown loop (legacy sentinel line / V2 clock slot).
- [x] ~~**Prompt search on the phone** (app-side)~~ SHIPPED: FIND card —
  one-shot search (submit/button, not per-keystroke), results newest-first
  with status + excerpt; signedFetch signs pathname-only so ?q= rides free.
- [x] ~~**Ask expiry countdown edit**~~ SHIPPED: buildAskCountdownEdit in
  asks.ts (sentinel-idempotent "⏳ Xm left" line, ceil minutes min 1, null once
  decided/expired) + the watcher's 60s loop PATCHes each pending ask's message
  once a minute with the button row passed back unchanged; the expiry sweep
  owns terminal state, the countdown only decorates it.
  (cherry-picked from fork 19144eb; our daemon-side 60s loop landed with the
  V2 watcher port — the cherry-pick was library-only.)
- [x] ~~**Doctor → phone**~~ SHIPPED: /machine serves `alerts` — the two
  FAIL lines a pocket owner can act on (stuck pending prompts >60s,
  phone-decided asks undelivered), same file scans as the CLI doctor,
  inlined per-poll and rendered red as ⚠ lines. Metro/bundle freshness
  stays CLI-doctor-only (a 2s poll must not curl the dev server).

## Ideas (parked — owner decision or bigger design)

- [ ] Local notification when a prompt is answered (expo-notifications). NOTE: push was
  rejected for pairing SAS display; this is a different surface but the same
  "app as attention channel" question — Tyler's call.
- [ ] Slash commands (/status, /ask) for humans in #clankerchat — less typo friction,
  but a new bot surface to review. Only if humans actually want it.
- [ ] Multi-machine machine-switch state: prompts/asks are per-machine; a "this prompt
  was answered on the OTHER machine" cross-reference needs a shared registry shape.
  → DESIGN DRAFTED 2026-10-04: docs/context/topics/multi-machine-prompts.md
  (phase 0 = trivial peer line on the MACHINE card; phase 1 = route hint +
  lane `prompt-outcome` echo verb, needs BOTH machines; open questions listed
  for joesp-desktop). Owner green-lit; bilateral review before code.
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
