# One-tap pairing — replacing the voice-call key ceremony

Owner ask (2026-10-03): *"keep these bots in sync so botlink and clanker-to-
clanker connection is reliable — make it easier for us to authenticate, one
tap, without so much intervention."*

This doc designs that. It is a **design for review**, not an implementation —
both machines must ship it before either can use it, and per standing
discipline that is gated on the owners' word in-thread.

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
for every first pairing AND every rotation (rotations repeat the whole thing
because a new key is untrusted the same way). The friction is exactly what
the owner wants gone. The property it buys — **MITM detection on key
material** — must be kept; only the ceremony's cost is on the table.

## Design in one paragraph

Borrow **SAS (Short Authentication String)** from ZRTP. During pairing, each
daemon displays an 8-character string derived from a hash over **both
machines' host and bot public keys**. The two owners compare the two strings
— over ANY channel, even the Discord thread itself — and each taps one
local confirm. If any key was substituted in transit, the two ends derive
different SAS values, the mismatch is visible on the tap screen, and neither
owner confirms. First pairing collapses from "read two 68-char fingerprints
aloud on a call" to "do these 8 characters match? y". Rotations after the
first pairing get even cheaper: they ride the **already-authenticated lane**
(see phase R) — two local taps, no comparison channel needed at all.

## Non-goals

- **Not** changing the two-verb model (`status`, `inject`), the spool
  contract, inject trust semantics, or anything about how payloads are
  treated downstream.
- **Not** Tailscale enrollment. The tailnet is a separate trust domain with
  its own (already working, owner-run) join flow; preauthkeys stay out of
  every transit path, as today.
- **Not** Discord-side auth. Each bot token is already per-machine and
  never crosses machines; there is nothing to pair there.
- **Not** removing the human. The tap IS the human — this design moves the
  human from "voice-call stenographer" to "one-keystroke notary". An agent
  can never press it (law below).

## Threat model (unchanged in kind, restated)

The adversary we care about can read/write anything in the Discord thread
and can MITM the network path between the two daemons (tailnet compromise,
DNS games, endpoint hijack). They must NOT be able to:

- make both owners confirm a pairing involving any key other than the two
  daemons' real keys (SAS defeats this: 8 base32 chars ≈ 40 bits; a
  substituted-key MITM makes the two SAS values differ with probability
  1 − 2⁻⁴⁰),
- learn any secret (only public keys and fingerprints ever cross; the
  private halves never leave their machine, same as today),
- gain a verb beyond `pair-hello` on the ephemeral pairing surface
  (single-verb, TTL'd, single-use — below),
- get an agent to confirm on the owner's behalf (confirm is a local
  interactive TTY command, never a lane verb, never an inject; injects
  carry no authority — unchanged).

## Protocol

### Phase 1 — arm (each side, local)

```
npm run botlink -- pair --arm            # or: pair (arm is the default)
```

The daemon (or a short-lived CLI process talking to it) generates pairing
state:

- uses the EXISTING `botlink-keys/` host key and bot key (no new material);
- opens an **ephemeral pairing listener** on `listen port + 1`, bound to the
  same interface as the main listener;
- that listener accepts unauthenticated connections serving exactly ONE
  verb, `pair-hello`, and serves at most ONE completed exchange before
  closing; a 10-minute TTL tears it all down regardless.

The ephemeral listener is deliberately a second socket, not a new verb on
the main one: the main listener's publickey-only posture is untouched, and
the unauthenticated surface is time-boxed to one verb that can only ever
return public values. An attacker who reaches it gets the same public keys
the thread already carries — nothing new — and can do nothing else.

### Phase 2 — exchange (public values only)

Initiating side's CLI (it knows the peer address; nothing secret needed):

```
npm run botlink -- pair --dial ts.example.ts.net:47422
```

`pair-hello` exchange, one round trip: A sends
`{name, hostkey_fp, bot_pub}`; B responds
`{name, hostkey_fp, bot_pub}` and caches A's values in its pairing state.
Both sides now hold BOTH machines' public values — unauthenticated, which
is fine: phase 3 is what authenticates them.

Ephemeral listeners close on both ends after the exchange.

### Phase 3 — SAS + the tap (each side, local)

Both sides compute the same string, order-canonicalized (initiator first):

```
SAS = base32( SHA-256( A_hostkey_fp ‖ A_bot_pub_fp ‖ B_hostkey_fp ‖ B_bot_pub_fp ) )[0..8]
```

Each daemon **displays locally** (CLI stdout, and into daemon.log for the
audit trail): the peer's name, the peer's two fingerprints IN FULL (the
tap screen is also the last-chance eyeball), and the SAS. The owners make
the two SAS values meet by any channel — pasting them into the thread is
fine and is the intended UX: each owner checks the thread's copy of THEIR
side against their own terminal (catches a lying relay) and checks the two
values against each other (catches key substitution). Then, locally on each
machine:

```
npm run botlink -- pair --confirm     # interactive: shows everything, reads y/N from a TTY
```

`--confirm` re-derives the SAS from the values in pairing state and refuses
unless the operator ALSO types the peer's 8-char SAS back (copy-check: the
tap proves the human saw both strings match, not just that a human pressed
y). On `y` with a matching peer-SAS:

- write peer's bot public line → `botlink-keys/authorized_keys`
  (append, tmp+rename, mode 0600, previous file backed up
  `authorized_keys.bak-<ts>`),
