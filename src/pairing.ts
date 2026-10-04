/**
 * pairing — one-tap first pairing and rotation for the botlink lane.
 * Design + threat model: docs/one-tap-pairing.md (v2). Summary:
 *
 *   - ALL pairing traffic lives on a separate EPHEMERAL listener (main
 *     port + 1 by default): unauthenticated TCP carrying one exchange —
 *     `pair-hello` phase 1 (commitments + public values) → phase 2
 *     (reveals + optional rotation signatures) — length-capped, single
 *     use, 10-minute TTL. The main listener's status/inject surface is
 *     untouched.
 *   - The SAS is bound to a length-delimited, role-labeled transcript
 *     over BOTH machines' host/bot public values plus fresh per-side
 *     nonces exchanged COMMIT-BEFORE-REVEAL, so a MITM must fix
 *     substituted keys before seeing either nonce: collision grinding is
 *     an online 2^-40-per-attempt bet that shows up as a visible SAS
 *     mismatch, not an offline birthday search (v1 flaw, PR #3 review).
 *   - `pair --confirm` is a LOCAL interactive command only: no verb, no
 *     inject, nothing reachable over the lane. A TTY is intent-gathering,
 *     NOT proof of human presence (local code exec can drive a pty — and
 *     local code exec already owns authorized_keys; we defend the remote/
 *     lane surface and say so honestly).
 *   - Rotation: staged `.next` candidate keys (active keys never move
 *     until cutover), the exchange signed with the OLD bot key and
 *     verified against the pinned line, the human SAS still required, and
 *     the peer's authorized_keys update is replace-with-grace: the old
 *     line survives (marked `# rotating-from`) until the first
 *     successful authenticated exchange on the new key, then is removed
 *     automatically (see startBotlinkServer's cutover hook) — a rotation
 *     must actually restore trust, and a one-sided confirm must never
 *     strand a working lane.
 *
 * Secrets never cross the wire: public keys, fingerprints, nonces,
 * signatures. `pairing.json`/staging live inside botlink-keys/ (0600,
 * gitignored) and contain nothing private beyond the nonce, which is
 * published at reveal anyway.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fingerprintOfPublicKey, parseKey } from "./botlink.js";

export const PAIRING_TTL_MS = 10 * 60_000;
/** Grace sweep: an unused rotated-in key line older than this is dropped. */
export const ROTATION_GRACE_MS = 24 * 60 * 60_000;
const MAX_WIRE_BYTES = 8192; // every phase payload is far below this
const WIRE_TIMEOUT_MS = 15_000; // inactivity during the exchange

// ---------------------------------------------------------------------------
// Validation — every field is schema-checked BEFORE storage/display/log:
// the tap screen and the audit log render peer-controlled text, so raw
// newlines/ANSI must never reach them (PR #3 review).
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export interface PeerValues {
  name: string;
  hostkeyFp: string;
  botPub: string; // full OpenSSH public line ("ssh-ed25519 AAAA… comment")
  commit: string; // H(nonce ‖ "commit"), hex — phase 1
  nonce?: string; // hex — phase 2 reveal
  /** Rotation only: the dialer's STILL-ACTIVE public line, the trust
   *  anchor the rotation signature is verified against. */
  prevBotPub?: string;
  /** Rotation only: signature over the canonical transcript with the
   *  sender's old bot key. */
  sig?: string; // base64
}

/** Throws on any violation — callers treat "validatePeerValues threw" as
 *  "close the exchange". */
export function validatePeerValues(v: unknown): PeerValues {
  if (typeof v !== "object" || v === null) throw new Error("pairing payload is not an object");
  const o = v as Record<string, unknown>;
  const name = o.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error('pairing: bad "name" (want 1-64 chars of [A-Za-z0-9._-])');
  }
  const hostkeyFp = o.hostkeyFp ?? o.hostkey_fp;
  if (typeof hostkeyFp !== "string" || !FP_RE.test(hostkeyFp)) {
    throw new Error('pairing: bad "hostkeyFp" (want SHA256:<43 base64 chars>)');
  }
  const botPub = o.botPub ?? o.bot_pub;
  if (typeof botPub !== "string" || !/^\S+ \S+( \S.*)?$/.test(botPub) || botPub.length > 600) {
    throw new Error('pairing: bad "botPub" (want an OpenSSH public line)');
  }
  if (/[\r\n]/.test(botPub)) throw new Error('pairing: "botPub" must be a single line');
  try {
    parseKey(botPub); // must round-trip through the same parser authorized_keys uses
  } catch (err) {
    throw new Error(`pairing: "botPub" is not a parseable public key: ${(err as Error).message}`);
  }
  const commit = o.commit;
  if (typeof commit !== "string" || !HEX64_RE.test(commit)) {
    throw new Error('pairing: bad "commit" (want 64 hex chars)');
  }
  const out: PeerValues = { name, hostkeyFp, botPub, commit };
  if (o.nonce !== undefined) {
    if (typeof o.nonce !== "string" || !HEX64_RE.test(o.nonce)) {
      throw new Error('pairing: bad "nonce" (want 64 hex chars)');
    }
    out.nonce = o.nonce;
  }
  const prevRaw = o.prevBotPub ?? o.prev_bot_pub;
  if (prevRaw !== undefined) {
    if (typeof prevRaw !== "string" || prevRaw.length > 600 || /[\r\n]/.test(prevRaw)) {
      throw new Error('pairing: bad "prevBotPub" (single line, ≤600 chars)');
    }
    try {
      parseKey(prevRaw);
    } catch {
      throw new Error('pairing: "prevBotPub" is not a parseable public key');
    }
    out.prevBotPub = prevRaw;
  }
  if (o.sig !== undefined) {
    if (typeof o.sig !== "string" || !/^[A-Za-z0-9+/=]+$/.test(o.sig)) {
      throw new Error('pairing: bad "sig" (want base64)');
    }
    out.sig = o.sig;
  }
  return out;
}

