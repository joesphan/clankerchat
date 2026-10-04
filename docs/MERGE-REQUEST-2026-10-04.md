# Merge request — round 3 + notices lane (for Joe, whenever you're around)

Tyler's directive 2026-10-04: keep improving past review gates and bank the
ask. Nothing here is blocked on this merge — all surfaces are file-compatible
either way — but the fork tip carries one commit origin doesn't have yet.

**Merge `tjbtiller/clankerchat` main @ `65493fc`** (the only non-merge commit
in it is `767afb8`; everything older you already merged, including your
`c2a7ebe` YOLO verb which we merged back, rebuilt, 185/185, restarted —
both directions clean).

## What's in `767afb8`

1. **S-tier #4 — interaction journal** (`src/journal.ts`): hash-chained
   append-only JSONL at `<spool>/interaction-journal.jsonl` recording every
   slash invocation and ask-button click the daemon sees, refusals included
   (who/what/verdict, ids only). `readJournalTail` fails closed so `/machine`
   never breaks on tamper; `journalStats` surfaces "N refused interactions
   last 24h" on the phone card. `handleSlashCommand` now returns outcome
   codes and every button outcome journals through `journalInteraction`.
   No discord.js imports — lifts to your machine verbatim.
2. **S-tier #5 — guild audit watch** (`src/audit.ts` + daemon sweep): pure
   classifier over `fetchAuditLogs`, scoped to our blast radius (bot id +
   watched venues). critical (our posts deleted / watched channel deleted /
   webhook created in a watched channel / bot kicked or re-rolled) → ONE
   human-eyes post via the tripwired sendToThread; notify-class (channel
   modify, permission overwrites, webhook update/delete) → journal + phone
   card via `watcher-state.json` `audit_alerts` (ring-bounded 5 / 24h TTL).
   Resume cursor `state.auditCursor` in daemon.state.json; View Audit Log
   403 → one-time degrade + card alert, never spam. Sweeps 5min + boot.
3. **Phone-prompt history navigation**: `GET /prompts?before=<createdAt ms>`
   pages strictly-older records (`historyWindow`, `?limit=` clamp 1-50,
   invalid cursor → 400 — never a silent fall-through to the default list);
   app "Load older" walks frozen history pages deduped against the live
   window, rows tap-to-expand (full text/excerpt/stamps).
4. **Notices lane** (`src/notices.ts` + `dist/notice.js`, round 8): the
   machine→phone free-text report lane per Tyler's "let me know not in
   discord but just on the phone". Writers are LOCAL processes (CLI/
   sessions/daemon) on `<spool>/notices.json` — bounded 50, monotonic
   `seq` ordering (same-ms bursts keep insertion order; lesson: sorting on
   random ids reorders bursts), atomic writes, leak-scanner REFUSES
   secret-shaped text at append. Phone surface is read+ack only:
   `GET /notices` (newest window + whole-registry unacked count),
   `POST /notices/:id/ack`, `POST /notices/ack-all`. App: NOTICES card
   (unread badge, warn severity, dismiss one/all) + arrival banner once
   per notice per app session while unacked. The phone can never create
   machine state on this lane.
5. **`docs/context/topics/antigravity-cli.md`**: official Antigravity CLI
   headless/permissions docs banked (JSON envelope, `--print-timeout`,
   `read_url(domain)` rule syntax incl. subdomain semantics and the
   deny>ask>allow precedence). Our `gemini-ask.mjs` runner upgraded to
   `--output-format json` + `--print-timeout 3m` with the external SIGKILL
   demoted to a 210s backstop — worth copying if you run `agy` headless.

## Verification on merge

- `npm ci && npm run build && npm test` → **185/185** (three new files:
  `tests/journal.test.mjs`, `tests/audit.test.mjs`, `tests/notices.test.mjs`
  + new route blocks in `tests/companion.test.mjs`).
- Restart server-side: watcher (daemon journals + audit sweep),
  companion (new routes), botlink (module graph). We run all three as
  user services: `clankerchat-watch` / `clankerchat-companion` /
  `clankerchat-botlink`.
- Phone app: rebuild in Expo — new NOTICES card + Load older button.
- First live notice already in the spool (Tyler's phone shows the round
  report on next app open).
