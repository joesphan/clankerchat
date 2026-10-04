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
  now scoped to pairing/SAS material. VERIFIED ON-DEVICE 2026-10-04 ~17:00Z
  (owner phone, app foregrounded): enqueued→answered transition → banner.
  Debugging artifact worth remembering: a status flip that only ADDS terminal
  fields without changing the status value is a non-transition — the map
  diffing keys on the status string.

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

- [x] ~~Local notification when a prompt is answered~~ SHIPPED + VERIFIED
  ON-DEVICE 2026-10-04 (see Done above).
- [x] ~~Slash commands (/status, /ask) for humans in #clankerchat~~ SHIPPED
  2026-10-04 (see Done above).
- [x] ~~Multi-machine machine-switch state: prompts/asks are per-machine~~
  PHASE 0 SHIPPED 2026-10-04 (88f0fee, peer recency line on the status card)
  + PHASE 1 SHIPPED OUR SIDE 2026-10-04 (0e5c4ea): `route:"peer"` prompt
  records, lane `prompt-outcome` verb, 30-min routed budget, receive-side
  echo via applyPeerPromptOutcome, app route toggle. Design decisions
  owner-delegated (channel post 1556355104607707247): 15s-sweep delivery,
  excerpt-only answers, 30-min expiry. Peer APPROVED the port 2026-10-04
  17:46:01Z via ask card 1556361720144990306 (ask muu43jxx-2c0bd7f4,
  decidedBy joesphan; orchestrator relay 1556362271331057765). Remaining:
  PEER PORTS THEIR HALF (inject-consumer outcome emit + sweep route branch +
  canRouteToPeer) — rides their merge per the fork law; first live routed
  prompt pmtroute0001 sent 17:34Z (inject ack 1791135289748-17f1e7). Their
  port landed as 4c05af1 (route branch + outcome intake, merged our side in
  184e6b0) but is MISSING the answering half — no consumer branch emits
  prompt-outcome when an inbound question-task run finishes on their machine,
  so them→us routing is complete end-to-end while us→them runs the question
  and rots honestly at 30 min; gap + fix shape reported in lane receipt
  1791136610681-e4f97a, live probe pmroute0002 sent 17:57Z. Phase 2
  (peer index view) deferred until routing shows real use.
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
- [x] **Feature round 2026-10-04 #2 — status lines + image intake**
  (peer-briefed via inject 1791138196284-3a05fe). STATUS LINES (1a15636):
  shared run-progress.ts helpers — one editable "still working" line ≥4min,
  5-min edits, finish-deleted; typing heartbeat pre-existed; watcher wired +
  live. IMAGE INTAKE (8dfb5c1): attachments.ts — two-stage read because the
  orchestrator's zero-file-tools law holds: spool download (caps 10MB/4,
  sanitized names) → scoped vision pre-pass (claude -p --allowedTools Read,
  describe-only, 90s cap) → DESCRIPTIONS only into the untrusted block;
  image-only = prompt-shaped for owner/listen lines; coalescing merges
  image sets; 2h TTL sweep. Live-smoked on a text-bearing PNG (read
  accurately, framing self-enforced). 154/154, fork tip 8dfb5c1.
  Routed-prompts phase 1 CLOSED bilateral same round: pmroute0002 answered
  on outcome echo 18:10:50Z; pmtroute0001 honest-rot; my earlier gap report
  corrected (their emit was machine-local — repo greps can't see it).
  Open: Joe's companion app error ("app has erro" 18:07:48Z class,
  notification issue) — awaiting error text/screenshot paste.
- [x] **Gemini Spark custom-app gateway (owner 2026-10-04)** — 4e472a8,
  service clankerchat-spark LIVE on 127.0.0.1:8791 (bearer on, uniform
  dead-host 404 incl. well-known probes, rate-gated; boot smoke: handshake
  200 / everything else 404). Tools = phone-app blast radius (ask/result/
  status/list on the proven prompt-record path, fp spark:<hash-head>).
  cloudflared 2026.9.3 staged at ~/tools/cloudflared. AWAITING OWNER:
  domain-on-Cloudflare answer + tunnel-login click + Spark dialog paste
  (docs/SPARK.md has the runbook). Joe's companion app error: Tyler says
  working — item closed, no screenshot needed.
- [x] **Spark gateway public leg LIVE (2026-10-04 ~18:57Z)** — named tunnel
  "spark" (2bb03a0f) on 87fcf90e.rapidracing.us → 127.0.0.1:8791, user
  services clankerchat-tunnel + clankerchat-spark both active. WAN-verified:
  dead-host 404 + x-robots noindex through CF edge; handshake 200; first
  spark-driven prompt pmtnwsfetfd answered in 23s (fp spark:6d6039b6…,
  posted channel root). Connect card: ~/tools/spark-connect.txt (0600 —
  URL+token). Crawl posture: unguessable subdomain + 192-bit path + uniform
  404 + noindex (d92e7db). REMAINING: owner pastes URL into Spark custom
  apps (web), notes credential fields if any.

## Round — spark egress law (2026-10-04, d09a856)
Tyler: "no request from discord from other users other than the user can go out to
gemini… no email or anything can get out." Landed three independent layers in
spark-mcp: spark-only record visibility (foreign = indistinguishable miss),
scrubForEgress (emails/mentions/7+digit runs) under safeExcerpt on every
human-shaped egress string, projectWatcherFacts telemetry-only machine_status.
Watcher (machine-local) carries the run-side framing: spark answer excerpts
ride to Google — machine facts and own words only. 167/167. Spark surface
confirmed working end-to-end by Tyler (Google validator accepted path-only
URL; @appname tag forces the tool connection in a Gemini prompt). Peer
briefed: inject 1791141604139-5c9210 (cites 4e472a8 d92e7db 33ca049 d09a856).
