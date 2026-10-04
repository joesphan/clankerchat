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
- [x] ~~**Phone-prompt history navigation**~~ SHIPPED (round 7, 2026-10-04):
  GET /prompts?before=<createdAt ms>[&limit=1-50] pages strictly-older
  records (newest-last like the default branch, `more` says whether older
  exist); present-but-invalid cursor → 400 (never a silent fall-through to
  the default list). historyWindow() in prompts.ts; app "Load older" walks
  by the oldest rendered createdAt (frozen history pages, deduped against
  the live window); rows are tap-to-expand (full text + excerpt + stamps).
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

## Round — observability + phone report lane (2026-10-04, rounds 3 + 8)

S-tier #4 INTERACTION JOURNAL (src/journal.ts): append-only hash-chained
JSONL at <spool>/interaction-journal.jsonl — every slash invocation and
ask-button click the daemon sees, refusals included, who/what/verdict
(ids only, no display names). Chain = sha256(prevH + canonical JSON),
genesis file-bound, 2MB rotation to .1 (chain restarts per file);
readJournalTail fails closed to [] so /machine never breaks on tamper
(verifyJournalFile is the loud path). journalStats feeds the phone card:
"N refused interaction(s) last 24h".

S-tier #5 AUDIT WATCH (src/audit.ts + daemon sweep): discord.js-free
classification of guild audit entries scoped to OUR blast radius (bot id +
watched venues). critical = bot's posts deleted / watched channel deleted /
webhook created in a watched channel / bot kicked or re-rolled → ONE
human-eyes post per event through the tripwired sendToThread. notify =
channel modify + overwrites + webhook update/delete (journal + card only).
Resume cursor in daemon.state.json; sweep every 5min + boot; 403 → one-time
degrade + card alert, never spam. Card alert ring (5 / 24h TTL) folds into
watcher-state.json audit_alerts → /machine alerts.