/** Peer-controlled text → printable single line, for terminals and logs. */
export function sanitizePeerText(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/\s+/g, " ").trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// Transcript + SAS — length-delimited, role-bound, commit-then-reveal.
// ---------------------------------------------------------------------------

export function lenDelim(...parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    chunks.push(len, b);
  }
  return Buffer.concat(chunks);
}

export interface SideValues {
  hostkeyFp: string;
  botPub: string;
  nonce: string;
}

/** Canonical pre-SAS transcript: initiator's values first, roles labeled —
 *  both sides derive it identically (each knows who dialed). */
export function pairingTranscript(a: SideValues, b: SideValues): Buffer {
  return lenDelim(
    "initiator", a.hostkeyFp, a.botPub, a.nonce,
    "responder", b.hostkeyFp, b.botPub, b.nonce,
  );
}

/** Message a rotation signature covers — distinct from the SAS transcript
 *  so a signature can't be repurposed as (or confused with) an SAS input.
 *
 *  Slot rule (signer and verifier must construct identical slots): the order
 *  is initiator-first ALWAYS. A signer puts its OWN real nonce in its own
 *  slot and the COUNTERPARTY's phase-1 COMMITMENT in theirs — the
 *  counterparty's nonce is still hidden when the initiator signs, and using
 *  the commitment uniformly keeps both directions reconstructible on receipt
 *  (each sig binds both sides' public values + the signer's old key by
 *  signing + fresh nonces/commitments, so a replayed old exchange's sig
 *  can't cover a new one). */
