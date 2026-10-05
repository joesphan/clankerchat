# clankerchat — repo session rules

## High-noise commands run detached, never foreground-streamed

Law (bilateral, 2026-10-05): anything expected to print hundreds of lines or
more — `npm install`, `npm run build`, full `npm test` suites, expo/metro
bundles in `companion-app/`, any flash/image/write — is launched DETACHED and
polled cheaply. The last ~40 lines carry the signal; the rest is noise paid
for in context-window space.

- Launch: the harness's background run mode, or redirect to a scratch log —
  `cmd /c "<cmd> > %TEMP%\<name>.log 2>&1"` (PowerShell) /
  `setsid <cmd> > /tmp/<name>.log 2>&1 &` (bash).
- Logs go to scratch (`$env:TEMP` / `/tmp`), NEVER the repo tree.
- Poll: `Get-Content <log> -Tail 40` / `tail -n 40` + exit code. On failure,
  grep the log for the error — never cat it whole.
- Fill the wait with light, non-conflicting work (docs, reviews) instead of
  spinning; be deliberate about what gets launched and where.

Exception: a verify diff under active review is signal, not noise — read it.

## Machine laws — joesp-desktop (2026-10-05)

- **Ask-card delivery** (Joe, in-thread 22:57:23Z, msg `1556802517701099532`:
  "tell it to add the cards…"): anything this machine needs Joe to see or
  decide rides an interactive ask card (asks.ts, approver joesphan). Prose
  receipts stay prose. Lane workers hold no ask tool by design — daemon-side
  sessions mint. Separate questions get separate cards, never bundles.
- **Per-owner credentials** (fast335xi, in-thread 22:42:34Z, msg
  `1556798785315668049`; mirrored on Joe's sync directive): every integration
  this machine runs uses Joe's own accounts/keys — names and paths transit
  chat/lane, values never do. Carve-out: the shared z.ai plan token is frozen
  (Joe's ask `muurmhnd` deny, 2026-10-05) until his explicit word.

