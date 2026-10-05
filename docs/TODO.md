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
- [x] ~~Watcher-side own-post noise meter: count own posts per thread per hour, journal
  a NOISE line past a threshold — enforcement visibility for the quiet-discord law.~~
  SHIPPED 2026-10-04 (countOwnPost at the sendToThread chokepoint, rolling 1h
  window, one journal NOISE line per thread per hour — see the round record
  below; this checkbox was stale).

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

## Round 15 — repo-side dist-drift guard: serve + companion self-restart on rebuild (2026-10-04)

Class: rounds 13–14 closed the drift/dead-window hole for the WATCHER host
only — but `botlink-server` serves from `dist/` too, and both repo-side
services (lane serve + companion surface) were running stale code after every
rebuild until a human restarted them. The lane hub and the phone surface had
no self-update path at all.

- `armDistDriftGuard(label)` in src/botlink-server.ts, wired into BOTH serve
  flavors (`serve` and `companion --serve`): fingerprints the directory the
  entry script lives in (`name:mtimeMs:size` per *.js, sorted, joined — same
  shape as the round-13 watcher guard), and when it changes from boot AND is
  stable across polls (tsc writes files incrementally), exits 0 for the
  service manager to revive on the new code. Guard is inert on unreadable
  dirs (never exits), whole body fail-quiet, and disabled via
  `CLANKER_BOTLINK_DRIFT_GUARD=0`; poll/stability windows env-tunable
  (`_DRIFT_POLL_MS`/`_DRIFT_STABLE_MS`) so tests run it at 150ms/400ms.
- Restart=always drop-ins for both units (the round-13 trap: the base
  Restart=on-failure leaves a deliberate exit(0) DEAD). companion RestartSec=3
  (stateless surface, phone re-polls at 2s), botlink RestartSec=5 (lane
  injects queue in the spool behind it).
- Tests: tests/drift.test.mjs — offline, pointed at a COPY of dist/
  (`dist-drifttest/`, now gitignored) so fingerprint touches never bounce the
  production services. Serves bind `127.0.0.1:0` (ephemeral). Covers:
  serve drift-exits clean with both log lines; guard=0 stays up on the same
  touch; companion flavor carries the same labeled guard.
- parsePort bug class, caught live by those tests: the old
  `Number(x) || default` sent an explicit ":0" (ephemeral request) to the
  DEFAULT port — a test server on ":0" tried to take the production lane port
  47421 and died EADDRINUSE against the live listener. parsePort() now honors
  explicit valid ports at all 6 listen sites (serve, pair --arm x2, companion
  x2, arm-rotate dial).
- Live-proven full-stack (one build, three guards): rebuild 17:20:37 → both
  repo guards detect at 17:20:38 → both exit at the 45s mark 17:21:23 →
  botlink revived (NRestarts 1), companion auto-revival journaled
  ("Scheduled restart job, restart counter is at 1") at 17:21:26 — a manual
  restart 2s later reset its counter to 0, which is cosmetic. 190/190.
- Peer note: repo-side code this time (not watcher-side) — plain merge +
  rebuild + restart carries the guard on their Windows box, but their units
  need the SAME Restart=always drop-ins (Task Scheduler or SCM equivalent)
  or the clean drift exit stays dead. parsePort applies to their tree as-is
  (same falsy-|| shape at the listen sites).

## Round 16 — identity-noise journal: webhook + spoof evidence, phone-visible (2026-10-04)

