# Companion app — allow/deny pairing from the owner's phone (v1)

Owner ask (2026-10-03, in-session answer to the platform question): the pairing
companion app **"needs to be able to allow or deny the connection in the app
and still be secure and work automatically and seamlessly."** Platform choice
was delegated and taken: one Expo codebase, Android + iOS through the Expo Go
runtime (no store, no signing). **Merge onto main stays Joe-gated, exactly like
the pairing PR this extends** (branch `companion-app`, based on
`one-tap-pairing-design`).

## The ask, precisely

The one-tap pairing ceremony (docs/one-tap-pairing.md) ends with each owner at
a terminal running `pair --confirm` and typing the peer's 8 SAS characters.
This doc moves that final gesture — and only that gesture — onto the owner's
phone, with no new ceremony steps added anywhere else:

- After a pairing exchange completes, the attempt **appears on the enrolled
  phone automatically** (service runs alongside the lane; the app polls while
  foregrounded).
- The owner compares SAS values exactly as before — each owner reads THEIR OWN
  machine's value (now on their own phone's screen) and the two owners
  exchange values as humans, in the thread or aloud. **The app displays the
  SAS; it never transmits it** (the agents-never-relay-SAS law extends to
  apps — no copy button, no share sheet, no auto-post).
- Allow = the phone sends a signed request; the machine runs the SAME
  journaled two-phase commit the CLI runs. Deny = state cleared, nothing
  written. Declining/TTL behave identically to the terminal flow.
- The terminal `pair --confirm` path stays exactly as it is. Both doors lead
  into the same commit function; either satisfies the other's single-use
  semantics (first confirm wins, state is cleared).

## Non-goals

- **Not** arming pairings from the phone (phase 2 candidate; `--arm` stays a
  terminal action, so nothing can START a key exchange remotely).
- **Not** putting machine keys on the phone. The only secret the phone ever
  holds is its own per-machine companion keypair, whose power is scoped to
  view/allow/deny on THAT machine (see threat model).
- **Not** a chat client, lane client, or anything touching the main
  status/inject listener or the ephemeral pairing listener. Companion traffic
  is a third, separate surface on `main port + 2`.
- **Not** replacing human SAS comparison. The phone is a display + a gesture,
  not an oracle.

## Threat model (addendum to one-tap-pairing.md)

New attacker classes and what they get:

| Attacker | Can | Must NOT get |
|---|---|---|
| LAN observer (read) | see companion traffic: fingerprints, SAS, peer names | anything secret (no private material, no machine keys ever cross) |
| LAN attacker (read/write) | forge/modify/replay requests | a forged allow/deny — every request is Ed25519-signed by a phone key the machine pinned at enrollment |
| Phone thief | hold one enrolled phone's key (OS secure storage) | a silent allow — every allow still requires typing the PEER's 8 SAS characters, and a stolen key is revocable by deleting one pin file |
| Thread attacker (unchanged) | equivocate posted values | defeat the check that each owner reads their OWN machine's value — now rendered on their own phone, whose channel is the signed companion lane |

**Honest boundary, extended:** the terminal confirm's TTY was intent-gathering,
not human-presence proof; the phone's unlock + typed-SAS gesture is the same
class of signal. Enrollment binds possession of the phone channel to **physical
access to the machine's display**: the QR is printed on the terminal, carries a
10-minute single-use token, and the human eyeballs the machine's hostkey
fingerprint against what `keygen` printed. A stolen enrolled phone key is
strictly weaker than local code exec (which already owns `authorized_keys`):
it can view pairing attempts and — only with the correct typed SAS for a live
attempt — allow one. It cannot read files, inject, reach the lane, or arm.

## Enrollment (once per machine ↔ phone)

```
npm run botlink -- companion --enroll
```

Prints (terminal + QR via qrcode-terminal) a JSON payload:

```json
{ "v": 1, "kind": "clanker-companion-enroll",
  "host": "192.168.1.42", "port": 47423,
  "fp": "SHA256:…",            // THIS machine's hostkey fingerprint
  "tkn": "<32B hex>" }         // single-use, 10-minute TTL
```

