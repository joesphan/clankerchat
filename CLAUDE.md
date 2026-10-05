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
