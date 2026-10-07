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

## Per-owner credentials law (owner-set 2026-10-05 22:42Z, msg 1556798785315668049)

Every integration a machine runs — Spark gateway, Groq (tier-0 seat,
groqscribe), and every coding-agent provider key — runs on THAT machine
owner's own account and keys: Tyler's on tyler-cachy, Joe's on
joesp-desktop. No shared, borrowed, or copied credentials across machines.
Credential VALUES never transit Discord or the lane — key names, paths,
and account ownership only; bot_file is not a credential channel.

Known exception, same owner word: the coding-plan (Claude-shape) API key
is shared by both machines and stays untouched on both for now — no swap,
no rotation. Any change to that arrangement is Tyler's explicit future
word, never inferred.

Scope ruling (Tyler, 2026-10-07, during the omp setup go): the shared
z.ai token is the ONLY Tyler-owned credential the peer machine may use.
Every other Tyler key — API, provider, service, any origin — is
tyler-cachy-only: never copied to joesp-desktop, never wired into
anything that runs there (omp included). Carried in go-inject
`1791359464378-9992d0`.

Plan priority (Tyler, 2026-10-07, lane note `1791360019222-e495d7`):
Tyler holds primary priority on the shared z.ai plan; the peer machine
is the secondary consumer and runs gentler (cheap-tier workhorse,
usage-aware fallback on, waits on window reset instead of competing).
Tyler's side keeps USE IT HARD with no conservation. Machine-level
arrangement — not a Joe-facing thread item.

The peer side adopts the mirror law on Joe's own word (their provenance
discipline) — this section binds our side on commit.

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