NOTICES (round 8, src/notices.ts + dist/notice.js): the machine→phone
free-text report lane (owner: "let me know not in discord but just on the
phone"). Writers are LOCAL processes (notice CLI / sessions / daemon) on
<spool>/notices.json — bounded 50, seq-ordered (same-ms bursts keep
insertion order), atomic writes, leak-scanner REFUSES leak-shaped text at
append. Phone surface is read+ack only: GET /notices (newest window +
whole-registry unacked count), POST /notices/:id/ack, /notices/ack-all.
App: NOTICES card (unread badge, warn severity, tap-to-expand, dismiss
one/all), arrival banner once per notice per app session while unacked.
184/184.

Also this round: docs/context/topics/antigravity-cli.md (official headless/
permissions docs banked — envelope mode, --print-timeout, read_url rule
syntax) + gemini-ask.mjs upgraded to --output-format json + --print-timeout
3m (external SIGKILL demoted to 210s backstop; usage line on stderr; live
E2E re-verified).

## Round — audit→notices bridge, noise meter, haptics (2026-10-04)

CRITICAL AUDIT → NOTICES: the audit watch's critical events and its
one-time 403 degrade now ALSO write a warn notice — the phone banners
them on arrival, a human-eyes path that survives Discord itself being
the tampered surface. Journal kind widened to "noise" for the meter
below (chain-verified, stats stay blind to it).

OWN-POST NOISE METER (parked TODO item, shipped): countOwnPost at the
sendToThread chokepoint — rolling 1h per-thread window, threshold 10,
ONE journal NOISE line per thread per hour. Visibility only: no card
alert, no suppression (never cut the wire that reports). In-memory by
design — restart undercounts, never phantom-noise.

HAPTICS (expo-haptics ~57.0.3): ask arrival (warning), answer/failed
transition (success/error), notice arrival (warn→warning else light),
decision commit (medium). Fire-and-forget — no-engine devices no-op and
the flow never gates on feedback. 185/185; app tsc clean.

## Round — daily digest notice + notices window toggle (2026-10-04, round 9)

DAILY DIGEST: one notice per local day on the phone — the automated version
of the owner's "let me know not in discord but just on the phone". Cursor =
the REGISTRY ITSELF (newest daily-digest notice's local day): no state
field, no first-boot seeding, crash-safe by construction (the append IS the
commit). Two flavors, same ritual:
- daemon deployment (src/daemon.ts sweepDailyDigest): 24h journal counts
  (interactions/refused/critical+notify audit/noise) + CHAIN VERDICT — a
  broken chain files at warn severity with counts marked untrusted, so the
  digest doubles as a daily tamper check. dailyDigestText lives in
  src/journal.ts (pure, tested).
- watcher host (~/tools/clankerchat-watch.mjs): runs-since-start counter +
  lane verdict (this machine has no interaction journal — daemon-side
  feature). First digest fires 5s after boot (post lane-probe).

NOTICES WINDOW TOGGLE (phone): "Show older notices" widens GET /notices to
?limit=50 when the default window is full; "Recent only" shrinks back.
Limit rides a ref so the poll effect isn't re-armed; machine flip resets.

journal-verify CLI also landed this round-block (human-facing chain proof;
see commit 879056f). 187/187; watch+companion+botlink restarted; first
digest verified live in the registry (seq 3).

## Round — audit watch on the LIVE watcher host (2026-10-04, round 10)

The S-tier #5 audit watch existed only in the daemon flavor; the host that
actually runs here (~/tools/clankerchat-watch.mjs) had NO audit-log watch.
Now it does — same pure classifier (dist/audit.js), same contract: fetch
since cursor, classify to our blast radius, critical → one human-eyes
channel post (ids-only, users-parse owner mention) + warn notice, notify →
card alert line. Differences from the daemon flavor, on purpose:
- cursor persists in watcher-state.json (audit_cursor key, restored at boot
  BEFORE laneHeartbeat's first state write can clobber it — placement law);
- FIRST DEPLOY seeds to newest without back-alerting (days-old deletes are
  history, not incidents); restart gaps stay covered by the persisted cursor;
- no interaction journal on this host — notices + the Discord post are the
  record.

LIVE RESULT: fast-clank lacks View Audit Log in epicEFI → the one-time
honest degrade fired on all three surfaces (log, card alert line, warn
notice). The watch self-arms within 5 min of the permission being granted —
that's a guild-settings action (Joe's guild). Asked in the lane.

## Round — interaction journal on the live host + YOLO click fix (2026-10-04, round 11)

INTERACTION JOURNAL (watcher flavor): every slash invocation and ask-button
click the live watcher handles now hash-chains into
<spool>/interaction-journal.jsonl — same entry shape as the daemon flavor
(kind/type/detail/outcome/actor/name, ids only), refusals included (leak
shapes, mass mention, queue-full, venue-blocked, non-approver, dangling,
race-lost). jInteraction helper try/caught at every site — the reply always
matters more than the journal line. This brings journalStats (phone card
alert line), journal-verify, and the digest's journal counts alive on the
host where interactions actually happen. Quarantine path journals nothing
(absolute silence law).

YOLO CLICK BUG (caught live, fixed): the watcher's decide line binary-mapped
parsed.action to approved/denied — a YOLO button click (custom_id
ask:<id>:yolo, peer c2a7ebe's widened contract) recorded DENIED. Fixed to
the three-verb map; the enqueued trigger + askDecisionLine already spoke
yolo fluently downstream. Worth checking any other pre-c2a7ebe click handler.

DEGRADE NOTICE RESTART-SPAM GUARD (both flavors): the 403-degrade's
per-process one-time flag resets every restart — one identical warn notice
per restart is noise. Both flavors now skip when an unacked twin from the
last 24h is already in the lane. Verified live: three restarts, one unacked
degrade notice.

187/187; watch+companion+botlink restarted and verified.

## Round 12 — YOLO from the phone + one shared decision-instruction source (2026-10-04)

Gap found by surface audit: c2a7ebe gave Discord cards a third verb (YOLO =
one-shot full-auto) but the phone could only Approve/Deny — and BOTH watcher
delivery paths (button click + phone tap) told the spawned run only the bare
status word, so a YOLO run's semantics depended on which brain read it
(daemon.ts inlined the instructions; the watcher host didn't). Same class as
the round-11 binary-map bug: decision surfaces replicate the verb map and the
framing independently.

- src/asks.ts: `askDecisionInstruction(status, decider)` — ONE shared
  per-status instruction (approved = proceed exactly as asked; yolo =
  one-shot full-auto, no further asks, receipt in-thread; denied = stand
  down). daemon.ts's two enqueue fns render from it; the watcher's two
  delivery paths (button + companion) append it to the trigger content.
- src/companion.ts: `/asks/:id/(approve|deny|yolo)` with the three-verb
  decideAsk map — the binary map there was the round-11 bug class one commit
  away from re-minting YOLO taps as denials.
- App.tsx: YOLO button full-width in amber beneath Approve/Deny (the
  escalation, not a third peer), presence-gated like Approve with a prompt
  that says what it grants. New bundle marker literal (`yolo-route-v12`) —
  doctor BUNDLE_MARKER bumped so pre-round-12 bundles read STALE.
- 188/188 (+1 asks instruction test; companion yolo case inside the existing
  route test).

## Round 13 — watcher dist-drift guard (deployment-side, 2026-10-04)

Failure class: the live watcher (`~/tools/clankerchat-watch.mjs`) imports the
repo's dist/ libs at boot; every rebuild needs a manual service restart, and
forgetting it once means the live host silently runs OLD lib code (round 12's
framing fix would have been dead locally if that step had been skipped).

- Guard (watch.mjs): fingerprint every `dist/*.js` (name:mtimeMs:size); exit 0
  when it differs from boot AND has been stable across polls ≥45s (tsc writes
  incrementally — a mid-build read must never trigger) AND the pool is truly
  idle (no active runs, both queues empty, ≥10s since the last pool activity
  so a trigger mid-handler is never dropped — gateway events have no
  persistent cursor). Drift logs loudly at first sight; a busy pool defers
  the exit to its next idle moment instead of suppressing it.
- systemd user drop-in `restart-always.conf`: the base unit's
  `Restart=on-failure` leaves a clean exit(0) dead — `Restart=always` revives
  both drift exits and real crashes (explicit stop/restart still behave
  normally). Live-proven end-to-end: rebuild at 23:06:54Z → detected
  23:07:02Z → `stable 45s + pool idle 75s` exit 23:07:47Z → systemd revival
  23:07:52Z (NRestarts=1, no loop; guard inert on the new boot fingerprint).
- Same-class drift on companion/botlink/metro: DEFERRED (their idle
  definitions are harder — live SSH connections, in-flight signed requests,
  connected Expo clients — a dropped phone poll round-trips in 2s but a
  dropped pairing ceremony does not). Pattern is portable when wanted.
- Peer note: their daemon runs `node dist/daemon.js` under systemd — same
  drift class on Joe's machine; the fingerprint+idle+exit+Restart=always
  pattern ports as-is (their idle = no active runs + no lane connections
  mid-ceremony).

## Round 14 — boot-replay cursor: the restart dead-window is closed (deployment-side, 2026-10-04)

Class: every watcher restart (manual, round-13 drift revival, crash-revival,
reboot) has a dead window — RestartSec 5s + boot ~1.5s, longer after crashes —
where arriving Discord messages were LOST forever. The gateway has no push
cursor: a tag landing in the gap never triggered, and nobody knew.

- Cursor store: `message-cursors.json` in the spool — per-watched-channel
  last-seen snowflake, advanced at the TOP of the messageCreate handler
  BEFORE any gate (a skipped message still counts as delivered — own posts,
  bot-authored, and webhook skips are identical on replay, so the cursor must
  move past them or they refetch forever). Atomic tmp+rename write.
- Boot replay (ready handler, post-slash-registration): channels WITH a
  cursor get one `fetch({after, limit: 50})`; missed messages re-enter the
  SAME handler via `client.emit("messageCreate", m)` — gates, quarantine,
  coalescing, ask idempotence all unchanged. Channels WITHOUT a cursor seed
  from the newest message with NO back-replay (the round-10 audit-cursor
  precedent: first contact never back-alerts). Saturated window (50 fetched)
  logs honestly — older messages are NOT replayed.
- Scope enumeration matches the live gate exactly: root channel + every
  thread whose parentId is the root. GOTCHA fixed live: the per-channel
  `channel.threads.fetchActive()` is unusable under our intents (non-iterable
  result); `guild.channels.fetchActiveThreads()` + parentId filter is the
  working shape (11 live threads under #clankerchat, incl. the epicNode
  thread).
- Ordering trade-off, stated honestly: cursor persists BEFORE processing
  completes, so a crash mid-processing loses that one message (at-most-once
  for in-flight) while the down-window replays (at-least-once for the gap).
  The reverse order would double-process on every crash — this is the right
  default.
- Live-proven: watcher stopped → probe posted 17:14:02Z → boot 17:14:17Z →
  `boot replay: 1 missed message(s) … re-processing` 17:14:18Z → cursor
  advanced to the probe id exactly.
- Peer note: same class on their daemon host — ports as-is (cursor file +
  fetch-after on ready + emit into the same handler; same fetchActive trap).