Phone scans, **generates its own Ed25519 keypair locally**, displays `fp` for
the human to eyeball-match against the machine, then posts
`{ "token": …, "phonePub": … }` to `/enroll`. The machine consumes the token
once and pins `companion-keys/<fp-of-phonePub>.pub`. No secret crossed in
either direction; revocation is deleting that one file. The QR should be
treated as sensitive-for-10-minutes and the terminal output cleared or
ignored afterward (the token dies at first use or TTL regardless).

## Request authentication

Every non-enroll request:

- headers: `X-Companion-Id` (fingerprint of the phone key), `X-Counter`
  (per-phone monotonic integer), `X-Sig` (base64 Ed25519)
- signed message: `len-delimited ("clanker-companion-v1", method, path,
  sha256(body) hex, counter)` — same length-prefix habit as the pairing
  transcripts, so no field can bleed into another
- server: verifies the pin exists, the signature, and `counter > last` for
  that phone (last-seen counters persisted to `companion-keys/counters.json`;
  a rejected or crashed request's counter is never re-accepted)

Replay, tamper, and unknown-key all fail closed with 401/403 and no state
change. Bodies are size-capped (8 KB) and every string rendered back to the
app goes through the same `sanitizePeerText` discipline the tap block uses.

## API (default bind = the lane's bind host, port = main + 2)

| Route | Effect |
|---|---|
| `POST /enroll` `{token, phonePub}` | consume token, pin phone key |
| `GET /attempts` | render the live confirmable pairing state (tap-block fields + `attemptId` + `expiresAt`); `{}` when none |
| `POST /attempts/:id/allow` `{sas}` | typed peer SAS → same commit path as `pair --confirm` (mismatch = refuse, nothing written); audit event appended with `via=companion:<phoneFp>` |
| `POST /attempts/:id/deny` | clear pairing state, nothing written |
| `GET /asks` | pending asks, oldest first (round 4); no channel ids on the wire |
| `POST /asks/:id/approve` \| `/deny` | decide with provenance `companion:<phoneFp>`; 409 carries the standing decision when the click/expiry won the race |
| `POST /prompt` `{text, route?}` | write a prompt record (round 5); `route:"peer"` (multi-machine phase 1) routes it to the peer machine — unknown values or a lane-less machine are 400 at the door, never a silent expiry later |
| `GET /prompts` `?q=` `?before=` | lifecycle chips + `?q=` search (round 5 / 5.1) + `?before=<createdAt ms>` strictly-older history pages (round 7, `?limit=` 1-50; invalid cursor = 400, never a silent default-list fall-through); `more` says whether older rows exist |
| `GET /machine` | the machine card (round 6): pool, queues, lane verdict, peer recency, delivery-health + journal/audit alert lines |
| `GET /notices` `?limit=` | machine→phone reports (round 8): newest window in registry order + `unacked` over the WHOLE registry (the badge never lies when the window is all-read). Read lane only — writers are local processes, incl. the once-per-local-day `daily-digest` (round 9; the registry itself is the cursor — the newest daily-digest notice's day) |
| `POST /notices/:id/ack` | dismiss one (idempotent; 404 unknown) |
| `POST /notices/ack-all` | dismiss every unread notice, `{acked: N}` |

`attemptId` = sha256 of the pairing transcript — stable per exchange, so a
late/replayed allow for an already-consumed attempt cannot alias onto a new
one. If the companion listener's bind is loopback, `--enroll` prints a loud
warning (phones cannot reach it; pass `--bind` / set the env like the lane).

## App (Expo, one codebase, Expo Go runtime)

- **Enroll** — camera scans the QR (expo-camera), shows `fp` for the
  eyeball-match, generates + persists the keypair (expo-secure-store; seed
  from expo-crypto), POSTs enrollment. One machine list, one keypair per
  machine.
- **Attempts** — polls `GET /attempts` every 2 s while foregrounded; shows
  mode, peer name, both fingerprints, the SAS in large type, and the TTL
  countdown. No notifications in v1 (a push service would need an external
  relay — rejected: it would put pairing state on a third party AND becomes
  an agent relaying SAS).
- **Allow sheet** — types the peer's 8 characters (same normalization as the
  CLI), confirm gesture, sends the signed allow.
- **Deny** — one tap, signed.
- **Prompt + route toggle** (round 5 + multi-machine phase 1) — composer
  carries a "run on: this machine / peer machine" chip pair (cyan, visually
  distinct from the blue machine-select chips). Peer routing is per-send
  and resets to local after each prompt: deliberate asks route, casual
  ones stay home. A routed chip's status line names the runner and the
  30-min window; the answered preview arrives via the lane's outcome echo.
- **SENT + history navigation** (round 7) — newest 20 live, "Load older"
  walks strictly-older pages by createdAt cursor (frozen history pages,
  deduped against the live window); rows tap to expand full text, excerpt,
  and both stamps. FIND searches the whole registry by text or promptId.
- **NOTICES card** (round 8) — machine→phone reports with an unread badge,
  warn severity in red, per-notice + dismiss-all gestures. Arrival banner
  once per notice per app session while unacked (unacked = the owner never
  saw it — a reopen re-banners, a machine flip does not). "Show older
  notices" (round 9) widens the window to the whole 50-record registry when
  the default window is full; offered only then — a short list proves there
  is nothing older to reveal.
- **Haptics** — warning pattern on ask arrival, success/error on answer
  transitions, warning/light on notices, medium tap on decision commit.
  Fire-and-forget: devices without an engine no-op and the flow never
  gates on feedback.
- Dependencies: `@noble/ed25519` (pure-JS signatures), `expo-camera`,
  `expo-crypto`, `expo-secure-store`, `expo-haptics`. No native modules →
  runs in Expo Go on both platforms unchanged.

## Wiring + deployment

- `src/companion.ts` (library): enrollment store, signed-request
  verification, HTTP listener, allow/deny that REUSE `buildConfirmPlan` /
  `stageAndCommit` / SAS derivation from `src/pairing.ts` — the commit code
  is written once; the CLI and the app are two front-ends to it.
- `src/botlink-server.ts`: `companion --enroll` / `companion --serve`
  subcommands (serve = same signal handling as `serve`).
- "Automatically and seamlessly": the companion listener runs as a service
  next to the lane (systemd `--user` unit on Linux, LaunchDaemon on macOS);
  the ceremony from the owners' point of view becomes: arm + dial (as today),
  values appear on both phones, each owner types 8 characters into their own
  phone. No terminal step remains in the confirm.

## Standing-laws compliance

| Law | How it holds |
|---|---|
| Agents never relay SAS | The app is a display surface for the owner's OWN value only; no share/copy path, no notifications, no third-party push. |
| No secrets in transit | Enrollment token (one-time, short-TTL) is the only secret-shaped thing ever sent, and it goes phone→machine once. Phone private keys never leave the device. |
| Injects carry no authority | Companion surface cannot express injects; it reaches pairing state only. |
| Two verbs (main listener) | Untouched — companion is a third, separately-authenticated surface. |
| Fail closed | Sig mismatch, unknown key, stale counter, wrong `attemptId`, SAS mismatch, non-live state → refuse, no writes. |
| Owner-at-terminal for activation | Arming/keygen/rotation-start remain terminal actions; the app can only finish what a terminal already armed. |

## Tests (tests/companion.test.mjs, offline)

Enroll token single-use + TTL; forged/tampered signature → 401, nothing
written; replayed counter → 403; allow with wrong SAS → refuse + trust files
byte-identical; allow happy path (loopback keydirs) → pins written, backups
kept, audit event with `via=companion`, pairing state cleared, second allow
(single-use) refused; deny clears; wrong attemptId refused; attemptId
stability across restarts; sanitize of peer text in the attempts render;
loopback-bind warning logic.

## Decisions (with the owner, 2026-10-03)

1. Phone-tap authorized: Tyler, in-session — "allow or deny … in the app and
   still be secure and work automatically and seamlessly."
2. Platform: Expo + Expo Go (delegated choice; taken for the no-signing,
   one-codebase properties).
3. Arming from the phone: **deferred** (phase 2 candidate; needs its own
   review — it would make pairing startable without a terminal).
4. Push notifications: **rejected** for v1 (third-party relay = SAS leaves the
   owner's devices + an agent-shaped relay path).
5. Merge: **Joe's word**, like everything on this stack.