export function rotationSigningMessage(a: SideValues, b: SideValues): Buffer {
  return lenDelim(
    "botlink-rotation-v1",
    a.hostkeyFp, a.botPub, a.nonce,
    b.hostkeyFp, b.botPub, b.nonce,
  );
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 8 base32 chars (40 bits) of SHA-256 over the transcript, grouped
 *  XXXX-XXXX for transcription. With commit-then-reveal nonces, each
 *  MITM attempt succeeds with probability 2^-40 and fails VISIBLY. */
export function deriveSas(a: SideValues, b: SideValues): string {
  const h = crypto.createHash("sha256").update(pairingTranscript(a, b)).digest();
  const s = base32(h).slice(0, 8);
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function freshNonce(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** commit = H(nonce ‖ "commit") — sent phase 1, verified at reveal. */
export function commitOf(nonce: string): string {
  return crypto.createHash("sha256").update(nonce + "commit", "utf8").digest("hex");
}

/** Typed-SAS normalization: accept XXXX-XXXX, xxxxxxxx, spaces. */
export function normalizeSasInput(s: string): string {
  return s.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

/** SAS over a COMPLETED exchange, from persisted pairing state — the single
 *  derivation shared by the CLI confirm, the tap screen, and the companion
 *  app's allow path (initiator-first per the canonical transcript, so every
 *  surface shows the identical string). Null until the reveal lands. */
export function sasOfState(s: PairingState): string | null {
  if (s.status !== "exchanged" || !s.peer?.nonce) return null;
  const selfSide: SideValues = { hostkeyFp: s.self.hostkeyFp, botPub: s.self.botPub, nonce: s.nonce };
  const peerSide: SideValues = { hostkeyFp: s.peer.hostkeyFp, botPub: s.peer.botPub, nonce: s.peer.nonce };
  return s.role === "initiator" ? deriveSas(selfSide, peerSide) : deriveSas(peerSide, selfSide);
}

/** Stable selector for ONE completed exchange: sha256 of the same canonical
 *  transcript the SAS covers. A late or replayed allow naming an old
 *  attemptId can never alias onto a fresh exchange. */
export function attemptIdOfState(s: PairingState): string | null {
  if (s.status !== "exchanged" || !s.peer?.nonce) return null;
  const selfSide: SideValues = { hostkeyFp: s.self.hostkeyFp, botPub: s.self.botPub, nonce: s.nonce };
  const peerSide: SideValues = { hostkeyFp: s.peer.hostkeyFp, botPub: s.peer.botPub, nonce: s.peer.nonce };
  const transcript =
    s.role === "initiator" ? pairingTranscript(selfSide, peerSide) : pairingTranscript(peerSide, selfSide);
  return crypto.createHash("sha256").update(transcript).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Rotation signatures — Ed25519 via the same ssh2 key handling the lane
// already uses (no new crypto dependency, no second wire format).
// ---------------------------------------------------------------------------

function signWith(privatePem: string, msg: Buffer): string {
  const key = parseKey(privatePem);
  // ssh2's ed25519 sign() returns the RAW 64-byte signature Buffer (or an
  // Error per ssh2's return-errors convention — the isBuffer check covers both).
  const raw = key.sign(msg) as unknown;
  if (!Buffer.isBuffer(raw)) throw new Error("botlink pairing: ssh2 returned no signature buffer");
  return raw.toString("base64");
}

function verifyWith(publicLine: string, msg: Buffer, sigB64: string): boolean {
  try {
    const key = parseKey(publicLine);
    return key.verify(msg, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** Sign a rotation message with this machine's active bot key (exported for
 *  the CLI + tests). */
export function signRotation(privatePem: string, a: SideValues, b: SideValues): string {
  return signWith(privatePem, rotationSigningMessage(a, b));
}

/** Verify a peer's rotation signature against a pinned public line. */
export function verifyRotation(publicLine: string, a: SideValues, b: SideValues, sigB64: string): boolean {
  return verifyWith(publicLine, rotationSigningMessage(a, b), sigB64);
}

/** Generic Ed25519 verify over an arbitrary message (companion-app request
 *  signatures reuse the lane's key handling — no second crypto stack). */
export function verifyEd25519(publicLine: string, msg: Buffer, sigB64: string): boolean {
  return verifyWith(publicLine, msg, sigB64);
}

// ---------------------------------------------------------------------------
// Pairing state — botlink-keys/pairing.json, 0600, single-use.
// ---------------------------------------------------------------------------

export interface PairingState {
  v: 1;
  mode: "first" | "rotate";
  status: "armed" | "exchanged" | "consumed";
  armedAt: number;
  /** Set when this side dials (initiator) or on incoming phase 1 (responder). */
  role?: "initiator" | "responder";
  /** This side's public values for the exchange (active keys, or the staged
   *  .next pair for a rotation). */
  self: { name: string; hostkeyFp: string; botPub: string };
  nonce: string;
  peer?: PeerValues;
}

export interface KeydirPaths {
  dir: string;
  state: string;
  hostKey: string;
  botKey: string;
  hostKeyNext: string;
  botKeyNext: string;
  peerHostkey: string;
  authorizedKeys: string;
  stageDir: string;
}

export function keydirPaths(dir: string): KeydirPaths {
  return {
    dir,
    state: path.join(dir, "pairing.json"),
    hostKey: path.join(dir, "host_key"),
    botKey: path.join(dir, "bot_key"),
    hostKeyNext: path.join(dir, "host_key.next"),
    botKeyNext: path.join(dir, "bot_key.next"),
    peerHostkey: path.join(dir, "peer.hostkey"),
    authorizedKeys: path.join(dir, "authorized_keys"),
    stageDir: path.join(dir, ".pairing-stage"),
  };
}

export function loadPairingState(p: KeydirPaths): PairingState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p.state, "utf8")) as PairingState;
    if (raw.v !== 1) throw new Error(`unknown pairing state version ${raw.v}`);
    return raw;
  } catch {
    return null;
  }
}

export function savePairingState(p: KeydirPaths, s: PairingState): void {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.state, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(p.state, 0o600); // chmod after write (Windows no-ops it)
  } catch {
    /* best effort */
  }
}

export function clearPairingState(p: KeydirPaths): void {
  try {
    fs.rmSync(p.state, { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** Expired or consumed state is indistinguishable from no state — fail
 *  closed: an arm older than the TTL can never be confirmed. */
export function stateIsLive(s: PairingState | null): s is PairingState {
  return s !== null && s.status !== "consumed" && Date.now() - s.armedAt < PAIRING_TTL_MS;
}

// ---------------------------------------------------------------------------
// Wire protocol — newline-delimited JSON, one TCP connection, capped.
// ---------------------------------------------------------------------------

function readFirstKeyLine(file: string): string | null {
  try {
    return (
      fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0 && !l.startsWith("#")) ?? null
    );
  } catch {
    return null;
  }
}

export interface ExchangeOutcome {
  state: PairingState;
  sas: string;
}

/** The dialing side: connect, commit-then-reveal both ways, store the
 *  exchange, return the SAS. Throws (socket closed) on any violation —
 *  nothing is written to trust files on failure. */
export async function pairDial(opts: {
  host: string;
  port: number;
  state: PairingState;
  paths: KeydirPaths;
  /** This machine's pinned lines (rotation trust anchor for the responder). */
  authorizedLines: () => string[];
  log: (line: string) => void;
}): Promise<ExchangeOutcome> {
  const state: PairingState = { ...opts.state, status: "exchanged", role: "initiator" };
  const selfSide = (): SideValues => ({ ...state.self, nonce: state.nonce });
  const peerSideOf = (nonce: string): SideValues => {
    const peer = state.peer!;
    return { hostkeyFp: peer.hostkeyFp, botPub: peer.botPub, nonce };
  };

  return new Promise<ExchangeOutcome>((resolve, reject) => {
    const socket = net.connect({ host: opts.host, port: opts.port });
    socket.setTimeout(WIRE_TIMEOUT_MS);
    let buffer = "";
    const fail = (why: string) => {
      socket.destroy();
      reject(new Error(why));
    };
    socket.on("error", (err) => reject(err));
    socket.on("timeout", () => fail("pairing dial: exchange timed out"));
    socket.on("close", () => {
      // Premature close must reject: socket-timeout timers are UNREF'd in
      // Node, so without this a dropped connection dangles the promise
      // past event-loop drain instead of failing the dial.
      reject(new Error("pairing dial: connection closed before the exchange completed"));
    });
    const onLine = (handler: (msg: Record<string, unknown>) => void) => {
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > MAX_WIRE_BYTES) return fail("pairing dial: reply over cap");
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return fail("pairing dial: reply is not JSON");
        }
        try {
          handler(msg);
        } catch (err) {
          fail(`pairing dial: ${(err as Error).message}`);
        }
      });
    };

    onLine((msg) => {
      if (msg.cmd !== "pair-hello" || msg.phase !== 1) throw new Error("expected phase 1");
      const peer = validatePeerValues(msg.peer);
      if (peer.prevBotPub !== undefined) {
        const pinned = opts.authorizedLines().some((l) => l.trim() === peer.prevBotPub!.trim());
        if (!pinned) throw new Error("rotation: responder prevBotPub is not pinned on this machine");
      }
      state.peer = { ...peer, nonce: undefined, sig: undefined };
      // Reveal only after the responder's commitment is in hand. A rotating
      // initiator ALSO signs the reveal with the ACTIVE (old) bot key — the
      // identity the responder has pinned (slot rule above: our real nonce,
      // their commitment).
      const reveal: Record<string, unknown> = { cmd: "pair-hello", phase: 2, nonce: state.nonce };
      if (state.mode === "rotate") {
        reveal.sig = signRotation(
          fs.readFileSync(opts.paths.botKey, "utf8"),
          selfSide(), // initiator slot: our values + our real nonce
          { hostkeyFp: peer.hostkeyFp, botPub: peer.botPub, nonce: peer.commit }, // responder slot: their commitment
        );
      }
      socket.write(JSON.stringify(reveal) + "\n");

      socket.removeAllListeners("data");
      buffer = "";
      onLine((msg2) => {
        if (msg2.cmd !== "pair-hello" || msg2.phase !== 2) throw new Error("expected phase 2");
        const nonce = typeof msg2.nonce === "string" ? msg2.nonce : "";
        if (!HEX64_RE.test(nonce)) throw new Error("bad responder nonce");
        if (commitOf(nonce) !== peer.commit) {
          throw new Error("responder reveal does not match commitment — aborting, nothing written");
        }
        // Verify iff the RESPONDER claimed rotation (their phase-1
        // prevBotPub) — NOT based on our own mode, so a first-mode dial into
        // a rotating responder still verifies, and a rotating dial into a
        // first-mode responder sends a sig that is simply not demanded.
        if (peer.prevBotPub !== undefined) {
          const sig = typeof msg2.sig === "string" ? msg2.sig : "";
          if (
            !verifyRotation(
              peer.prevBotPub,
              { ...state.self, nonce: commitOf(state.nonce) }, // initiator slot: OUR commitment (that's all they had)
              peerSideOf(nonce), // responder slot: their values + their revealed nonce
              sig,
            )
          ) {
            throw new Error("rotation signature FAILED — exchange aborted, nothing written");
          }
        }
        state.peer = { ...peer, nonce };
        const sas = deriveSas(selfSide(), peerSideOf(nonce));
        socket.end();
        savePairingState(opts.paths, state);
        opts.log(`pairing: exchange complete with ${sanitizePeerText(peer.name)} — SAS ${sas}`);
        resolve({ state, sas });
      });
    });

    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          cmd: "pair-hello",
          phase: 1,
          peer: {
            name: state.self.name,
            hostkeyFp: state.self.hostkeyFp,
            botPub: state.self.botPub,
            commit: commitOf(state.nonce),
            ...(state.mode === "rotate"
              ? { prevBotPub: readFirstKeyLine(opts.paths.botKey + ".pub") ?? undefined }
              : {}),
          },
        }) + "\n",
      );
    });
  });
}

