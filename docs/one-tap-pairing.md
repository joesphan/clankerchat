# One-tap pairing — replacing the voice-call key ceremony (v2)

Owner ask (2026-10-03): *"keep these bots in sync so botlink and clanker-to-
clanker connection is reliable — make it easier for us to authenticate, one
tap, without so much intervention."* Owner go for implementation given the
same day; **merge onto main remains gated on both owners' word in-thread.**

v2 incorporates the full Copilot review (PR #3) — every finding is
addressed inline and mapped in the "Review findings" table at the bottom.
Review decisions adopted with the owners' relay: **rotations keep the human
SAS comparison; rotation replaces the peer key line (with a grace
cutover); no auto-arm; the `peers/` multi-machine shape is deferred.**

## The problem

Today's first-pairing ceremony (BOTLINK.md, "Key exchange ceremony") is
correct but heavy:

1. Each machine `keygen`s and posts its **host-key fingerprint** + **bot-key
   public line** into the shared Discord thread.
2. Both **owners** get on a voice/video call and read the values to each
   other — because the thread can MITM what's posted in it.
3. Each owner hand-edits `CLANKER_BOTLINK_PEER_HOSTKEY` env and
   `botlink-keys/authorized_keys` on their machine.
4. Posts get deleted; daemons restart.

That is ~4 coordinated manual steps × 2 machines, plus scheduling a call —
for every first pairing AND every rotation. The friction is what the owner
wants gone. The property the ceremony buys — **MITM detection on key
material** — is kept, and strengthened (v1's naive SAS was vulnerable to an
offline birthday collision; see "SAS construction").

## Design in one paragraph

During pairing, each daemon derives an 8-character **SAS (Short
Authentication String)** from a hash over both machines' host and bot
public keys plus fresh per-side nonces, exchanged commit-before-reveal so
an attacker cannot grind a collision offline. The two owners compare the
two strings — over any channel where each owner reads the other owner's
**own human-posted** value (the Discord thread qualifies; see "SAS
comparison rules") — and each runs one local confirm. If any key was
substituted in transit, the two ends derive different SAS values, the
mismatch is visible, and neither owner confirms. First pairing collapses
from "read two 68-char fingerprints aloud on a call" to "do these 8
characters match? y". Rotations after the first pairing ride a
cryptographically-authenticated exchange (the OLD bot key signs it) and
still require the human SAS — two local confirms, no call.

## Non-goals

- **Not** changing the two-verb model (`status`, `inject`), the spool
  contract, inject trust semantics, or downstream payload handling.
  ALL pairing traffic — first pairing and rotation — lives on the
  ephemeral pairing listener; the main listener's verb surface is
  untouched (v1 violated this for rotations; reverted per review).
- **Not** Tailscale enrollment (separate trust domain, owner-run; no
  preauthkeys in any transit path, as today).
- **Not** Discord-side auth (per-machine tokens never cross machines).
- **Not** removing the human. The confirm is a local interactive command —
  see "Honest boundary" for what that does and does not prove.

## Threat model

The adversary can read/write anything in the shared Discord thread and can
MITM the network path between the two daemons. They must NOT be able to:

- make both owners confirm a pairing involving any key other than the two
  daemons' real keys,
- learn any secret (only public keys, fingerprints, nonces, and signatures
  cross),
- gain a verb beyond `pair-hello` on the ephemeral surface,
- have an inject or a peer message confirm on anyone's behalf.

**Honest boundary (narrowed per review):** an interactive TTY is intent-
gathering, not proof of human presence — local code execution can allocate
a pty and answer. This design's confirm defends against **remote and
lane-borne** automation (no verb, no inject, no lane message can reach it;
it only reads local pairing state). It does NOT defend against local
arbitrary code execution — but neither does anything else on that machine:
an attacker with local code exec can already write `authorized_keys`
directly, so no additional boundary exists to defend. We say this plainly
instead of claiming `isatty` is authorization.

## SAS construction (v2: commit-then-reveal, transcript-bound)

v1's `SAS = base32(H(static keys))` was deterministic. With static keys and
a deterministic transcript, a MITM who substitutes independent keys on
each leg can generate ~2²⁰ candidate pairs per side offline and collide in
the 40-bit truncation via birthday attack — the 2⁻⁴⁰ claim did not hold
(Copilot, review). The fix is the standard PAKE/ZRTP shape:

1. **Fresh per-arm randomness.** Each side generates a 256-bit ephemeral
   nonce for THIS pairing attempt only (in `pairing.json`, single-use).
2. **Commit before reveal.** The `pair-hello` exchange is two round trips:
   - round 1: each side sends `H(nonce ‖ "commit")` — the commitment —
     plus its public values;
   - round 2: each side reveals its nonce.
   An attacker must fix their substituted keys **before** seeing either
   victim nonce (they learn nonces only after their key choices are bound
   by the round-1 payloads they deliver), so collision-grinding becomes an
   online, per-attempt bet: each try succeeds with probability 2⁻⁴⁰ and
   fails visibly (SAS mismatch → human aborts). Attempt-rate is bounded by
   the pairing listener's single-use + TTL design: one try per arm.
3. **Transcript binding with roles and length delimitation.**

```
transcript = len("initiator")   ‖ "initiator"   ‖ len(A_host_fp) ‖ A_host_fp
           ‖ len(A_bot_fp)     ‖ A_bot_fp      ‖ len(A_nonce)   ‖ A_nonce
           ‖ len("responder")  ‖ "responder"  ‖ len(B_host_fp) ‖ B_host_fp
           ‖ len(B_bot_fp)     ‖ B_bot_fp      ‖ len(B_nonce)   ‖ B_nonce
SAS        = base32( SHA-256( transcript ) )[0..8]   // shown XXXX-XXXX
```

Length-prefixing kills substring-reordering ambiguities; role labels bind
who initiated (both sides know from the dial), preventing
reflection/cross-role transcript splicing. Nonces make each attempt's SAS
fresh, so revealed SAS values from earlier attempts are worthless to a
later one.

## Protocol

### Phase 1 — arm (each side, local)

```
npm run botlink -- pair --arm
```

- Uses the EXISTING active keys (`botlink-keys/host_key`, `bot_key`) for a
  first pairing; for a rotation, generates STAGED candidates
  `host_key.next` / `bot_key.next` (active keys never move until cutover —
  review finding on stranded lanes).
- Generates the fresh 256-bit nonce.
- Opens the **ephemeral pairing listener** on `main port + 1`, same bind
  interface: unauthenticated, exactly ONE verb (`pair-hello`), ONE
  completed exchange, 10-minute TTL, then closed and state wiped.
- Writes `botlink-keys/pairing.json` (0600): mode, role
  (initiator/responder, set at dial time), nonces, peer values once
  exchanged, candidate key paths for rotation. Contains nothing private
  beyond the nonce (which is published at reveal anyway).

### Phase 2 — exchange (public values, commit-then-reveal, validated)

```
npm run botlink -- pair --dial ts.example.ts.net:47422
```

Both sides exchange (round 1: commitments + values; round 2: reveals):

```
{ name, hostkey_fp, bot_pub, commit: H(nonce‖"commit"), prev_bot_pub? }   // round 1
{ nonce, sig? }                                                           // round 2
```

**Input validation (per review — the tap screen and log render these):**
every field is schema-checked before storage, display, or logging —
`name` ≤64 chars of `[A-Za-z0-9._-]`; `hostkey_fp` matches
`SHA256:[A-Za-z0-9+/=]{43}`; `bot_pub` parses as an OpenSSH public key via
the same `parseKey` used by `authorized_keys` loading; `commit`/`nonce`
are exactly 32 bytes hex. Anything else closes the exchange. All
peer-controlled text is control-character-stripped before it reaches a
terminal or log line (no ANSI/newline spoofing of the tap screen or the
audit log).

**Rotation authentication:** a side armed with `--rotate` authenticates its
NEW key by signing with its OLD bot private key (Ed25519), verified against
the `prev_bot_pub` line the signer claims — which must already be pinned in
the verifier's `authorized_keys` (checked at round 1, before anything is
stored). The signed message is a length-delimited, initiator-first transcript
distinct from the SAS transcript (prefixed `botlink-rotation-v1`, so a
signature can never be repurposed as an SAS input). Because the initiator
signs its round-2 reveal BEFORE the responder's nonce is revealed, each
signature puts the signer's REAL nonce in its own slot and the counterparty's
round-1 COMMITMENT in theirs — a construction both sides can rebuild on
receipt (using the commitment keeps the two directions symmetric). A
signature is demanded **only from the side that claimed a rotation**
(`prev_bot_pub` present in its round 1), never based on the verifier's own
mode — so single-side rotation (one machine rotates, the other re-pins as-is)
works in either direction. First pairing has no old key, so no signature —
that is exactly what the human SAS covers.

### Phase 3 — SAS display, comparison, the tap

Both sides derive the SAS identically (canonical initiator-first order;
both know who dialed). Each daemon displays LOCALLY: peer name, the peer's
two fingerprints IN FULL, both nonces' commitments, and the SAS — and
appends the same block to `daemon.log`/pairing log for audit.

**SAS comparison rules (per review — this is the load-bearing part):**

- Each owner reads their OWN daemon's local display and posts THEIR OWN
  SAS value into the thread as a human (or reads it aloud — any channel
  works as long as both owners see both values).
- **Agents never relay SAS values.** The equivocation attack (a
  read/write thread attacker showing each side only its own value) works
  only if an agent is the one reporting "the peer's SAS is X" — a human
  posting their own value in the shared thread cannot be per-viewer
  spoofed: Discord message identity is server-side, every viewer of the
  thread sees the same bytes. Agent-relayed SAS is therefore ignored by
  design; the doc and the confirm prompt say so.
- Both owners check: (a) the thread's copy of MY side's value matches my
  terminal (catches a lying channel), (b) the two values match each other
  (catches key substitution).

Then, locally on each machine:

```
npm run botlink -- pair --confirm
```

`--confirm` refuses unless stdin is a TTY (intent-gathering — see Honest
boundary), re-derives the SAS from local pairing state, shows the full
peer block once more, and asks for the peer's 8 characters as a
**transcription check** (catches typos of a value the human is looking at;
it is NOT claimed to prove the human saw the peer's screen — v1
overclaimed, review). On match + `y`:

- **Staged two-phase commit (per review — no half-rotated lanes):**
  1. write the complete candidate record (`botlink-keys/.pairing-stage/`:
     new `authorized_keys` content, new peer hostkey pin, journal entry),
     fsync;
  2. atomically rename each into place (tmp+rename, 0600, prior files
     backed up `.bak-<ts>`), journal marked committed, state cleared.
  A crash mid-commit is detected on next `pair --status` via the journal
  and rolled back to the backups. Cross-machine asymmetry (one owner
  confirms, the other declines/TTLs out) cannot strand the lane because of
  the rotation grace rule below.
- Log a `paired`/`rotated` event into the hash-chained `inject.log` — pin
  changes land in the same tamper-evident audit trail as injects.

### Phase R — rotation after first pairing

- Requires explicit local `pair --arm --rotate` on the rotating machine
  (**no auto-arm** — decision with the owners; an armed peer never arms
  this side by itself).
- Staged `.next` keys (phase 1); signed exchange (phase 2); human SAS
  comparison STILL REQUIRED (**decision with the owners**: rotations keep
  the human SAS — the old-key signature authenticates the exchange, the
  SAS covers the case where the existing lane itself is compromised).
- **Replace-with-grace cutover (per review):** on confirm, the peer's new
  bot key line REPLACES the old line's position — but the old line is
  retained, marked `# rotating-from`, until the first SUCCESSFUL
  authenticated exchange on the new key (verified `bot_status` round
  trip), after which it is removed automatically and logged. A stale
  unused new line (peer never confirmed) is swept after 24h. So: old
  credentials never linger indefinitely (the review's "rotation must
  restore trust"), and a one-sided confirm cannot break the working lane.

## Compliance with standing laws

| Law | How it holds |
|---|---|
| No secrets in transit | Fingerprints, public keys, nonces, signatures only. Private halves never leave. |
| No preauthkeys in transit | Tailscale untouched (non-goal). |
| Agent never confirms | Confirm is a local TTY command, not a verb/inject/lane message — unreachable remotely. Honest boundary: local code exec can automate it, but local code exec already owns `authorized_keys`; the claim is narrowed to what's true. |
| Host key pinned, no TOFU | Pin writes happen only inside the human-tapped confirm, inside a journaled two-phase commit; mismatch/abort leaves all files untouched. |
| Two verbs, nothing else | Main listener untouched, first pairing AND rotation. Pairing surface = separate, TTL'd, single-use, single-verb listener with strict input schema. |
| Injects carry no authority | Unchanged; pairing is not expressible as an inject; agents never relay SAS. |
| Fail closed | TTL, single-use, schema violation, SAS mismatch, non-TTY, journal rollbacks — every failure path wipes state and writes nothing. |

## Implementation sketch

- `src/pairing.ts` (library): `startPairingListener()` (the ephemeral
  surface), `pairDial()`, `buildConfirmPlan()`/`stageAndCommit()` +
  journal rollback, `stripRotatingLine()`/`sweepStaleRotation()`, SAS
  derivation + validation + sanitizers. Ed25519 sign/verify via the ssh2
  key parsing already imported — one-directional static import
  (pairing → botlink); botlink pulls pairing lazily at its two cutover
  call sites so no static cycle exists.
- `src/botlink.ts`: the main listener gains ONLY an optional
  `authorizedKeysPath` (rotation cutover on successful auth + boot sweep of
  stale grace lines). Verb dispatch gains nothing.
- CLI (`src/botlink-server.ts`): `npm run botlink -- pair [--arm [--rotate]
  |--dial|--confirm|--status|--rollback]`; `serve` passes the
  authorized_keys path for the cutover hook; `--confirm` appends a
  `paired`/`rotated` event to the hash-chained inject.log.
- State: `botlink-keys/pairing.json` (0600, single-use),
  `botlink-keys/.pairing-stage/` (commit journal), `.next` staged keys.
- Tests (`tests/pairing.test.mjs`, offline, guards.test.mjs style):
  key-substitution → SAS differs; reveal-without-matching-commit →
  exchange refused; grinding attempt (attacker picks keys pre-commit,
  tries many nonces) cannot produce equal SAS on both legs without the
  real keys — spot-checked over 10k simulated attempts; schema
  violations (newlines/ANSI/oversize) refused and never logged raw;
  rotation replace preserves unrelated peers' lines; old line auto-removed
  after first successful new-key auth, kept before; journal rollback on
  killed mid-commit; `pair-hello` on main listener refused; second
  exchange on ephemeral listener refused; TTL expiry wipes state.

## Review findings → resolutions (Copilot, PR #3)

| # | Finding | Resolution |
|---|---|---|
| 1 | 40-bit claim broken by offline birthday collision on deterministic transcript | Commit-then-reveal with fresh per-arm nonces; length-delimited role-bound transcript; per-attempt online bound 2⁻⁴⁰, one attempt per arm (§SAS construction) |
| 2 | TTY is not proof of human presence | Claim narrowed honestly (§Honest boundary); confirm defends remote/lane automation only; local code exec = already game over for keys |
| 3 | Copy-check echoes local SAS; thread equivocation fools both owners | Typo-check reframe + agents-never-relay-SAS rule + server-side message identity reasoning (§SAS comparison rules) |
| 4 | Rotation append leaves old key authorized forever | Replace-with-grace: old line removed automatically after first successful new-key exchange; 24h sweep of unused new lines |
| 5 | Unvalidated `name` → terminal/log injection | Strict schema on every field; parseKey-validated bot_pub; control-char stripping before any display/log |
| 6 | Crash/asymmetry → half-rotated lane | Journaled two-phase local commit + rollback; grace cutover keeps old credentials until proven new-key auth |
| 7 | `pair-hello` on main listener contradicts two-verb invariant | Dropped — ALL pairing traffic on the ephemeral listener, rotations included; rotation auth via signed reveal instead |
| 8 | Key staging undefined; overwriting active keys strands the lane | `.next` staged candidates; active keys immobile until cutover |
| 9 | Lane-compromised rotation: SAS never actually compared | Rotations KEEP the human SAS (owners' decision); no defense-in-depth-only claim remains |

## Decisions (with the owners, 2026-10-03)

1. SAS length: **8 base32 chars**, grouped `XXXX-XXXX`.
2. Pin storage: **`botlink-keys/peer.hostkey` file** (0600, joins the
   keydir; env stays supported as an override for backward compatibility).
3. Rotation arming: **never automatic** — explicit `--arm --rotate` only.
4. Multi-machine `peers/` shape: **deferred**; design stays pairwise.
5. Merge onto main: **Joe's word**; activation is always
   owner-in-terminal on each machine.
