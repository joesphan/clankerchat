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
import { appendInjectEvent, deriveInjectMetrics, fingerprintOfPublicKey, parseKey, verifyInjectLog } from "./botlink.js";
import { decideAsk, getAsk, listPendingAsks, renderAskForApp } from "./asks.js";
import { journalStats, readJournalTail } from "./journal.js";
import { ackAllNotices, ackNotice, listNotices } from "./notices.js";
import {
  createPhonePrompt,
  historyWindow,
  listPhonePrompts,
  renderPromptForApp,
  type PromptRecord,
} from "./prompts.js";
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
  // Atomic swap (audit finding 3): plain writeFileSync can tear — a torn
  // counters.json makes loadCounters fail-open to {} and silently resets
  // EVERY phone's replay protection. chmod the tmp BEFORE rename so the
  // 0600 mode survives the swap (Windows no-ops chmod either way).
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}; // first boot
    // Corruption, not first boot: fail-open resets replay protection for
    // every previously consumed counter. Atomic writes (above) make this a
    // disk-level event rather than a normal outcome — log it loudly.
    console.error(
      `companion: counters file unreadable (${(err as Error).message}) — replay window reopens for previously seen counters`,
    );
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
  /** Routed prompts (phase 1): true when THIS machine can send to a peer
   *  over the lane. Absent/false → POST /prompt with route:"peer" is refused
   *  at the door — a 30-min honest-expiry lie is worse than a 400 now. */
  canRouteToPeer?: () => boolean;
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

        // --- asks on the phone (owner 2026-10-04 round 4): the enrolled
        // --- phone can SEE pending asks and DECIDE them. It is the same
        // --- gesture class as allowAttempt — and strictly lower stakes (a
        // --- phone can already commit key rotations). Decisions write the
        // --- shared registry with provenance "companion:<fp>"; the gateway
        // --- watcher delivers (message edit + trigger run) and stamps
        // --- enqueuedAt — this surface never delivers, so no double path.
        // --- Two-surface race law (audit round 3): every deciding path goes
        // --- through decideAsk's kernel-atomic O_EXCL claim, and the expiry
        // --- sweep claims too — a tap racing a click or the sweep loses or
        // --- wins cleanly, never both, and never overwrites the other.
        if (method === "GET" && url.pathname === "/asks") {
          const now = Date.now();
          const asks = listPendingAsks(spoolDir)
            .filter((r) => r.status === "pending" && r.expiresAt > now)
            .sort((a, b) => a.createdAt - b.createdAt || (a.askId < b.askId ? -1 : 1)) // same-ms ties break on id — deterministic
            .map(renderAskForApp);
          return json(res, 200, { asks });
        }

        const askM = url.pathname.match(/^\/asks\/([a-z0-9-]+)\/(approve|deny|yolo)$/);
        if (method === "POST" && askM) {
          const existing = getAsk(spoolDir, askM[1]);
          if (!existing) return json(res, 404, { error: "no such ask" });
          if (existing.status !== "pending") {
            // Already decided (Discord click won, an earlier tap, or expiry
            // sweep) — the honest answer is the current status, never a
            // second decision. Covers a same-phone re-tap too.
            log(`companion: ask ${askM[1]} tap arrived after ${existing.status} (${existing.decidedBy ?? "?"}) — nothing changed`);
            return json(res, 409, { error: `already ${existing.status}`, status: existing.status, decidedBy: existing.decidedBy ?? null });
          }
          // Expiry is a hard boundary on every surface (audit round 3,
          // finding 1): the GET above filters expired asks, but a stale card
          // can still drive a POST — past the fuse the sweep owns the ask and
          // no tap may approve what "buttons die at expiry" promised.
          if (existing.expiresAt <= Date.now()) {
            log(`companion: ask ${askM[1]} tap arrived AFTER expiry (sweep owns it) — nothing changed`);
            return json(res, 409, { error: "ask expired — the expiry sweep owns it", status: "expired" });
          }
          // Three-verb map (c2a7ebe contract): yolo = one-shot full-auto, NOT
          // a deny-else default — the binary map here would have silently
          // recorded YOLO taps as denials, the exact bug class caught on the
          // watcher's button path (round 11).
          const rec = decideAsk(
            spoolDir,
            askM[1],
            askM[2] === "approve" ? "approved" : askM[2] === "yolo" ? "yolo" : "denied",
            `companion:${v.phone.id}`,
          );
          if (!rec || rec.status === "pending") return json(res, 500, { error: "decision failed to record" });
          if (rec.decidedBy !== `companion:${v.phone.id}`) {
            // LOST the O_EXCL claim: a click or another surface decided first
            // (audit round 3, finding 5 — this used to answer 200 and log the
            // decision as THIS phone's). Report the winner's verdict honestly.
            log(`companion: ask ${askM[1]} tap LOST the decision race to ${rec.decidedBy} (${rec.status}) — reporting theirs`);
            return json(res, 409, { error: `already ${rec.status}`, status: rec.status, decidedBy: rec.decidedBy ?? null });
          }
          log(`companion: ask ${askM[1]} ${rec.status} by ${v.phone.id} — delivery pending watcher sweep`);
          return json(res, 200, { status: rec.status, askId: rec.askId });
        }

        // --- prompts from the phone (round 5, 2026-10-04): the same trust
        // --- class as ask decisions, aimed the other way — the enrolled
        // --- phone STARTS work instead of gating it. This surface writes a
        // --- prompt record and never delivers: the watcher's 15s sweep
        // --- claims it and enqueues an owner-priority run; the answer lands
        // --- in Discord (the owner's app push-notifies), the phone polls
        // --- status only. Text is data like any Discord content.
        if (method === "GET" && url.pathname === "/prompts") {
          const now = Date.now();
          // ?q= searches the WHOLE registry (promptId or text substring,
          // case-insensitive) — "that thing I asked Tuesday" without scroll.
          // ?before=<createdAt ms> pages OLDER history (round 7): the phone's
          // SENT list loads the newest 20, then walks back by cursor. The two
          // never compose — search is bounded at 50 already. No query keeps
          // the round-5 contract: active + recent chips, newest 20. `more`
          // says whether an older page exists under this branch.
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
          const beforeRaw = url.searchParams.get("before");
          const before = beforeRaw === null ? null : Number(beforeRaw);
          if (q) {
            const prompts = listPhonePrompts(spoolDir)
              .filter(
                (r) =>
                  r.promptId.toLowerCase().includes(q) ||
                  r.text.toLowerCase().includes(q),
              )
              .slice(-50) // newest 50 matches — bounded even on a big registry
              .map(renderPromptForApp);
            return json(res, 200, { prompts, more: false });
          }
          if (before !== null) {
            // Present-but-invalid cursor is a client bug, not "no cursor" —
            // answering the default list would silently page WRONG history.
            if (!Number.isFinite(before) || before <= 0) {
              return json(res, 400, { error: "before must be a positive createdAt epoch-ms" });
            }
            const limit = Number(url.searchParams.get("limit") ?? 20);
            const { records, more } = historyWindow(
              listPhonePrompts(spoolDir),
              before,
              Number.isFinite(limit) ? limit : 20,
            );
            return json(res, 200, { prompts: records.map(renderPromptForApp), more });
          }
          const eligible = listPhonePrompts(spoolDir).filter(
            (r) =>
              r.status === "pending" ||
              r.status === "enqueued" ||
              (r.finishedAt ?? 0) > now - 30 * 60 * 1000, // recent history chips
          );
          return json(res, 200, {
            prompts: eligible.slice(-20).map(renderPromptForApp), // newest 20 — a scroll, not the registry
            more: eligible.length > 20,
          });
        }

        // --- notices (round 8, owner 2026-10-04 "let me know not in discord
        // --- but just on the phone"): machine→phone reports. The phone READS
        // --- and ACKS — the writers are local processes (sessions/daemon/
        // --- the notice CLI) on the spool file, never this surface. Newest
        // --- `limit` in registry order (oldest-first, like /prompts — the
        // --- app reverses for display) plus an UNACKED count over the WHOLE
        // --- registry so the badge stays honest when the window is all-read.
        if (method === "GET" && url.pathname === "/notices") {
          const limitRaw = Number(url.searchParams.get("limit") ?? 10);
          const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 10;
          const all = listNotices(spoolDir);
          const notices = all.slice(-limit).map((r) => ({
            id: r.id,
            ts: r.ts,
            from: r.from,
            text: r.text,
            severity: r.severity,
            acked: r.ackedAt != null,
          }));
          return json(res, 200, { notices, unacked: all.filter((r) => !r.ackedAt).length });
        }
        const noticeAckAll = method === "POST" && url.pathname === "/notices/ack-all";
        if (noticeAckAll) {
          const acked = ackAllNotices(spoolDir);
          log(`companion: ack-all notices by ${v.phone.id} — ${acked} dismissed`);
          return json(res, 200, { acked });
        }
        const noticeM = url.pathname.match(/^\/notices\/([a-z0-9]+)\/ack$/);
        if (method === "POST" && noticeM) {
          const rec = ackNotice(spoolDir, noticeM[1]);
          if (!rec) return json(res, 404, { error: "no such notice" });
          return json(res, 200, { ok: true });
        }

        if (method === "GET" && url.pathname === "/machine") {
          // Lane health rides the AUDIT LOG, not the watcher: median
          // received→consumed for injects this machine has handled. It stays
          // true when the watcher dies (exactly when the card needs facts
          // most) — chain-verified first, omitted honestly when absent.
          let laneHealthMs: number | null = null;
          let lanePaired = 0;
          try {
            const metrics = deriveInjectMetrics(verifyInjectLog(spoolDir));
            laneHealthMs = metrics.medianReceivedToConsumedMs;
            lanePaired = metrics.receivedToConsumedMs.length;
          } catch {
            /* absent or chain-broken log — the card renders "no paired events" */
          }
          // Doctor-subset escalations (TODO round): the FAIL lines a pocket
          // owner can act on — stuck pending prompts + undelivered
          // phone-decided asks, the same file scans the CLI doctor runs,
          // inlined so the card turns red the moment delivery health breaks.
          // Metro/bundle freshness stays CLI-only: a 2s poll must not curl
          // the dev server.
          const alerts: string[] = [];
          try {
            const pDir = path.join(spoolDir, "pending-prompts");
            if (fs.existsSync(pDir)) {
              const stuck = fs.readdirSync(pDir).filter((f) => {
                if (!f.endsWith(".json")) return false;
                try {
                  const rec = JSON.parse(fs.readFileSync(path.join(pDir, f), "utf8"));
                  return rec.status === "pending" && Date.now() - rec.createdAt > 60_000;
                } catch {
                  return false;
                }
              });
              if (stuck.length > 0) alerts.push(`${stuck.length} prompt(s) pending >60s — watcher sweep down?`);
            }
          } catch {
            /* scan failure is not itself an alert */
          }
          try {
            const aDir = path.join(spoolDir, "pending-asks");
            if (fs.existsSync(aDir)) {
              const undelivered = fs.readdirSync(aDir).filter((f) => {
                if (!f.endsWith(".json")) return false;
                try {
                  const rec = JSON.parse(fs.readFileSync(path.join(aDir, f), "utf8"));
                  return rec.status && rec.status !== "pending" && !rec.enqueuedAt && String(rec.decidedBy ?? "").startsWith("companion:");
                } catch {
                  return false;
                }
              });
              if (undelivered.length > 0) alerts.push(`${undelivered.length} phone-decided ask(s) undelivered — sweep down?`);
            }
          } catch {
            /* same */
          }
          // S-tier #4/#5 (2026-10-04): the interaction journal is local
          // security truth — refused interactions (non-approver button
          // probes, quarantined venues) and classified audit events surface
          // on the card the same way delivery failures do. Chain-broken or
          // absent journal → silence (readJournalTail never throws here).
          try {
            const stats = journalStats(readJournalTail(spoolDir, 500));
            if (stats.refused > 0) {
              alerts.push(`${stats.refused} refused interaction(s) last 24h — see daemon.log / interaction-journal`);
            }
            if (stats.criticalAudit > 0) {
              alerts.push(`${stats.criticalAudit} critical audit event(s) last 24h — see interaction-journal`);
            }
            // Round 16: webhook posts + identity-spoof refusals — display-
            // identity events that never triggered but ARE the spoof class.
            if (stats.noise > 0) {
              alerts.push(`${stats.noise} identity-noise event(s) last 24h (webhook/spoof) — see interaction-journal`);
            }
          } catch {
            /* journal read is best-effort card decoration */
          }
          // Round 6 (pocket lane dashboard): the watcher's published state —
          // pool, queues, lane verdict, idle time. Facts only, no secrets, no
          // channel ids. An absent or stale file is HONEST on the wire
          // (stale: true) rather than an error — a stopped watcher is itself
          // a fact worth showing.
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(spoolDir, "watcher-state.json"), "utf8")) as Record<string, unknown>;
            const ageMs = typeof raw.updated === "string" ? Date.now() - Date.parse(raw.updated) : NaN;
            const lane = (raw.lane ?? null) as Record<string, unknown> | null;
            // S-tier #5: the audit watch's live alert lines (bounded by the
            // writer) ride the card exactly when the watcher is alive to
            // classify them — a dead watcher shows its own staleness instead.
            const auditAlerts = Array.isArray(raw.audit_alerts)
              ? (raw.audit_alerts as unknown[]).filter((a): a is string => typeof a === "string").slice(0, 5)
              : [];
            alerts.push(...auditAlerts);
            return json(res, 200, {
              machine: {
                active: Number(raw.active ?? 0),
                queuedHuman: Number(raw.queued_human ?? 0),
                queuedBot: Number(raw.queued_bot ?? 0),
                maxConcurrent: Number(raw.max_concurrent ?? 0),
                laneOk: lane ? Boolean(lane.ok) : null,
                lanePeer: lane && typeof lane.bot === "string" ? lane.bot : null,
                lanePending: lane ? Number(lane.pending ?? 0) : 0,
                // Peer's last-run time, relayed by the watcher's lane heartbeat
                // (multi-machine prompts phase 0): additive, null-honest.
                lanePeerLastRunAt:
                  lane && typeof lane.peerLastRunAt === "string" ? lane.peerLastRunAt : null,
                lastRunAt: typeof raw.last_run_at === "string" ? raw.last_run_at : null,
                updated: typeof raw.updated === "string" ? raw.updated : null,
                stale: !(ageMs === ageMs && ageMs < 300_000), // NaN (no timestamp) or >5min → stale
                laneHealthMs,
                lanePaired,
                alerts,
              },
            });
          } catch {
            return json(res, 200, { machine: { stale: true, laneHealthMs, lanePaired, alerts } });
          }
        }

        if (method === "POST" && url.pathname === "/prompt") {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
          } catch {
            return json(res, 400, { error: "body is not JSON" });
          }
          if (typeof msg.text !== "string" || !msg.text.trim()) {
            return json(res, 400, { error: "text required" });
          }
          // Routed prompts (phase 1): route:"peer" asks the PEER machine to
          // run this. Refused here — not expired later — when the lane isn't
          // configured; any other route value is refused outright (the phone
          // must never believe a prompt routed somewhere it didn't).
          if (msg.route !== undefined && msg.route !== "peer") {
            return json(res, 400, { error: `unknown route — only "peer" is routable` });
          }
          if (msg.route === "peer" && !opts.canRouteToPeer?.()) {
            log(`companion: routed prompt from ${v.phone.id} refused — no lane configured on this machine`);
            return json(res, 400, { error: "this machine has no peer lane configured — route unavailable" });
          }
          let rec: PromptRecord;
          try {
            rec = createPhonePrompt(spoolDir, {
              text: msg.text,
              fp: v.phone.id,
              ...(msg.route === "peer" ? { route: "peer" as const } : {}),
            });
          } catch (err) {
            const e = (err as Error).message;
            const full = e.includes("queue full");
            log(`companion: prompt from ${v.phone.id} refused — ${e}`);
            return json(res, full ? 429 : 400, { error: e });
          }
          log(`companion: prompt ${rec.promptId} from ${v.phone.id} (${rec.text.length} chars${rec.route ? `, route ${rec.route}` : ""}) — pickup pending watcher sweep`);
          return json(res, 200, { promptId: rec.promptId, status: rec.status, route: rec.route ?? null });
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