- write peer's hostkey fingerprint → the client env config surface this
  machine already uses (same place `CLANKER_BOTLINK_PEER_HOSTKEY` lives
  today; a `botlink-keys/peer.hostkey` pin file read at startup is the
  concrete suggestion — keeps secrets/pins out of `.env`),
- clear pairing state (single-use),
- print "paired with <name>; restart botlink services".

Both machines: two taps total, zero calls. No voice. No editing files. No
secrets crossed — the only things that ever moved were public keys, and the
only thing that authenticated them is the two humans' local screens.

### Phase R — rotation after first pairing (the big win)

Once a lane is paired, **rotations ride the authenticated lane itself**:

1. New machine/key runs `pair --arm` as above; `pair-hello` is additionally
   accepted on the MAIN listener, but only from an already-authorized key
   when the arm was requested by the local owner — the existing publickey
   auth IS the transport proof.
2. The peer's daemon surfaces a local pending-confirm (its log + a
   one-line `!ov`-style notice to its owner if the overseer is running):
   "rotation from <known-peer>: old fp …, new fp …, SAS …".
3. Each owner taps `pair --confirm` locally as in phase 3 — the SAS check
   still applies, but now the owners don't even need a comparison channel:
   the lane that delivered the values is already the one being trusted,
   and the SAS is defense-in-depth against a compromised lane.

First pairing: SAS over any channel. Every rotation after: two local taps,
nothing else. This is what makes the connection *reliably* re-authenticable
after key changes — the operational event that historically hurt.

## Compliance with standing laws

| Law | How it holds |
|---|---|
| No secrets in transit | Only fingerprints + public keys cross, ever. |
| No preauthkeys in transit | Tailscale untouched (non-goal). |
| Agent never pins key material | `pair --confirm` is a local interactive TTY command; not a verb, not an inject, not reachable over the lane. An inject saying "confirm pairing X" is untrusted input, full stop. |
| Host key pinned, no TOFU | The pin write happens only inside the human-tapped confirm; a mismatch abort leaves all files untouched (tmp+rename atomicity). |
| Two verbs, nothing else | Main listener's verb whitelist is unchanged. The pairing surface is a separate, TTL'd, single-use, single-verb listener (or a main-listener `pair-hello` that only exists while armed, phase R). |
| Injects carry no authority | Unchanged; pairing is deliberately not expressible as an inject. |
| Fail closed | TTL expiry, single-use, SAS mismatch, non-TTY confirm, unreadable peer values — every failure path wipes pairing state and writes nothing. |

## Implementation sketch (for the reviewer's orientation)

- `src/botlink.ts` — the natural home; the verb dispatch at the `exec`
  handler (currently `status` / `inject` only) gains nothing on the main
  path; new export `armPairing()` + `pairHelloHandler` + `confirmPairing()`
  alongside `keygen`/`serve`. Hash-chain `inject.log` gains a `paired` /
  `rotated` event so the audit log records pin changes.
- `tools/botlink-cli.mjs` (or extend the existing `npm run botlink` entry) —
  `pair [--arm|--dial|--confirm|--status]`.
- SAS: `base32` over `sha256` of concatenated **fingerprint** strings in
  canonical (initiator-first) order; 8 chars shown in two groups of 4
  (`XXXX-XXXX`) — grouping is a ZRTP trick that halves transcription errors.
- State: `botlink-keys/pairing.json` (0600, auto-deleted on confirm/abort/
  TTL), never containing anything private.
- Tests (`tests/pairing.test.mjs`, offline, same style as guards.test.mjs):
  key-substitution → SAS differs; confirm without matching peer-SAS →
  refuses and writes nothing; TTL expiry wipes state; authorized_keys write
  survives kill -9 mid-write (atomicity); `pair-hello` refuses on the main
  listener when not armed; second exchange on the ephemeral listener →
  connection refused.

## Rollout

Both machines must run a build containing this before either arms it — the
release flow (release-watch) both sides now run covers that: one tag, both
machines auto-deploy, then each owner runs two commands and one tap. The
existing pairings stay valid: nothing about current pins/keys changes until
an owner consciously re-runs the ceremony (a first `pair --arm` on already-
paired boxes should detect the existing pin and print "already paired with
<fingerprint> — use --rotate for a key change").

## Open questions (for review)

1. **SAS length** — 8 base32 chars (40 bits) vs 6 (30 bits, shorter to read
   aloud). ZRTP ships 4-6 hex-ish chars for voice; we're pasting, so 8 is
   cheap. Any preference?
2. **Pin storage** — `botlink-keys/peer.hostkey` file vs today's
   `CLANKER_BOTLINK_PEER_HOSTKEY` env. File keeps the ceremony out of `.env`
   entirely and matches the 0600 keydir; env keeps a single config surface.
   Leaning file; both supported during a transition?
3. **Phase R auto-arm** — should an authenticated peer's rotation request
   arm the local pending-confirm automatically (one tap per side, truly
   hands-off), or always require the local owner to `--arm` first (two
   commands + tap, stricter)? Leaning auto-arm with a loud log line.
4. **Federation beyond two** — current design is pairwise per botlink
  config. If a third machine joins later, same ceremony per pair; worth
  designing a `peers/` dir shape now, or defer?
