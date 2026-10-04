/**
 * companion — the phone surface for pairing confirmations
 * (docs/companion-app.md). The one gesture it owns: an enrolled owner's
 * phone can VIEW a completed pairing exchange and ALLOW/DENY the pin
 * commit — nothing else.
 *
 *   - Separate third surface: main SSH listener (status/inject) and the
 *     ephemeral pairing listener are untouched; this is a plain-HTTP
 *     listener on main port + 2 whose ONLY verbs are enroll / attempts /
 *     allow / deny.
 *   - Authentication mirrors the lane's key philosophy at phone scale: at
 *     enrollment the phone generates its OWN Ed25519 keypair and the
 *     machine pins only the public line (companion-keys/<fp>.pub). No
 *     secret ever crosses in either direction; revocation = delete one
 *     file. Every request is signed over a length-delimited
 *     ("clanker-companion-v1", method, path, sha256(body), counter)
 *     message with a per-phone MONOTONIC counter persisted server-side —
 *     replay, tamper, and unknown-key all fail closed.
 *   - ALLOW reuses the exact CLI commit path (buildConfirmPlan +
 *     stageAndCommit + audit append); the typed-SAS transcription check is
 *     identical, so the phone gesture carries the same MITM-detection
 *     burden the terminal does. The phone may DISPLAY the SAS but has no
 *     path that transmits it (no share/copy/push — the agents-never-relay
 *     law extends to apps).
 *   - Honest boundary (docs/companion-app.md): QR enrollment binds the
 *     phone channel to physical access of the machine's display; phone
 *     unlock + typed SAS is intent-gathering of the same class as the
 *     TTY. Neither claims proof against local code exec.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { appendInjectEvent, fingerprintOfPublicKey, parseKey } from "./botlink.js";
import {
  attemptIdOfState,
  buildConfirmPlan,
  clearPairingState,
  lenDelim,
  loadPairingState,
  normalizeSasInput,
  PAIRING_TTL_MS,
  sanitizePeerText,
  sasOfState,
  stageAndCommit,
  stateIsLive,
  verifyEd25519,
  type KeydirPaths,
  type PairingState,
} from "./pairing.js";

export const COMPANION_ENROLL_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 8192; // enroll/allow/deny payloads are tiny

// ---------------------------------------------------------------------------
// Store — companion-keys/ next to the botlink keydir (0600, gitignored).
// ---------------------------------------------------------------------------

export interface CompanionStore {
  dir: string;
  /** Active enrollment token (single-use, TTL) — deleted on consumption. */
  enrollFile: string;
  /** Per-phone last-seen counter (anti-replay), keyed by phone fingerprint. */
  countersFile: string;
}

export function companionStore(dir: string): CompanionStore {
  return { dir, enrollFile: path.join(dir, "enroll.json"), countersFile: path.join(dir, "counters.json") };
}

/** Default store location for a keydir: <keydir>/companion-keys/. */
export function defaultCompanionStore(keydir: string): CompanionStore {
  return companionStore(path.join(keydir, "companion-keys"));
}

/** Filesystem-safe form of a fingerprint id (SHA256:+/ chars break Windows paths). */
function fsSafeId(id: string): string {
  return id.replace(/[:+/]/g, "_");
}

function writePrivate(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // chmod after write (Windows no-ops it)
  } catch {
    /* best effort */
  }
}