Class (S-tier #4): webhooks and content-declared-identity attempts are the
display-identity spoof class (the demonstrated SanGear compromise vector),
yet both were skipped with a console log only — evidence that scrolls away
with journalctl rotation. The hash-chained journal is the audit trail; these
events belong in it.

- Watcher (~/tools/clankerchat-watch.mjs + watch-history.mjs): new jNoise
  helper (kind "noise", same never-break-the-path law as jInteraction) +
  pure webhookJournalLine/spoofJournalLine helpers (ids + neutralized capped
  snippet, quoted display name is data). STRUCTURAL FIX: the webhook skip
  moved to AFTER the quarantine gate — it used to sit before it, and
  journaling from the old position would have paid for/surfaced quarantined
  events (silence law absolute). Spoof check was already after quarantine.
- Flood guard: past 25 noise entries in a rolling 60s window the rest are
  suppressed and ONE honest summary line closes the window — a webhook storm
  must not turn the evidence log into a disk-fill vector.
- Repo (this tree): journalStats returns a window-scoped `noise` count;
  companion /machine card surfaces it ("N identity-noise event(s) last 24h
  (webhook/spoof)"); journal-verify CLI prints it. All additive — consumers
  read named fields.
- Watcher suite 22/22 (new: line composition, neutralization inside snippet,
  cap, absent-field degradation, spoof shape); repo suite 190/190. Watcher
  restarted; journal chain VERIFIED post-deploy. Boundary stated honestly:
  no synthetic webhook can be fired at the live watcher (webhook creation is
  owner-gated by design), so the branch is proven at the unit level + the
  glue is 3 lines at a verified-restart checkpoint.
- Organic round-15 proof: this round's rebuild was the first deploy where NO
  manual service restarts happened — companion + botlink[serve] detected the
  dist change at 17:33:13Z, exited at the 45s mark 17:33:58Z, and systemd
  revived both on the new code unattended.
- Peer note: your daemon already has a noise-kind writer (own-post meter) —
  the delta is journaling the webhook + spoof skips on your trigger path and
  the stats/card plumbing. Same quarantine-ordering caveat applies wherever
  your skip gates sit.

## Round 17 — audit round 3: sweep/decide race, rotation-stable chain, watcher hardening (2026-10-04)

Two audit agents swept the rounds-12–16 code (repo + watcher). 15 findings,
all triaged and fixed this round. Severity order: the ask-race kernel first,
then parse/bind honesty, then the watcher's throw/liveness classes.

- R1 (HIGH, asks.ts): sweepExpiredAsks did read-modify-write WITHOUT the
  O_EXCL claim decideAsk takes — a phone DENY landing between listPendingAsks
  and the write was flipped to approved/auto-expiry. The sweep now claim-gates
  exactly like a deciding surface (loses to a live claim, releases its OWN
  claim on write failure so the next sweep retries), and decideAsk treats
  expiry as a hard boundary on EVERY deciding surface (companion tap, Discord
  click, sweep): past the fuse, pending stays pending — the sweep owns it.
  Claim files persist after decisions (decision-in-flight proof).
- R2 (journal.ts): genesis was bound to the CURRENT filename — every healthy
  rotation made .1 fail verification as a false tamper alarm. Genesis now
  strips a trailing `.1` (journal-identity-bound, rotation-stable).
- R6: readJournalTail prepends verified .1 entries when the live file is
  shorter than n — the 24h stats window survives a rotation (a flood big
  enough to rotate is exactly the window stats must not forget).
- R3 (botlink-server.ts + spark-mcp.ts): `Number("") === 0` bound an
  EPHEMERAL port silently on a templated `HOST:"$PORT"` with empty PORT.
  parsePort (now EXPORTED, import-guard added so tests can import the CLI
  module without dispatching cmdServe) treats empty/whitespace as UNSET;
  spark-mcp port follows the same law.
- R4: `listenSpec.split(":")[0] ?? "127.0.0.1"` was dead code — "" is not
  nullish — so a ":47421" spec bound the pairing listener on `::` wildcard
  while every other listener clamps to loopback. Now `||`.
- R5 (companion.ts routes): POST /asks/:id gained the expiry pre-check (409
  status:"expired" — the sweep owns it) and post-decideAsk provenance honesty
  (a lost claim race answers 409 with the WINNER's verdict, never a fake 200
  logging the decision as this phone's).
- W1 (attachments.ts): `Array.isArray(msg.attachments)` is false for the
  discord.js Collection — the whole image feature was dead code on the
  watcher. attachmentList() normalizes Array | .toArray() | .values().
- Watcher (~/tools, per-machine — recipe shared with the peer, not in this
  tree): W2 transient-own-post guard (⏳ status line / salvage line / canned
  status card no longer mark runs posted nor pollute phone excerpts — pure
  isTransientOwnPost in watch-history.mjs); W3 refuse-before-claim on the
  companion-decision and phone-prompt sweeps (full queue defers UNCLAIMED,
  15s retry) + deferred auto-approval retry scan (60s) so a full bot queue
  no longer shift-drops claimed jobs; W4 every timer body try/caught (a
  repo-lib throw in an interval killed the watcher process) + finishPrompt
  guarded at the exit handler + safePeerLabel at laneFacts capture (a
  leak/mass-mention-shaped PEER-CONTROLLED bot name used to flow into posts
  the watcher makes directly, bypassing send tripwires); W5 boot-replay
  emit-time dedup (messages delivered live during the fetch await were
  re-emitted → double runs); W6 noise-flood summary flushes on a one-shot
  timer (a storm ending quiet never wrote its own evidence line); W7a
  lastPoolActivity bumped at claim points (drift exit could land between
  claim and enqueue, losing claimed deliveries); W8 companion decision edit
  forks on V2 shape like every other terminal edit; W9 fs.watch error
  handler, prepareImages mkdir guard (a spool failure no longer kills the
  run pre-spawn with its claims), and a 30s SIGKILL-confirmation fallback
  (a D-state child never emits exit → pool wedge). Plus two policy adds:
  click-path expiry pre-check (honest "ask already expired" ephemeral) and
  the forbidden-venue gate on the BUTTON path (quarantine law parity with
  slash).
- Tests: repo 197/197 (was 190 — sweep-claim race, expiry boundary, rotation
  chain + tail spanning, attachmentList, parsePort, companion expired-tap
  route); watcher 24/24 (isTransientOwnPost template + near-miss matrix).
- Deploy: build → botlink[serve]+companion drift-revived at 17:59Z unattended
  (third consecutive no-manual-restart deploy); watcher manually restarted
  18:05 local (the guard watches dist/ only), clean boot.
- Known coupling (round-18 candidate): isTransientOwnPost lives in the
  local watch-history.mjs but matches strings RENDERED BY THE REPO
  (run-progress.ts statusLine, slash.ts card header) — if those templates
  change, the matcher must follow. The tests pin today's shapes; moving the
  matcher into run-progress.ts would remove the drift risk.

## Round 18 — isTransientOwnPost + salvage template moved into the repo (2026-10-04)

The round-17 known-coupling, closed. The transient-own-post matcher and the
crash-salvage line template were local to one machine's watcher while the
strings they match are RENDERED BY THE REPO (run-progress.ts statusLine,
slash.ts renderStatusCard header) — a wording change on either side would
silently un-match that machine's own machinery, resurrecting the W2 bugs
(status line marking a crashed run "posted" → swallowed salvage; boilerplate
as a phone prompt's answer excerpt).

- src/run-progress.ts: `salvagePostLine(why)` (the crash/timeout salvage
  text, previously a bare literal in the watcher's finish path) and
  `isTransientOwnPost(content)` (first-line matcher for the three machinery
  shapes: ⏳ status line, salvage line, canned-card header). run-progress.ts
  is the charter home — "line shape shared across machines" — so the peer's
  daemon (same salvage-post feature) gets template + matcher free on merge.
- tests/run-progress.test.mjs: +3 tests. The drift-kill property is the
  round-trip pin — the matcher is asserted against the ACTUAL generators
  (`statusLine(...)`, `salvagePostLine(...)`, `renderStatusCard(...)` first
  line AND whole card), so a template edit fails the suite in the same
  commit. Near-miss matrix (truncated status line, trailing graft, missing
  anchor phrase, header without suffix, empty/null, prose that mentions the
  words, machinery text on line 2) moved over from the watcher suite.
- Watcher (~/tools, per-machine): imports both from dist/run-progress.js,
  salvage send now posts salvagePostLine(why); watch-history.mjs drops its
  copy (pointer comment left); its 2 local tests moved to the repo suite.
  Watcher tests 22/22.
- Deploy: watch.mjs edited BEFORE the build, so the round-13 drift guard's
  self-revival loads new dist + new watch.mjs in one boot — no manual
  restart window where an old watch.mjs could import a missing export.
- Tests: repo 200/200 (was 197); watcher 22/24 → 22/22 (2 moved, not lost).

## Round 19 — audit round 4: delivery-safety + honest pagination (2026-10-04, dc55bb2)

Fourteen findings (A1–A8 watcher-side, B1–B6 repo/app-side). Trigger: the
ask-decision misroute incident — a decision run for Joe's merge-YOLO wandered
into the wrong repo's session by pattern-matching a reflog, surfaced by Tyler
("for some reason this ended up in shim and not you"). The audit widened from
that one defect to every delivery/honesty surface in the loop.

Watcher side (~/tools, per-machine — mirror features into watch.mjs, the
repo copy is the spec):
- A1 (the big one): enqueue's full-queue shift-drop could evict a
  DELIVERY-class job (ask decision, auto-approval, phone prompt) while its
  registry stamp said "delivered" — silently lost decisions. New pure module
  watch-admit.mjs: PROTECTED_KINDS always admit (may exceed MAX_QUEUE),
  everything else is REFUSED at the cap, never dropped. 4 retired W3
  refuse-before-claim guards (full queues can no longer defer delivery).
  5 tests in watch-admit.test.mjs.
- A2: decideAsk releases its claim when the registry write fails (a crashed
  writer used to freeze the ask pending forever); stale-claim reaper >5min
  in sweepExpiredAsks unfreezes the wedge class.
- A3: countdown sweep re-reads the registry after the fetch gap (a decision
  landing mid-flight owned the card — no stale "Xm left" over a decided
  ask); legacy cards edit CONTENT ONLY (components round-trip through the
  API for no gain and could kill the button row mid-fuse); click-race loser
  with live buttons repairs the card terminal via its free update channel.
- A4: messageCreate cursor advance bumps pool activity — the drift guard's
  idle-exit could land between cursor write and enqueue, orphaning the
  trigger on a self-revive.
- A5: enqueueAutoApproval stamps BEFORE enqueue (claim-first): a crash
  between enqueue and stamp left the retry scan double-delivering.
- A6: /machine's watcher-busy probe accused a busy watcher of being down
  ("sweep down?") — now "deferred — run queue full" when the state file
  shows real activity.
- A7: sweepTerminalAsks GCs orphan .claim/.tmp siblings (registry entries
  removed but claim files stranded = reaper false-positives later).
- A8 (the incident itself): VENUE LAW in the spawn template — ask-decision
  deliveries never relay to project sessions, never compose work orders for
  other sessions' repos; clankerchat/botlink bilateral matters name the
  gateway session in the receipt. Mirrored in the orchestrator CLAUDE.md
  routing rules. Verified failure: the misrouted merge-go (muuifi9v card,
  ~23:36Z) reached the shim session as a "work order" and was correctly
  REFUSED by its untrusted-input law — the fix is routing, not trust.

Repo/app side (this commit, dc55bb2):
- B4: companion signedFetch fully sequential. Counters burn AT VERIFY
  server-side, so two in-flight requests could arrive inverted → the second
  one replays a burned counter → 403 replay refusals. counterChain promise
  gate; marker literal "seq-burn-v13" (doctor.ts + App.tsx comment).
- B5: double-scan enroll race (QR re-scan while first enroll in flight
  minted two enrollments) — enrollingRef guard.
- B6: historyWindow composite cursor (before, beforeId): strict < on
  createdAt alone stranded same-ms twins at page boundaries; with beforeId,
  createdAt < before || (=== && promptId < beforeId). /prompts?before_id=
  param plumbed; App loadOlder sends the oldest row's (ms, id).
- B1: /prompts `more` computed from the REGISTRY count, not the page size —
  the default branch said `more: true` when nothing remained.
- B2: SENT render dedupes stale history copies against fresh prompts (was:
  both rows shown until the next fetch).
- B3: four sub-fetch failures now setError — silently swallowed before.
- Tests: 207/207 (was 201): stale-claim reaper, GC siblings, twin cursor
  both directions, honest more, machine-busy wording, fixture updates.

Incident record (same round, same commit window): during the A1 work I
clobbered ~/tools/watch-history.mjs (pre-existing module) with the new
admit-policy content — the Write said "updated" and I missed that it was an
overwrite of a live module the watcher imports. Watcher crash-looped ~7.5
min (43 restarts) until restored from .bak + the policy relocated to a NEW
file (watch-admit.mjs). Recovery proof: journal counter 38→43 SyntaxErrors,
then "watching for @fast-clank" at 00:51:30Z with NRestarts frozen. Lesson
recorded in memory: look before overwriting; a Write to an existing path is
a clobber. Boot replay covered the outage window (no lost triggers).

Merge authority: Joe's YOLO (muuifi9v, API-verified 00:27:27Z) covered the
16-commit held set through df5bf50 + standing auto-merge until
2026-10-05T14:00Z (code/tests/docs only, cited-SHA law unchanged). Round 19
(dc55bb2) rides that standing authority. Lazy-consensus asks are REVOKED
permanently (Tyler: "SILENCE COUNTS AS A YES… dont let that happen again")
— every ask fails closed; expiry = expire, never approve.

## Round 20 — lazy-consensus revocation made mechanical (2026-10-05, ea26425)

Trigger: owner phone prompt "Continue working on feature improvements"
(pmtbehcgaao). The revocation was behavioral only — the lib still accepted
on_expiry:"approve" and enforcement depended on every spawn remembering the
law. Laws on this stack converge to code (identity law → tripwires,
mass-mention law → findMassMentions, quarantine → watcher gates); this was
the last owner law enforced purely by behavior.

- src/asks.ts: `lazyConsensusRefused()` + `LAZY_CONSENSUS_REFUSAL`, env-gated
  CLANKER_NO_LAZY_CONSENSUS=1 (default off — the shared lib stays
  upstream-shaped for peers who haven't revoked; the peer was already
  recommended to mirror the revocation). createPendingAsk refuses at the
  chokepoint BEFORE mkdir/write: every minting surface (MCP ask tool, daemon
  paths, scripts) funnels through it.
- src/index.ts: the MCP ask tool refuses BEFORE channel.send. Ordering
  matters: the handler posts the card first, then mints the registry entry —
  a lib-only refusal would orphan a live "silence counts as yes" card with
  no sweep machinery behind it (clicks hit "ask not found", buttons die only
  on first tap). The pre-send check is the layer that makes the orphan
  impossible; the chokepoint is the layer that covers every other surface.
  on_expiry describe names the refusal so spawns compose fail-closed the
  first time.
- Machine wiring (not in repo): orchestrator .mcp.json env
  CLANKER_NO_LAZY_CONSENSUS=1 (backup .bak-20261005-lazy) — read per-spawn,
  live with zero restarts. Orchestrator CLAUDE.md lazy-consensus section
  rewritten to REVOKED + mechanically enforced.
- Grandfathering: zero pending lazy asks in the live registry at deploy.
- Tests: +2 (refusal precedes side effects incl. directory creation;
  fail-closed default unaffected; env-unset upstream mint preserved).
  209/209.

Peer note: default-off on merge — zero behavior change their side unless
they set the env, which the standing mirror recommendation already covers.

## Round 21 — owner architecture triage: message cache + read fast-path + search (2026-10-05)

Trigger: Tyler's phone-prompted improvement list (5 items, two chunks).
Every item got a file:line-grounded verdict; the one that cleared the bar
shipped this round.

- ITEM 1 (zero-latency reads via local cache + rich search) — WORTH
  BUILDING, SHIPPED: `src/msgcache.ts` — SQLite (node:sqlite DatabaseSync,
  WAL, busy_timeout 2000) at `<spool>/msgcache.db`. Fed by the watcher's
  gateway feed (single chokepoint inside the cursor block, post-quarantine:
  own posts, bot posts, and webhooks all cached — exactly what REST read
  returns) + `messageUpdate`/`messageDelete` maintenance listeners (ask
  cards edit constantly) + the MCP process's own send/edit/delete surfaces
  (read-after-write consistency; attachment sends defer to the watcher's
  complete copy since the REST response lacks CDN urls). FAIL-QUIET by
  design: openMsgCache → null on machines without node:sqlite (loaded via
  createRequire so a missing builtin throws catchably instead of breaking
  the ESM graph) — cache is an optimization, never a dependency.
  - read fast-path (index.ts): when `covers()` PROVABLY covers the query,
    serve from disk (`source:"cache"`, consumer-identical shape incl.
    attachments + sender parsing); any doubt → REST (`source:"api"`).
    HONEST COVERAGE: contiguous start = MIN(cached id) per channel — the
    live probe caught the original design's lie (no floor row ≠ full
    history: pre-cursor channels start mid-history, and an old `after`
    would have been "covered" and served a partial slice). Gap floors from
    SATURATED boot-replay windows only ever RAISE that start; prune (14d,
    at boot) walks it forward naturally.
  - NEW `search` MCP tool: q/channel_id?/hours(≤336)/limit — cache-only,
    case-insensitive substring with LIKE metachar escaping, newest-first
    excerpts, quarantine-checked channel ids, honest "cache unavailable"
    answer on sqlite-less machines. Costs zero Discord rate-limit budget.
  - SNOWFLAKE LAW: ids are TEXT keys but every SQL comparison/order casts
    to INTEGER — lexicographic snowflake ordering flips across digit
    lengths ("999…" > "1000…"). MIN comes back CAST to TEXT because raw
    INTEGER snowflakes exceed 2^53 as JS numbers. JS-side floor math uses
    BigInt.
  - 12 tests (numeric cross-length ordering, covers honesty incl. the
    mid-history trap, LIKE escaping, persistence, caps). 221/221.
- ITEM 2 (>2MB artifacts via SSH lane + artifact:// URIs) — EXISTS /
  NOT-A-FIT: bot_file (49e97cf) already ships ≤2MB files sha256-verified
  over the lane; repo content crosses via git. The URI-indirection delta
  would munge receiver-visible provenance (auto-swapping URIs into local
  paths rewrites what the receiving agent believes it read) for a need
  that hasn't materialized — no artifact has ever hit the cap.
- ITEM 3 (reaction-based claim_task locks) — NOT-A-FIT for this topology:
  nothing polls the thread (the tag-watcher spawns once per trigger;
  Tyler's "agents polling" premise is the polling-era shape). Collision
  avoidance here = the routing law (one lane per session), O_EXCL claim
  files for in-machine races, and lane briefs for bilateral division.
  Trigger condition for revisiting: if bilateral duplicate rounds appear
  (both machines shipping the same backlog item), a 🔒 reaction lock is
  the right shape and cheap — react tool exists, add the emoji to the
  whitelist + render reaction state in spawn context.
- ITEM 4 (Rust-native daemon) — NOT-NOW, bilateral decision if ever:
  measured, the claimed bottleneck isn't one (three node services total
  ~112MB RSS on this box; no CPU profile shows runtime overhead; no
  persistent SSH tunnels — connections are per-verb). The ed25519 +
  hash-chain + botlink surface is exactly the deepest-tested code (221
  tests); a rewrite re-walks all of it, twice, across two OSes (peer =
  Windows 11). Revisit trigger: a constrained deployment target (router/
  Pi-class) where 100MB matters.
- ITEM 5 (prompt-injection firewall in the read pipeline) — SPLIT VERDICT:
  the semantic filter is not-a-fit (an LLM call per poll violates the
  prompt-count law; heuristic stripping of imperative/code content would
  mangle our OWN posts — asks and instructions are legitimately imperative
  text we must read verbatim). The mechanical layer already exists at the
  trigger layer (UNTRUSTED_DATA markers, identity law, webhook/spoof
  tripwires since 5ff2d74) and now ALSO at the read surface: the tool
  description carries the untrusted-data law, and search results state it
  too. Defense stays framing + tripwires, never content rewriting.
- Deploy: watcher restarted on new dist 03:02Z (feed live, WAL active,
  boot-replay seeded through the handler); production-path MCP probe
  verified search registration + the honest REST fallback (`source:"api"`
  while the cache is young — the fallback IS the proof covers() doesn't
  lie). Fast-path activates per-channel as history accumulates.

## Round 22 — adversarial audit of the msgcache surface (2026-10-05)

Round 21 shipped a cache; round 22 tried to break it. A background audit
run (threat model: wrong-data-under-covers, quarantine breach, cache
poisoning, resource exhaustion, send-path placement) returned 10 findings
across msgcache.ts / index.ts / watch.mjs. Six fixed (318f08e), four LOW
accepted+documented. Tests 221 → 224, all green; watcher drift-revived on
the new dist + new watch.mjs at 03:43Z (first boot immediately proved F6:
cursors seeded for all three ARCHIVED threads the old enumeration missed).

Fixed (commit 318f08e, pushed fork main):
- F1 HIGH own-record poisoning — an MCP send into a never-covered channel
  planted a lone row → covers() claimed contiguous-from-MIN → "covered"
  reads served only our own posts, hiding human replies up to 14d. Fix:
  established(channelId) invariant; the send path records own posts only
  where the feed already established coverage (rows held or boot-seed
  floor). Peer note: mirror this gate when porting the gateway feed.
- F2 HIGH permanent replay hole — failed boot-replay fetch (429/net/perm)
  left a gap the advancing cursor papered over. Fix: snowflakeNow()
  honesty floor ((now−2015epoch)<<22) on fetch failure; floors only need
  to be a lower bound on future ids.
- F3 HIGH search scoping — search bypassed the project-mode allowlist
  (assertNotBlocked ran only for explicit channel_id) AND the blocklist
  env was wired into ZERO live instance configs (the watcher's write-gate
  was the only mechanical barrier). Fix: explicit channel → blocked+thread
  asserts; unpinned search on locked instance scoped via channelIds
  IN-clause; empty allowlist refuses every target. Deployment side:
  CLANKER_BLOCKLIST_FILE wired into all 5 live MCP configs (2× .mcp.json,
  3× ~/.claude.json project entries) against the watcher's existing
  mtime-cached blocklist file — one source of truth.
- F4 MED messageDeleteBulk listener (bulk purges used to keep rows
  cached/served/searched up to 14d).
- F5 MED blocklist hygiene — boot purge of blocked-after-caching venues
  (blocklistIds() + purgeChannel()); F5c divergence (covered read returns
  fewer rows than REST when per-message ids are quarantined) documented
  DELIBERATE — silence law wins over byte-parity.
- F6 MED archived threads — fetchArchived unioned into boot scope; on
  enumeration failure, cursor-holding threads missing from the active set
  get snowflakeNow() floors.

Accepted LOW (documented, not fixed):
- F7 covers()/list() non-atomic under a concurrent prune — worst case one
  REST fallback or one short read; self-healing next call.
- F8 openMsgCache caches a transient open failure for process lifetime —
  cache-less until next restart; REST keeps serving.
- F9 MCP own-record timestamp drift until the watcher re-records the same
  id (INSERT OR REPLACE) — bounded by feed latency, display-only field.
- F10 caps (4000/10) unreachable vs Discord's own 2000/10 — belt/suspenders.

Audit's SOUND list (no action): snowflake CAST ordering everywhere,
covers() honesty core, list() REST semantics, fail-quiet end-to-end, send
own-record placement, watcher write-gate placement (forbiddenId BEFORE
cacheRecord, ahead of all skip gates), floor honesty at boot, WAL +
busy_timeout, no poisoning path past the new gate, resource bounded,
deploy parity.

## Round 23 — prompt-budget meter + the remember-plugin storm (2026-10-05)

Owner report: "something is spamming too many prompts" on the new
prompt-count plan (z.ai legacy v1 max, ~1600 prompts / 5h window, no
weekly cap; provider-reported reset anchor 10:10 MT). Measured before
theorizing — transcript scan of the 5h window: 570 prompts, **422 (74%)
from the `/tmp` transcript project**: ~105 identical 4-turn headless
sessions firing every ~2 minutes all night with zero human input.

Root cause: the official `remember` plugin (0.7.2). Its SessionStart hook
launches save-session.sh --force (recovery) and background consolidation;
both spawn `claude --model haiku -p` summarizers with **cwd=/tmp**
(pipeline/haiku.py). Headless sessions fire SessionStart hooks too — each
summarizer's own start spawned the next, rate-limited only by the plugin's
120s save cooldown. Self-perpetuating since at least Oct 3 (~185
session-starts/day logged in /tmp/.remember).

Kill (22:17 MT): plugin config at
`~/.claude/plugins/cache/claude-plugins-official/remember/0.7.2/config.json`
— `features.recovery:"false"`, `features.ndc_compression:"false"` (STRING
false, not boolean: the plugin's jq-based config helper does
`key // empty`, and jq `//` treats boolean false as absent — a boolean
false can never disable a feature), plus `min_human_messages:99999` /
`delta_lines_trigger:99999999` to dead-end the PostToolUse save path.
Memory INJECTION at session start still works (free, file cats); automatic
summarization is off (2,957 summarized sessions already on disk — the
.remember history stands). Verified: last /tmp session-start 22:18:00 (an
in-flight spawn), zero since. NOTE: the config lives in the plugin cache —
a plugin UPDATE resets it and the storm returns; the meter's spam alarm is
the backstop.

Shipped this round (commit next):
- `src/promptmeter.ts` — pure zero-prompt meter: streams
  ~/.claude/projects/**\/*.jsonl (mtime-filtered; 600MB+ files exist, so
  readline not readFileSync), counts real user turns in the 5h window
  (tool_result and sidechain excluded, sidechain reported separately),
  per-project rows, headless-spawn pattern detection (>=5 sessions, avg
  <=6 turns), hot flag at CLANKER_PROMPT_GATE_PCT (default 0.85 of
  CLANKER_PROMPT_CAP, default 1600).
- `slash.ts` — optional `promptsLine` on the status card (renders only
  after the first sweep; absent reads "not measured", never a fake zero).
  Additive/optional: the peer daemon's card renders unchanged until they
  adopt the meter.
- watch.mjs (deploy side, ~/tools) — 10-min sweep: publishes
  `prompt_window` to watcher-state.json (phone card), storm alarm to the
  journal (deduped by top suspect), one phone notice per hot episode, and
  the only safe shave: when HOT, the vision pre-pass (an EXTRA spawn per
  image trigger) is skipped — runs proceed text-only. Deliberately NO
  enqueue drop-gate: every class is either human-triggered or protected
  delivery (round 19 A1 law); a drop would trade bilateral reliability
  for budget. Healing = detection + source-kill + loop backoff, not drops.
- `tests/promptmeter.test.mjs` — 5 tests (window/exclusion filters, mtime
  skip, hot+line, spam suspect, degrade-to-zero). 229/229.

Loop side (this session): the machine-watch /loop reads prompt_window
each tick and backs off its own cadence when hot — the backstop never
adds load to a window it's warning about.

Provider-accounting caveat (honest): we count PRIMARY user turns as the
billing proxy. Whether z.ai bills sidechain/subagent turns, tool-call
rounds within a turn, or token-limit auto-resumes separately is
UNVERIFIED — top of the Gemini deep-research list handed to the owner.

## Round 24 planning — Gemini deep-research verdicts (2026-10-05)

Owner ran the deep-research prompt; report digested against tonight's
measurements. Verdicts (full reasoning in session; preserved for the next
compaction):

ADOPTED (already true or cheap):
- Priority 5 (official-client fingerprint): ALREADY COMPLIANT — every model
  call originates from the compiled claude binary; no daemon/SDK API traffic
  (companion/metro/watcher never touch the API endpoint).
- Priority 3 (no autonomous subagents on the spawn surface): ALREADY TRUE —
  orchestrator deny list includes Task + Agent; daemon-side spawns are the
  vision pre-pass (one per image BATCH, hot-skipped).
- Meter accuracy: compaction entries ARE type:user in transcripts
  (isCompactSummary:true) → currently counted as turns. Split into a separate
  `compact` count (sidechain-style: reported, not gated) so dashboard
  reconciliation (Experiment A) can attribute exactly. Round-24 item.
- Meter addition: next-replenishment projection (age-out time of oldest
  in-window turn) + peak-window flag (06:00–10:00 UTC, per report unverified)
  on the card. Additive keys only, as always.

EXPERIMENTS (≤10 prompts, owner reads dashboard, run OFF-peak >10:00Z):
- A (matters): 1 turn spawning 3 one-echo subagents → dashboard delta 1 vs 4
  settles sidechain billing. Also reconcile compact: 1 plain turn after a
  compaction vs delta.
- B (cheap, expected yes): daemon socket-inject "acknowledge" → delta 1
  confirms relays bill like human input (already our operating assumption).
- C (skip): cache TTL is latency-only on a prompt-count plan; not worth
  prompts.

REJECTED (with reasons — do not re-litigate without new evidence):
- Priority 1 (persistent router session replacing -p spawns): report optimizes
  prompt economics and ignores our threat model — per-run sandboxing, canaries,
  UNTRUSTED_DATA framing, 10-min timeout, clean-env are per-run by design.
  Post-storm legit burn ≈29/hr vs 1600/5h — no economics emergency. The
  grouping benefit (1 prompt = 15-20 tool loops, X-Claude-Code-Session-Id)
  ALREADY applies per spawned run. Coalescing/fast-paths killed the low-value
  spawn classes; keep the spawner.
- Priority 2 (leaky-bucket defer at P_max=530): round-19 A1 law — delivery
  classes never drop; a defer queue is complexity for a 429 we've never hit.
  Visibility first (replenishment projection above); add defer ONLY if a real
  429 is observed (watcher would log exit + salvage line).
- CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS / CLAUDE_AGENT_SDK_DISABLE_*: env names
  unverified — do not set invented vars. Revisit only with docs.

OPEN (owner dashboard checks, zero prompts):
- Time-of-day multiplier (3x peak / 2x off-peak claim): compare meter count
  vs dashboard delta over a fixed hour. If ratio >1, wire real multipliers
  into cap model. Affects BOTH machines (shared plan).
- Rolling-TTL vs fixed 10:10 anchor: if dashboard "resets at" time slides
  later as usage continues → rolling TTL confirmed (meter already models
  sliding; no code change either way).

Calibration PRELIMINARY (first paired rows, 2026-10-05 05:02Z→05:12Z):
- 13%→17% (+4pts/10min) while LOCAL turns FELL 459→450: quota is not
  prompt-denominated — token-denominated confirmed by behavior, independent
  of the API's TOKENS_LIMIT label.
- 24h totals byte-identical across two polls despite the window sliding →
  model-usage endpoint serves an hourly-bucketed snapshot; sub-hour deltas
  are meaningless. quota/limit % is the only near-real-time signal.
- Cap estimate: 2.38B tok/24h ≈ 16.5M/10min burn; +4%/10min observed ⇒ 5h
  cap ≈ ~410M tokens (one interval, wide error bars — refine as rows
  accumulate).
- IMPLICATION (owner-gated, not wired): turn-count gating (PROMPT_CAP=1600)
  mis-models the real constraint in BOTH directions — long-context sessions
  eat quota far faster per turn than count suggests, tiny headless turns far
  slower. Candidate successor once rows confirm: gate on provider pct
  directly (provider_quota.pct, already polled) — behavior change, needs
  owner go + both machines.
- Row 1 (04:57Z) nulls = boot race + pre-fix TOKENS_LIMIT parse, both
  already fixed; rows 2+ clean.

Peer note: findings generalize to their machine (shared plan). Brief them
with round 24 once experiments land — one consolidated cite, not a relay of
the whole report.