/** The responding side: arms a one-exchange TCP listener. Every violation
 *  closes the socket and (for phase-2 failures) wipes the half-exchange —
 *  a failed exchange never leaves confirmable state. */
export function startPairingListener(opts: {
  bind: string;
  port: number;
  state: PairingState;
  paths: KeydirPaths;
  authorizedLines: () => string[];
  onExchanged: (outcome: ExchangeOutcome) => void;
  log: (line: string) => void;
}): { close: () => void; port: number } {
  let live: PairingState = opts.state;
  let completed = false; // set the moment an exchange becomes confirmable
  // Per-connection ownership (audit fix 7): `live`/`completed` are shared
  // listener state, so the old drop() test (`!completed && live.peer`) let
  // ANY second connection that dropped — LAN probe, port scanner, impatient
  // re-dial — wipe a live half-exchange; the real initiator's phase 2 then
  // failed "phase 2 before phase 1" and the ceremony died spuriously. Only
  // the connection that STORED the exchange may wipe it.
  let ownerSocket: net.Socket | null = null;
  const server = net.createServer((socket) => {
    let buffer = "";
    const drop = (why: string) => {
      opts.log(`pairing listener: ${sanitizePeerText(why)}`);
      // Wipe ONLY an incomplete half-exchange owned by THIS connection:
      // after a completed exchange, trailing garbage on the socket (or any
      // later refused connection) must never destroy the confirmable state.
      if (socket === ownerSocket && !completed && live.peer !== undefined) {
        // a half-exchange that failed phase 2 must not stay confirmable
        live = { ...live, status: "armed", peer: undefined, role: undefined };
        savePairingState(opts.paths, live);
        ownerSocket = null;
      }
      socket.destroy();
    };
    socket.setTimeout(WIRE_TIMEOUT_MS, () => drop("exchange timed out"));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_WIRE_BYTES) return drop("payload over cap");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return drop("payload is not JSON");
      }
      if (msg.cmd !== "pair-hello") {
        return drop(`refused cmd "${sanitizePeerText(String(msg.cmd ?? ""))}"`);
      }
      // Single-use gate on COMPLETION, not on "a phase-1 was seen": the
      // phase-2 leg of the first exchange must pass, while anything after a
      // completed exchange is refused (phase-1 re-entry inside one exchange
      // is separately refused by the "not armed" check below).
      if (completed) return drop("single-use: exchange already completed");
      if (msg.phase === 1) {
        if (live.status !== "armed") return drop("not armed");
        let peer: PeerValues;
        try {
          peer = validatePeerValues(msg.peer);
        } catch (err) {
          return drop(`phase 1 rejected: ${(err as Error).message}`);
        }
        if (peer.prevBotPub !== undefined) {
          const pinned = opts.authorizedLines().some((l) => l.trim() === peer.prevBotPub!.trim());
          if (!pinned) return drop("rotation: initiator prevBotPub is not pinned on this machine");
        }
        live = { ...live, status: "exchanged", role: "responder", peer: { ...peer, nonce: undefined, sig: undefined } };
        ownerSocket = socket; // this connection owns the half-exchange until it completes
        savePairingState(opts.paths, live);
        // OUR commitment goes out bound to our nonce before their reveal.
        socket.write(
          JSON.stringify({
            cmd: "pair-hello",
            phase: 1,
            peer: {
              name: live.self.name,
              hostkeyFp: live.self.hostkeyFp,
              botPub: live.self.botPub,
              commit: commitOf(live.nonce),
              ...(live.mode === "rotate"
                ? { prevBotPub: readFirstKeyLine(opts.paths.botKey + ".pub") ?? undefined }
                : {}),
            },
          }) + "\n",
        );
        return;
      }
      if (msg.phase === 2) {
        // Status lives across data events (phase 1 saved "exchanged") —
        // check a const snapshot so the guard narrows properly. Phase 2 must
        // arrive on the OWNING connection (audit fix 7): the exchange is one
        // TCP conversation; a reveal on a different socket is refused and —
        // being non-owner — its drop must not wipe the real exchange.
        const snap = live;
        if (socket !== ownerSocket || snap.status !== "exchanged" || !snap.peer || snap.role !== "responder") {
          return drop("phase 2 before phase 1");
        }
        const nonce = typeof msg.nonce === "string" ? msg.nonce : "";
        if (!HEX64_RE.test(nonce)) return drop("phase 2: bad nonce");
        if (commitOf(nonce) !== snap.peer.commit) {
          return drop("phase 2: reveal does not match commitment");
        }
        const selfSide: SideValues = { ...snap.self, nonce: snap.nonce };
        const peerSide: SideValues = {
          hostkeyFp: snap.peer.hostkeyFp,
          botPub: snap.peer.botPub,
          nonce,
        };
        // Verify iff the INITIATOR claimed rotation (their phase-1
        // prevBotPub) — our own --rotate mode signs our reply but never
        // demands a signature from a peer who isn't rotating.
        if (snap.peer.prevBotPub !== undefined) {
          const sig = typeof msg.sig === "string" ? msg.sig : "";
          if (
            !verifyRotation(
              snap.peer.prevBotPub,
              { hostkeyFp: snap.peer.hostkeyFp, botPub: snap.peer.botPub, nonce }, // initiator slot: their revealed nonce
              { ...snap.self, nonce: commitOf(snap.nonce) }, // responder slot: OUR commitment
              sig,
            )
          ) {
            return drop("rotation signature FAILED — exchange aborted, nothing written");
          }
        }
        live = { ...snap, peer: { ...snap.peer, nonce } };
        savePairingState(opts.paths, live);
        completed = true; // confirmable from here on; later drops must not wipe it
        // Initiator-first transcript: the responder puts the PEER's side in
        // the initiator slot so both screens show the identical string.
        const sas = deriveSas(peerSide, selfSide);
        const reply: Record<string, unknown> = {
          cmd: "pair-hello",
          phase: 2,
          nonce: snap.nonce,
        };
        if (snap.mode === "rotate") {
          reply.sig = signRotation(
            fs.readFileSync(opts.paths.botKey, "utf8"), // ACTIVE (old) key — .next isn't live yet
            { hostkeyFp: snap.peer.hostkeyFp, botPub: snap.peer.botPub, nonce: snap.peer.commit }, // initiator slot: their commitment
            selfSide, // responder slot: our values + our real nonce
          );
        }
        socket.write(JSON.stringify(reply) + "\n", () => socket.end());
        server.close();
        opts.log(`pairing: exchange complete with ${sanitizePeerText(snap.peer.name)} — SAS ${sas}`);
        opts.onExchanged({ state: live, sas });
        return;
      }
      return drop(`bad phase ${sanitizePeerText(String(msg.phase ?? ""))}`);
    });
  });
  server.listen(opts.port, opts.bind);
  server.on("error", (err: Error) => opts.log(`pairing listener error: ${sanitizePeerText(err.message)}`));
  // port 0 = ephemeral: the REAL port only exists once 'listening' fires —
  // mutate it into the handle then, so callers that dial after startup read
  // the bound port instead of the 0 they asked for.
  const handle = {
    // Idempotent: after a completed exchange the server already closed
    // itself, and close() on a non-listening server raises ERR_SERVER_NOT_RUNNING.
    close: () => {
      if (server.listening) server.close();
    },
    port: opts.port,
  };
  server.once("listening", () => {
    const addr = server.address();
    if (typeof addr === "object" && addr !== null) handle.port = addr.port;
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Confirm — local interactive only. Two-phase journaled commit.
// ---------------------------------------------------------------------------

export interface ConfirmPlan {
  /** New authorized_keys content (grace-aware upsert applied). */
  authorizedKeys: string;
  /** peer.hostkey content (fingerprint line); null = unchanged. */
  peerHostkey: string | null;
  /** Human-readable list of what changes. */
  changes: string[];
  /** Rotation cutover: staged .next keys replace the active ones. */
  cutoverSelfKeys: boolean;
}

/** Compute the complete candidate record WITHOUT writing anything. The
 *  confirm prompt shows this; a mismatch/abort leaves all files intact. */
export function buildConfirmPlan(p: KeydirPaths, s: PairingState): ConfirmPlan {
  if (!stateIsLive(s)) {
    throw new Error("pairing: no live pairing state (arm first; TTL is 10 minutes)");
  }
  if (s.status !== "exchanged" || !s.peer || !s.peer.nonce) {
    throw new Error('pairing: exchange not complete — run "pair --dial" (or wait for the peer to dial) first');
  }
  const peer = s.peer;
  let authorized = "";
  try {
    authorized = fs.readFileSync(p.authorizedKeys, "utf8");
  } catch {
    authorized = "";
  }
  const lines = authorized.split(/\r?\n/);
  const norm = (l: string) => l.trim();
  const alreadyPinned = lines.some((l) => norm(l) === peer.botPub.trim());
  const prevLine = peer.prevBotPub
    ? lines.find((l) => norm(l) === peer.prevBotPub!.trim() && !l.trim().startsWith("#"))
    : undefined;
  let next: string[];
  if (alreadyPinned && !prevLine) {
    next = lines; // re-pairing the same key: nothing changes
  } else if (prevLine) {
    // Replace-with-grace: the old line stays, marked; the new line takes
    // over. Unrelated peers' lines are untouched.
    next = lines.map((l) =>
      l === prevLine ? `${l} # rotating-from ${new Date().toISOString()}` : l,
    );
    next = next.filter((l) => norm(l) !== peer.botPub.trim());
    next.push(peer.botPub);
  } else {
    next = lines.filter((l) => norm(l) !== peer.botPub.trim());
    next.push(peer.botPub);
  }
  const authorizedKeys = next.join("\n").replace(/\n+$/, "\n");

  let peerHostkey: string | null = `${peer.hostkeyFp}\n`;
  try {
    if (fs.readFileSync(p.peerHostkey, "utf8").trim() === peer.hostkeyFp) peerHostkey = null;
  } catch {
    /* absent → write */
  }

  const cutoverSelfKeys =
    s.mode === "rotate" && fs.existsSync(p.hostKeyNext) && fs.existsSync(p.botKeyNext);
  const changes: string[] = [];
  if (authorizedKeys !== authorized) changes.push(path.basename(p.authorizedKeys));
  if (peerHostkey !== null) changes.push(path.basename(p.peerHostkey));
  if (cutoverSelfKeys) changes.push("host_key/bot_key (.next cutover)");
  return { authorizedKeys, peerHostkey, changes, cutoverSelfKeys };
}

/** Stage everything (crash before phase 2 = no-op), then backups + atomic
 *  renames + the committed journal, then clear the stage dir. */
export function stageAndCommit(p: KeydirPaths, plan: ConfirmPlan, backupStamp: string): void {
  fs.mkdirSync(p.stageDir, { recursive: true });
  const journal = path.join(p.stageDir, "journal.json");
  fs.writeFileSync(path.join(p.stageDir, "authorized_keys"), plan.authorizedKeys, { mode: 0o600 });
  if (plan.peerHostkey !== null) {
    fs.writeFileSync(path.join(p.stageDir, "peer.hostkey"), plan.peerHostkey, { mode: 0o600 });
  }
  fs.writeFileSync(
    journal,
    // cutoverSelfKeys rides the journal (audit fix 8): recovery must know
    // whether THIS commit planned key renames — a lingering old journal must
    // never promote .next keys staged later by a fresh `pair --arm`.
    JSON.stringify({ phase: "staged", backupStamp, changes: plan.changes, cutoverSelfKeys: plan.cutoverSelfKeys }, null, 2),
  );
  const backup = (file: string) => {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${backupStamp}`);
  };
  backup(p.authorizedKeys);
  fs.renameSync(path.join(p.stageDir, "authorized_keys"), p.authorizedKeys);
  if (plan.peerHostkey !== null) {
    backup(p.peerHostkey);
    fs.renameSync(path.join(p.stageDir, "peer.hostkey"), p.peerHostkey);
  }
  try {
    fs.chmodSync(p.authorizedKeys, 0o600);
  } catch {
    /* Windows */
  }
  if (plan.cutoverSelfKeys) {
    // Active keys move ONLY at cutover, after the backups above; the peer's
    // grace line keeps the OLD key working there until it sees the new one.
    // Privates AND their .pub sidecars — a cutover that moved only the
    // private half would leave bot_key.pub claiming the OLD key while the
    // daemon serves the new one (everything that reads .pub — the next
    // rotation's prevBotPub anchor, self-values — would silently lie).
    for (const [next, active] of [
      [p.hostKeyNext, p.hostKey],
      [p.hostKeyNext + ".pub", p.hostKey + ".pub"],
      [p.botKeyNext, p.botKey],
      [p.botKeyNext + ".pub", p.botKey + ".pub"],
    ] as const) {
      if (!fs.existsSync(next)) continue;
      backup(active);
      fs.renameSync(next, active);
    }
  }
  fs.writeFileSync(
    journal,
    JSON.stringify({ phase: "committed", backupStamp, at: new Date().toISOString() }, null, 2),
  );
  fs.rmSync(p.stageDir, { recursive: true, force: true });
}

/** Detect an interrupted commit from the journal and finish or restore.
 *  Completing is the safe direction everywhere here: stageAndCommit only
 *  runs after a human-verified SAS confirm, so the journal's staged phase
 *  records ratified intent — recovery converges on that end-state. */
export function rollbackInterruptedCommit(p: KeydirPaths): boolean {
  const journalPath = path.join(p.stageDir, "journal.json");
  let journal: { phase?: string; backupStamp?: string; cutoverSelfKeys?: boolean };
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as typeof journal;
  } catch {
    return false; // no interrupted commit
  }
  const stamp = journal.backupStamp;
  if (!stamp) return false;
  const staged = (name: string) => path.join(p.stageDir, name);
  // Idempotent backup (audit fix 8): a pre-crash backup survives untouched;
  // an active file about to be replaced with NO backup yet (crash between
  // journal-write and its backup step) gets one under the same stamp.
  const backupOnce = (file: string) => {
    const bak = `${file}.bak-${stamp}`;
    if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  };
  if (journal.phase !== "committed") {
    // Staged files that never went live: complete the rename (phase-1 crash
    // AFTER backups were taken is indistinguishable, and completing is the
    // safe direction because the journal only survives a staged commit).
    if (fs.existsSync(staged("authorized_keys"))) {
      backupOnce(p.authorizedKeys);
      fs.renameSync(staged("authorized_keys"), p.authorizedKeys);
    }
    if (fs.existsSync(staged("peer.hostkey"))) {
      backupOnce(p.peerHostkey);
      fs.renameSync(staged("peer.hostkey"), p.peerHostkey);
    }
    // Key cutover (audit fix 8): the four sequential renames ran AFTER the
    // staged files were consumed, so a mid-cutover crash left a journal the
    // old recovery treated as already-done — mixed active keys (new
    // host_key + old bot_key), lane dead until manual repair. Complete the
    // remaining renames exactly as stageAndCommit would have. Gated on the
    // journal's OWN cutover flag so .next keys staged by a LATER arm are
    // never promoted by a lingering older journal.
    if (journal.cutoverSelfKeys === true) {
      for (const [next, active] of [
        [p.hostKeyNext, p.hostKey],
        [p.hostKeyNext + ".pub", p.hostKey + ".pub"],
        [p.botKeyNext, p.botKey],
        [p.botKeyNext + ".pub", p.botKey + ".pub"],
      ] as const) {
        if (!fs.existsSync(next)) continue; // already moved pre-crash
        backupOnce(active);
        fs.renameSync(next, active);
      }
    }
  }
  fs.rmSync(p.stageDir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Rotation cutover — auto-revoke the rotating-from line after the first
// successful authenticated exchange on the new key.
// ---------------------------------------------------------------------------

/** If the verified fingerprint belongs to a `# rotating-from`-marked line
 *  AND a different active key line exists, return the file content with
 *  the marked line removed. Null = nothing to do. */
export function stripRotatingLine(content: string, verifiedFingerprint: string): string | null {
  const lines = content.split(/\r?\n/);
  const markedIdx = lines.findIndex((l) => l.includes("# rotating-from"));
  if (markedIdx < 0) return null;
  try {
    if (fingerprintOfPublicKey(lines[markedIdx]) !== verifiedFingerprint) return null;
  } catch {
    return null;
  }
  const next = lines.filter((_, i) => i !== markedIdx);
  const hasReplacement = next.some((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#") || l.includes("# rotating-from")) return false;
    try {
      return fingerprintOfPublicKey(l) !== verifiedFingerprint;
    } catch {
      return false;
    }
  });
  return hasReplacement ? next.join("\n").replace(/\n+$/, "\n") : null;
}

/** Sweep: drop a marked line older than the grace window whose
 *  replacement never authenticated. */
export function sweepStaleRotation(content: string, now = Date.now()): string | null {
  const lines = content.split(/\r?\n/);
  let changed = false;
  const out = lines.filter((l) => {
    const m = l.match(/# rotating-from (\S+)/);
    if (!m) return true;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) return true;
    if (now - t < ROTATION_GRACE_MS) return true;
    changed = true;
    return false;
  });
  return changed ? out.join("\n").replace(/\n+$/, "\n") : null;
}

// ---------------------------------------------------------------------------
// Display — the tap screen. Peer text is sanitized; the SAS is printed for
// the HUMAN to compare; agents never relay SAS values (by design).
// ---------------------------------------------------------------------------

export function renderTapBlock(s: PairingState, sas: string): string {
  const peer = s.peer;
  const peerName = peer ? sanitizePeerText(peer.name) : "(exchange not complete)";
  const lines = [
    `botlink pairing — mode ${s.mode}, role ${s.role ?? "unassigned"}, status ${s.status}`,
    `peer: ${peerName}`,
  ];
  if (peer) {
    lines.push(`peer HOST KEY fingerprint: ${peer.hostkeyFp}`);
    lines.push(`peer BOT KEY public line:`);
    lines.push(`  ${sanitizePeerText(peer.botPub)}`);
    if (peer.prevBotPub) {
      lines.push(`peer OLD bot key (rotation anchor):`);
      lines.push(`  ${sanitizePeerText(peer.prevBotPub)}`);
    }
  }
  lines.push("");
  lines.push(`SAS (compare BOTH owners' values, each posted by the owner`);
  lines.push(`themselves; agents never relay SAS):  ${sas}`);
  return lines.join("\n");
}