/** Mint the one-time enrollment token printed in the terminal QR. */
export function issueEnrollToken(store: CompanionStore): { token: string; expiresAt: number } {
  const rec = { token: crypto.randomBytes(32).toString("hex"), expiresAt: Date.now() + COMPANION_ENROLL_TTL_MS };
  writePrivate(store.enrollFile, JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

function timingSafeHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Single-use + TTL. A wrong token does NOT consume the real one (the
 *  caller logs the attempt; the token itself is 256-bit). */
export function consumeEnrollToken(store: CompanionStore, token: string): boolean {
  let rec: { token?: unknown; expiresAt?: unknown };
  try {
    rec = JSON.parse(fs.readFileSync(store.enrollFile, "utf8")) as typeof rec;
  } catch {
    return false;
  }
  const want = typeof rec.token === "string" && /^[0-9a-f]{64}$/.test(rec.token) ? rec.token : "";
  const got = /^[0-9a-f]{64}$/.test(token) ? token : "";
  const live = typeof rec.expiresAt === "number" && Date.now() < rec.expiresAt;
  const ok = want.length === 64 && got.length === 64 && live && timingSafeHex(want, got);
  if (ok) fs.rmSync(store.enrollFile, { force: true });
  return ok;
}

/** Phone public line schema — same discipline as peer values in pairing. */
export function validatePhonePub(line: string): string {
  if (typeof line !== "string" || line.length > 600 || /[\r\n]/.test(line) || !/^\S+ \S+( \S.*)?$/.test(line)) {
    throw new Error('companion: bad "phonePub" (want a single-line OpenSSH public key)');
  }
  try {
    parseKey(line);
  } catch (err) {
    throw new Error(`companion: "phonePub" is not a parseable public key: ${(err as Error).message}`);
  }
  return line.trim();
}

/** Pin a phone key; returns its fingerprint (the X-Companion-Id). Re-enrolling
 *  the same key is idempotent; revocation is deleting the pin file. */
export function enrollPhone(store: CompanionStore, phonePubLine: string): string {
  const line = validatePhonePub(phonePubLine);
  const id = fingerprintOfPublicKey(line);
  writePrivate(path.join(store.dir, `${fsSafeId(id)}.pub`), line + "\n");
  return id;
}

function loadCounters(store: CompanionStore): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(store.countersFile, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Request authentication — Ed25519 over a length-delimited canonical message.
// ---------------------------------------------------------------------------

/** The signed message. Both sides construct it identically: domain label,
 *  method, path, sha256(body) hex, decimal counter — length-delimited so no
 *  field can bleed into the next. */
export function companionRequestMessage(method: string, urlPath: string, bodyShaHex: string, counter: string): Buffer {
  return lenDelim("clanker-companion-v1", method.toUpperCase(), urlPath, bodyShaHex, counter);
}

export interface VerifiedPhone {
  id: string;
  counter: number;
}

export type VerifyResult = { ok: true; phone: VerifiedPhone } | { ok: false; status: number; error: string };

/** Verify + CONSUME the counter (at verify time, before any handler runs —
 *  a request that passes auth but crashes mid-commit can never be replayed). */
export function verifyCompanionRequest(
  store: CompanionStore,
  headers: { id?: string; counter?: string; sig?: string },
  method: string,
  urlPath: string,
  body: Buffer,
): VerifyResult {
  const id = headers.id ?? "";
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(id)) return { ok: false, status: 401, error: "bad X-Companion-Id" };
  let pin: string;
  try {
    pin = fs.readFileSync(path.join(store.dir, `${fsSafeId(id)}.pub`), "utf8");
  } catch {
    return { ok: false, status: 401, error: "unknown phone" };
  }
  const counter = headers.counter ?? "";
  if (!/^[0-9]{1,16}$/.test(counter)) return { ok: false, status: 401, error: "bad X-Counter" };
  const sig = headers.sig ?? "";
  if (!/^[A-Za-z0-9+/=]+$/.test(sig)) return { ok: false, status: 401, error: "bad X-Sig" };
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  const msg = companionRequestMessage(method, urlPath, bodySha, counter);
  if (!verifyEd25519(pin, msg, sig)) return { ok: false, status: 401, error: "signature FAILED" };
  const n = Number(counter);
  const counters = loadCounters(store);
  if (n <= (counters[id] ?? 0)) return { ok: false, status: 403, error: "stale/replayed counter" };
  counters[id] = n;
  writePrivate(store.countersFile, JSON.stringify(counters, null, 2) + "\n");
  return { ok: true, phone: { id, counter: n } };
}

// Small seam so the import stays one-directional at module scope while the
// verify entry point stays lazy (mirrors botlink -> pairing's lazy pulls).
import * as pairingVerify from "./pairing.js";

// ---------------------------------------------------------------------------
// Attempt rendering + allow/deny — the only state-touching verbs.
// ---------------------------------------------------------------------------

/** Sanitized JSON rendering of the live confirmable exchange for GET
 *  /attempts. Null when there is nothing confirmable. */
export function renderAttempt(s: PairingState): Record<string, unknown> | null {
  const attemptId = attemptIdOfState(s);
  const sas = sasOfState(s);
  if (attemptId === null || sas === null) return null;
  return {
    attemptId,
    mode: s.mode,
    role: s.role ?? null,
    status: s.status,
    peer: s.peer
      ? {
          name: sanitizePeerText(s.peer.name),
          hostkeyFp: s.peer.hostkeyFp,
          botPub: sanitizePeerText(s.peer.botPub),
          prevBotPub: s.peer.prevBotPub ? sanitizePeerText(s.peer.prevBotPub) : null,
        }
      : null,
    // The SAS for the owner's OWN screen comparison — display only; the app
    // has no share/copy/push path (agents — and apps — never relay SAS).
    sas,
    expiresAt: s.armedAt + PAIRING_TTL_MS,
  };
}

export interface AllowOutcome {
  changes: string[];
  alreadyPinned: boolean;
}

/** ALLOW = the CLI's `pair --confirm`, minus the TTY: same liveness,
 *  attemptId, typed-SAS transcription check, journaled two-phase commit,
 *  single-use semantics, and audit append (with via=companion:<phone>). */
export async function allowAttempt(
  p: KeydirPaths,
  spoolDir: string,
  phoneId: string,
  attemptId: string,
  typedSas: string,
  log: (line: string) => void,
): Promise<AllowOutcome> {
  const s = loadPairingState(p);
  if (!s || !stateIsLive(s)) throw new Error("no live pairing state (arm again; TTL is 10 minutes)");
  if (attemptIdOfState(s) !== attemptId) throw new Error("attemptId does not match the live exchange");
  const sas = sasOfState(s);
  if (sas === null) throw new Error("exchange not complete");
  if (normalizeSasInput(typedSas) !== normalizeSasInput(sas)) {
    throw new Error(
      "SAS transcription mismatch — refusing. (If the two SCREENS differ, do NOT retry: report a possible MITM.)",
    );
  }
  const plan = buildConfirmPlan(p, s);
  if (plan.changes.length === 0) {
    clearPairingState(p); // single-use: same semantics as the CLI confirm
    return { changes: [], alreadyPinned: true };
  }
  stageAndCommit(p, plan, new Date().toISOString().replace(/[:.]/g, ""));
  clearPairingState(p);
  // Audit-only (identical policy to the CLI): a failure is loud but never
  // undoes the committed pins.
  try {
    await appendInjectEvent(spoolDir, {
      event: s.mode === "rotate" ? "rotated" : "paired",
      id: `pair-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      source: sanitizePeerText(s.peer!.name),
      target: "pairing",
      detail: `hostkey ${s.peer!.hostkeyFp}, bot ${fingerprintOfPublicKey(s.peer!.botPub)}, via=companion:${phoneId}`,
    });
  } catch (auditErr) {
    log(`companion allow: AUDIT APPEND FAILED: ${(auditErr as Error).message} — pins are committed, the log entry is lost`);
  }
  return { changes: plan.changes, alreadyPinned: false };
}

/** DENY = the CLI's declined answer: clear state, write nothing. */
export function denyAttempt(p: KeydirPaths, attemptId: string): void {
  const s = loadPairingState(p);
  if (!s) throw new Error("no pairing state to deny");
  if (attemptIdOfState(s) !== attemptId) throw new Error("attemptId does not match the live exchange");
  clearPairingState(p);
}

// ---------------------------------------------------------------------------
// HTTP listener — enroll (token-gated) + three signed routes.
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body over cap"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function startCompanionServer(opts: {
  bind: string;
  port: number;
  paths: KeydirPaths;
  spoolDir: string;
  store: CompanionStore;
  log: (line: string) => void;
}): { close: () => void; port: number } {
  const { store, paths, spoolDir, log } = opts;
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://companion.local");
      const method = req.method ?? "GET";
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 413, { error: "body over cap" });
      }
      try {
        // --- the only unauthenticated route: its own gate is the one-time
        // --- QR token, valid once for 10 minutes.
        if (method === "POST" && url.pathname === "/enroll") {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
          } catch {
            return json(res, 400, { error: "body is not JSON" });
          }
          const token = typeof msg.token === "string" ? msg.token : "";
          const phonePub = typeof msg.phonePub === "string" ? msg.phonePub : "";
          let line: string;
          try {
            line = validatePhonePub(phonePub);
          } catch (err) {
            return json(res, 400, { error: (err as Error).message } );
          }
          if (!consumeEnrollToken(store, token)) {
            log("companion: refused an enrollment (bad/expired token)");
            return json(res, 403, { error: "enrollment token invalid or expired" });
          }
          const id = enrollPhone(store, line);
          log(`companion: enrolled phone ${id}`);
          return json(res, 200, { id });
        }

        // --- everything else: signed + counter-protected ---
        const v = verifyCompanionRequest(
          store,
          { id: header(req, "x-companion-id"), counter: header(req, "x-counter"), sig: header(req, "x-sig") },
          method,
          url.pathname,
          body,
        );
        if (!v.ok) {
          log(`companion: ${method} ${url.pathname} refused — ${v.error}`);
          return json(res, v.status, { error: v.error });
        }

        if (method === "GET" && url.pathname === "/attempts") {
          const s = loadPairingState(paths);
          const attempt = s && stateIsLive(s) ? renderAttempt(s) : null;
          return json(res, 200, attempt ?? {});
        }

        const allowM = url.pathname.match(/^\/attempts\/([0-9a-f]{1,64})\/allow$/);
        if (method === "POST" && allowM) {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
          } catch {
            return json(res, 400, { error: "body is not JSON" });
          }
          const typed = typeof msg.sas === "string" ? msg.sas.slice(0, 16) : "";
          try {
            const out = await allowAttempt(paths, spoolDir, v.phone.id, allowM[1], typed, log);
            log(`companion: allow by ${v.phone.id} — ${out.changes.length ? out.changes.join(", ") : "nothing to change"}`);
            return json(res, 200, { changes: out.changes, alreadyPinned: out.alreadyPinned });
          } catch (err) {
            log(`companion: allow REFUSED — ${(err as Error).message}`);
            return json(res, 403, { error: (err as Error).message });
          }
        }

        const denyM = url.pathname.match(/^\/attempts\/([0-9a-f]{1,64})\/deny$/);
        if (method === "POST" && denyM) {
          try {
            denyAttempt(paths, denyM[1]);
            log(`companion: deny by ${v.phone.id} — state cleared, nothing written`);
            return json(res, 200, { ok: true });
          } catch (err) {
            return json(res, 403, { error: (err as Error).message });
          }
        }

        return json(res, 404, { error: "no such route" });
      } catch (err) {
        log(`companion: internal error — ${(err as Error).message}`);
        return json(res, 500, { error: "internal" });
      }
    })();
  });
  server.listen(opts.port, opts.bind);
  server.on("error", (err: Error) => log(`companion listener error: ${err.message}`));
  const handle = {
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
