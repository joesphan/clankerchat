/**
 * botlink — private SSH channel between two machines' clankerchat bots.
 *
 * Discord is the human-readable log; botlink is the machine lane. One
 * daemon per machine (`botlink-server`) listens on SSH and accepts exactly
 * two verbs from the peer bot's dedicated key:
 *
 *   status        → JSON health snapshot (uptime, spool depth, inject count)
 *   inject <json> → deliver a prompt payload to this machine's trigger layer
 *                   via a spool file. The local watcher/overseer consumes the
 *                   spool and treats an inject exactly like a bot-authored
 *                   tag: untrusted input, elevated scrutiny, human tags
 *                   always keep priority. A payload may carry one FILE
 *                   (≤2 MB, size+sha256 verified, leak-scanned both ends,
 *                   stored under a receiver-controlled path) — files cross
 *                   machines on this lane, never as Discord attachments.
 *
 * Auth model: publickey ONLY, one dedicated keypair per bot (never a human's
 * key), username pinned, host key pinned by fingerprint on the client side
 * (no trust-on-first-use). No shell, no pty, no forwarding — a connection
 * can run those two verbs and nothing else. Config comes from the launch
 * environment, same rule as the project-mode hardening keys.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
// ssh2 is CJS with lexer-opaque exports — default-import + destructure is the
// form Node's ESM-CJS interop reliably accepts for it.
import type { ParsedKey } from "ssh2";
const { Client: SshClient, Server: SshServer, utils } = ssh2;
import { z } from "zod";
import { findLeakSignals, leakRefusal } from "./leaks.js";

export const BOTLINK_PORT_DEFAULT = 47421;
export const BOTLINK_USER_DEFAULT = "clanker";
export const BOTLINK_MAX_TEXT = 4000;
// File-carrying injects: the lane moves prompts and small artifacts (a
// patch, a log, a config), not arbitrary datasets — 2 MB decoded is the
// deliberate ceiling on both ends.
export const BOTLINK_MAX_FILE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Keys — ed25519 generation + OpenSSH wire format, pure crypto so it works
// anywhere Node works (no ssh-keygen dependency, Windows included).
// ---------------------------------------------------------------------------

export interface BotKeyPair {
  privatePem: string; // -----BEGIN OPENSSH PRIVATE KEY-----
  publicLine: string; // ssh-ed25519 AAAA... comment
  fingerprint: string; // SHA256:… (of the public blob)
}

/** Generate a dedicated bot keypair (identity or host key), OpenSSH format. */
export function generateBotKey(comment: string): BotKeyPair {
  // ssh2's own generator emits containers its parser/signer handle by
  // construction — and OpenSSH itself accepts them (verified against
  // ssh-keygen). No hand-rolled wire format to drift out of spec.
  //
  // EXCEPT, intermittently, it doesn't: ~0.4% of ed25519 pairs (8/2000
  // observed) come out with a dropped length prefix in the private section —
  // ssh2's parser AND `ssh-keygen -y` both reject the file ("invalid
  // format"). Self-verify every pair (parse both halves, cross-check the
  // derived public blob against the public line) and regenerate on failure:
  // keygen runs once per bot, so the retry costs nothing and a malformed
  // key never ships to a place where the daemon boots on it.
  for (let attempt = 0; ; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519", { comment }) as unknown as {
      public: string;
      private: string;
    };
    const want = pair.public.trim().split(" ")[1];
    try {
      const privOk =
        Buffer.from(parseKey(pair.private).getPublicSSH()).toString("base64") === want;
      const pubOk =
        Buffer.from(parseKey(pair.public).getPublicSSH()).toString("base64") === want;
      if (privOk && pubOk) {
        return {
          privatePem: pair.private,
          publicLine: pair.public.trim(),
          fingerprint: fingerprintOfPublicKey(pair.public),
        };
      }
    } catch {
      /* unparseable pair — retry with a fresh one */
    }
    if (attempt >= 8) {
      throw new Error(
        `bot keygen self-verify failed after ${attempt + 1} attempts — ssh2's generator keeps emitting unparseable OpenSSH containers`,
      );
    }
  }
}

/** SHA256 fingerprint of a public key (blob base64, public line, or raw). */
export function fingerprintOfPublicKey(publicMaterial: string): string {
  const token = publicMaterial
    .trim()
    .split(/\s+/)
    .find((t) => t.length > 40 && /^[A-Za-z0-9+/=]+$/.test(t));
  if (!token) throw new Error("not a public key (expected a base64 blob or an ssh-* public line)");
  const hash = crypto.createHash("sha256").update(Buffer.from(token, "base64")).digest("base64");
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

export function parseKey(material: string): ParsedKey {
  // ssh2's parseKey RETURNS an Error on failure instead of throwing it.
  const key = utils.parseKey(material.trim()) as unknown;
  if (key instanceof Error) throw new Error(`key unparseable: ${key.message}`);
  if (!key) throw new Error("key unparseable (empty result)");
  return key as ParsedKey;
}

// ---------------------------------------------------------------------------
// Inject audit log — append-only, hash-chained. Every inject "received" (by
// the daemon) and "consumed" (by the trigger layer) appends one JSON line to
// <spoolDir>/inject.log; each entry's hash covers its predecessor, so
// post-hoc edits, reorders, and deletions are detectable by replay. This is
// the audit trail delete-after-queueing would have destroyed.
// ---------------------------------------------------------------------------

// Serializes appendInjectEvent's read-prev/append inside this process.
let appendQueue: Promise<void> = Promise.resolve();

/** Structured lineage on a log entry — covered by the entry's hash, unlike
 *  free-form `detail` (which metrics must not depend on for the same reason). */
export interface InjectEventMeta {
  reply_to?: string;
  correlation?: string;
  supersedes?: string;
}

export function appendInjectEvent(
  spoolDir: string,
  evt: {
    event: string; // "received" | "consumed" are the lane's own; receivers may append lifecycle events ("completed", …)
    id: string;
    source: string;
    target: string;
    detail?: string;
    meta?: InjectEventMeta;
  },
): Promise<void> {
  // Serialize read-prev/append inside this process: two connections landing
  // injects simultaneously could otherwise interleave and break the chain.
  // (A cross-PROCESS race — daemon vs. trigger layer — still exists but is
  // detectable: verifyInjectLog throws, fail-visible not fail-silent.)
  const flush = appendQueue.then(() => {
    const logPath = path.join(spoolDir, "inject.log");
    let prev = ""; // genesis entry chains from the empty string
    try {
      const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) prev = String(JSON.parse(lines[lines.length - 1]).hash ?? "");
    } catch {
      /* no log yet — genesis */
    }
    const body = { ...evt, ts: new Date().toISOString(), prev };
    const hash = crypto.createHash("sha256").update(prev + JSON.stringify(body)).digest("hex");
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ ...body, hash })}\n`);
    // Head-hash artifact (their reviewer's tail-truncation catch): deleting
    // the NEWEST line(s) leaves a valid shorter chain the replay alone can't
    // see. The .head file records the last appended hash; verify compares.
    fs.writeFileSync(path.join(spoolDir, "inject.log.head"), hash + "\n");
  });
  // The queue HEAD must survive a failed append: .then() on a rejected
  // promise skips its work, so one EBUSY/ENOSPC would freeze the audit
  // trail forever while ACKs kept flowing (their reviewer's catch, 2026-10-02).
  // Branch instead — head absorbs failures, the returned promise doesn't, so
  // this caller still sees its own flush fail (the daemon journals it).
  appendQueue = flush.catch(() => {});
  return flush;
}

/** Replay inject.log and verify the hash chain. Returns entries, or throws. */
export function verifyInjectLog(
  spoolDir: string,
): Array<{ event: string; id: string; hash: string; ts?: string; source?: string; target?: string; detail?: string; meta?: InjectEventMeta }> {
  const lines = fs.readFileSync(path.join(spoolDir, "inject.log"), "utf8").split("\n").filter(Boolean);
  let prev = "";
  const out: Array<{ event: string; id: string; hash: string; ts?: string; source?: string; target?: string; detail?: string; meta?: InjectEventMeta }> = [];
  for (const line of lines) {
    const entry = JSON.parse(line);
    const { hash, ...body } = entry;
    if (hash !== crypto.createHash("sha256").update(prev + JSON.stringify(body)).digest("hex")) {
      throw new Error(`inject.log chain broken at entry ${entry.id ?? "?"} (ts ${entry.ts ?? "?"})`);
    }
    if (body.prev !== prev) throw new Error(`inject.log chain order broken at ${entry.id ?? "?"}`);
    prev = hash;
    out.push(entry);
  }
  // Tail-truncation guard: the chain replays valid without its newest line(s),
  // so the last appended hash is persisted beside the log. Mismatch = entries
  // were removed from the end. (No .head file = pre-artifact log; can't
  // distinguish "never written" from "deleted" — replay alone governs.)
  if (lines.length > 0) {
    try {
      const head = fs.readFileSync(path.join(spoolDir, "inject.log.head"), "utf8").trim();
      if (head && head !== prev) {
        throw new Error(`inject.log tail truncated: head artifact ${head.slice(0, 12)}… ≠ last entry ${prev.slice(0, 12)}… (${lines.length} entries replay)`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("inject.log tail")) throw err;
      /* unreadable/absent head file — legacy log, replay verdict stands */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lane metrics — derived purely from the audit log (no extra bookkeeping).
// What the log can't see (merge outcomes in git) lands via lifecycle events
// the receiving side appends; derive what exists, never invent the rest.
// ---------------------------------------------------------------------------

export interface InjectMetrics {
  injects: number;
  bySource: Record<string, number>;
  byTarget: Record<string, number>;
  receivedToConsumedMs: number[]; // per inject that has both events, in order
  medianReceivedToConsumedMs: number | null;
  completed: Array<{ id: string; detail?: string }>;
  reworkRounds: number; // injects sharing a reply_to beyond the first
}

export function deriveInjectMetrics(
  entries: Array<{ event: string; id: string; ts?: string; source?: string; target?: string; detail?: string; meta?: InjectEventMeta }>,
): InjectMetrics {
  const bySource: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  const receivedAt = new Map<string, number>();
  const consumedAt = new Map<string, number>();
  const completed: Array<{ id: string; detail?: string }> = [];
  const replyTo = new Map<string, number>();
  let injects = 0;
  for (const e of entries) {
    const ts = e.ts ? Date.parse(e.ts) : NaN;
    if (e.event === "received") {
      injects++;
      const s = e.source ?? "?";
      const t = e.target ?? "?";
      bySource[s] = (bySource[s] ?? 0) + 1;
      byTarget[t] = (byTarget[t] ?? 0) + 1;
      if (!Number.isNaN(ts)) receivedAt.set(e.id, ts);
    } else if (e.event === "consumed" && !Number.isNaN(ts)) {
      consumedAt.set(e.id, ts);
    } else if (e.event === "completed") {
      completed.push({ id: e.id, detail: e.detail });
    }
    if (e.event === "received") {
      // Structured field first (hash-covered); regex on free-form detail only
      // as a legacy fallback — format drift there silently zeroes, which is
      // exactly why the field exists now.
      const rt = e.meta?.reply_to ?? e.detail?.match(/reply_to[=:]([A-Za-z0-9-]+)/)?.[1];
      if (rt) replyTo.set(rt, (replyTo.get(rt) ?? 0) + 1);
    }
  }
  const receivedToConsumedMs: number[] = [];
  for (const [id, got] of consumedAt) {
    const sent = receivedAt.get(id);
    if (sent !== undefined && got >= sent) receivedToConsumedMs.push(got - sent);
  }
  const sorted = [...receivedToConsumedMs].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted[Math.floor((sorted.length - 1) / 2)]
    : null;
  let reworkRounds = 0;
  for (const n of replyTo.values()) if (n > 1) reworkRounds += n - 1;
  return { injects, bySource, byTarget, receivedToConsumedMs, medianReceivedToConsumedMs: median, completed, reworkRounds };
}

/** Human-readable report from a spool dir's audit log (chain-verified first). */
export function renderInjectReport(spoolDir: string): string {
  const entries = verifyInjectLog(spoolDir);
  const m = deriveInjectMetrics(entries);
  const lines = [
    `inject.log report — ${m.injects} inject(s), chain verified`,
    `by source: ${Object.entries(m.bySource).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`,
    `by target: ${Object.entries(m.byTarget).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`,
    `received→consumed latency: ${m.medianReceivedToConsumedMs !== null ? `${m.medianReceivedToConsumedMs}ms median (${m.receivedToConsumedMs.length} paired)` : "no paired events yet"}`,
    `completed lifecycle events: ${m.completed.length}`,
    `rework rounds (shared reply_to): ${m.reworkRounds}`,
  ];
  for (const c of m.completed) lines.push(`  completed ${c.id}${c.detail ? ` — ${c.detail}` : ""}`);
  // Reconciliation: every inject FILE (spool + archive) must have a received
  // entry. A file with no entry = an audit append that failed after the spool
  // write — the log stays chain-valid through such a loss, so this cross-check
  // is the only durable detector (the archive is the evidence; never delete it).
  try {
    const fileIds = new Set<string>();
    for (const dir of [spoolDir, path.join(spoolDir, "archive")]) {
      for (const f of fs.readdirSync(dir)) {
        const idMatch = f.match(/^(.+)\.inject\.json$/);
        if (idMatch) fileIds.add(idMatch[1]);
      }
    }
    const logged = new Set(entries.filter((e) => e.event === "received").map((e) => e.id));
    const orphans = [...fileIds].filter((id) => !logged.has(id));
    lines.push(
      orphans.length
        ? `⚠ unlogged inject files (audit append lost): ${orphans.length} — ${orphans.join(", ")}`
        : `archive reconciliation: clean (${fileIds.size} file(s), all logged)`,
    );
  } catch {
    lines.push("archive reconciliation: skipped (unreadable spool/archive)");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Payload — what an `inject` may carry. Deliberately tiny: a prompt is text
// plus routing hints, nothing else. The receiving machine treats it as
// untrusted input (same rule as Discord messages).
// ---------------------------------------------------------------------------

export const InjectTask = z.object({
  kind: z.enum(["implement", "review", "question", "status"]), // what the receiver should do
  repo: z.string().max(200).optional(), // repo name on the receiving side (hint)
  branch: z.string().max(200).optional(), // branch to build/review
  base: z.string().max(200).optional(), // base ref for diffs
  commit: z.string().max(40).optional(), // specific commit under review
  diff_ref: z.string().max(400).optional(), // PR/commit ref or URL (TEXT ONLY — nothing fetches it)
  acceptance: z.array(z.string().min(1).max(400)).max(10).optional(), // pass criteria
  reply_to: z.string().max(64).optional(), // inject/message id to thread replies to
  correlation: z.string().max(64).optional(), // task-round grouping id shared by related injects
  deadline_soft: z.string().max(40).optional(), // duration or timestamp HINT
});
export type InjectTask = z.infer<typeof InjectTask>;

export const InjectPayload = z.object({
  source: z.string().min(1).max(64), // who is asking (peer bot/agent name)
  target: z.string().min(1).max(64), // routing hint, e.g. "orchestrator" | "shim"
  text: z.string().min(1).max(BOTLINK_MAX_TEXT), // the prompt itself (human framing)
  thread: z.string().max(64).optional(), // reply venue hint (thread name/id)
  supersedes: z.string().max(64).optional(), // lineage: inject id this one replaces (same logical prompt, refined)
  task: InjectTask.optional(), // structured task — hints, same untrusted-input rules
  file: z
    .object({
      name: z.string().min(1).max(160), // display/hint name — receiver sanitizes to a basename, sender NEVER picks a path
      size: z.number().int().min(1), // decoded byte length (receiver verifies)
      sha256: z.string().regex(/^[0-9a-f]{64}$/), // of the DECODED bytes (receiver verifies)
      // Schema-level blob bound: base64 of the 2 MB cap is ~2.8 MB — anything
      // larger is a hostile/buggy peer, rejected at PARSE before the raw
      // accumulator or decoder ever sees it.
      content_b64: z.string().min(1).max(Math.ceil(BOTLINK_MAX_FILE_BYTES / 3) * 4),
      note: z.string().max(400).optional(), // one line: what it is / why
    })
    .optional(), // file transfer — same trust level as the text (untrusted on arrival)
});
export type InjectPayload = z.infer<typeof InjectPayload>;

/** Strip a sender-supplied name to a harmless basename: no separators, no
 *  control chars, no leading dots, bounded length. The receiver writes under
 *  <spool>/files/<inject-id>/<name> so traversal has nowhere to go even
 *  before this runs — this is the second lock, not the only one. */
export function sanitizeFileName(name: string): string {
  const base = path
    .basename(String(name ?? ""))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/\\:"*?<>|]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return base || "file";
}

/**
 * Send-side file-transfer builder — everything the SENDING machine checks
 * before a byte leaves: size cap, leak-shape scan of the head (same rule as
 * `send` attachments — the lane is an exfil boundary, not a side door), then
 * the payload with a self-framing text line. Pure and exported so the test
 * suite pins the refusals without an SSH hop.
 */
export function buildFileTransfer(opts: {
  source: string;
  target: string;
  name: string;
  bytes: Buffer;
  note?: string;
  thread?: string;
}): { payload: InjectPayload } | { error: string } {
  if (opts.bytes.length === 0) return { error: "file is empty — nothing to send" };
  if (opts.bytes.length > BOTLINK_MAX_FILE_BYTES) {
    return { error: `file too large: ${opts.bytes.length} bytes (cap ${BOTLINK_MAX_FILE_BYTES} = 2 MB decoded)` };
  }
  const head = opts.bytes.subarray(0, 65536).toString("utf8");
  const leaks = findLeakSignals(head);
  if (leaks.length > 0) {
    return { error: leakRefusal(leaks.map((k) => `${k} (in file ${opts.name})`)) };
  }
  const name = sanitizeFileName(opts.name);
  const sha256 = crypto.createHash("sha256").update(opts.bytes).digest("hex");
  return {
    payload: {
      source: opts.source,
      target: opts.target,
      text: `file transfer: ${name} (${opts.bytes.length} bytes, sha256 ${sha256.slice(0, 12)}…)${opts.note ? ` — ${opts.note}` : ""}`,
      ...(opts.thread ? { thread: opts.thread } : {}),
      file: {
        name,
        size: opts.bytes.length,
        sha256,
        content_b64: opts.bytes.toString("base64"),
        ...(opts.note ? { note: opts.note } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface BotlinkServerOptions {
  listen: { host: string; port: number };
  hostKeyPem: string; // this machine's bot HOST key (private)
  authorizedPublicKeys: string[]; // peer bot public lines
  username?: string; // required SSH username (default "clanker")
  spoolDir: string; // where inject payloads land for the local trigger layer
  botName: string;
  maxInjectsPerConnection?: number;
  maxSpoolPending?: number; // refuse injects at/above this many unconsumed files (default 100)
  maxConnections?: number; // concurrent SSH connection cap — slowloris guard (default 10)
  execTimeoutMs?: number; // per-exec watchdog: no payload-end by this → drop (default 30s)
  maxFileBytes?: number; // per-file cap for file-carrying injects (default 2 MB decoded)
  maxRawPayloadBytes?: number; // raw stdin accumulator cap BEFORE parsing (default 12 MB — headroom over one max file + envelope)
  /** Rotation cutover (docs/one-tap-pairing.md): with the authorized_keys
   *  PATH set, the daemon auto-revokes a `# rotating-from`-marked line the
   *  first time its REPLACEMENT key authenticates successfully, and sweeps
   *  stale grace lines at boot. Unset = legacy behavior (lines are static). */
  authorizedKeysPath?: string;
  /** Rotation hot-reload (owner 2026-10-04, "confirm and it keeps going"):
   *  with the host-key PATH set, the daemon mtime-polls the key files and,
   *  when a confirmed rotation cutover rewrites them, serves the NEW host
   *  key and re-parses authorized_keys in place — rebuild the SSH listener,
   *  never restart the process. A partial/garbage rewrite is skipped (the
   *  previous key keeps serving; the next poll retries). Unset = serve the
   *  constructor's keys for the process lifetime (legacy behavior). */
  hostKeyPath?: string;
  /** Poll cadence for the hot-reload check (default 5s; tests tighten it). */
  keyReloadIntervalMs?: number;
  log?: (line: string) => void;
}

export interface BotlinkStatus {
  ok: true;
  bot: string;
  uptime_s: number;
  spool_pending: number;
  injects_total: number;
}

export function startBotlinkServer(opts: BotlinkServerOptions): { close: () => void; port: number } {
  const log = opts.log ?? (() => {});
  const startedAt = Date.now();
  let injectsTotal = 0;
  let liveConnections = 0;
  fs.mkdirSync(opts.spoolDir, { recursive: true });

  let allowedKeys = opts.authorizedPublicKeys.map((line) => parseKey(line));
  // Zero authorized keys = the lane is UP but trusts nobody (every auth is
  // refused). That's better ops than refusing to boot: the daemon comes up
  // before the peer's key has been exchanged, and self-tests still work.
  // Validate parseability, but hand ssh2 the ORIGINAL OpenSSH PEM —
  // getPrivatePEM() re-serializes to PKCS8, which ssh2's server rejects.
  parseKey(opts.hostKeyPem);
  const username = opts.username ?? BOTLINK_USER_DEFAULT;
  const maxInjects = opts.maxInjectsPerConnection ?? 30;
  const maxPending = opts.maxSpoolPending ?? 100;
  const maxConnections = opts.maxConnections ?? 10; // legit inject bursts clear; parked-idle channels are the thing being bounded
  const execTimeoutMs = opts.execTimeoutMs ?? 30_000;
  const maxFileBytes = opts.maxFileBytes ?? BOTLINK_MAX_FILE_BYTES;
  // Raw-accumulator cap: zod bounds the PARSED payload, but the stdin
  // collector buffers whatever bytes arrive BEFORE parse — a hostile authed
  // peer could stream gigabytes of junk-JSON into memory. Refuse the channel
  // the moment the accumulator crosses the line.
  const maxRawPayloadBytes = opts.maxRawPayloadBytes ?? 12 * 1024 * 1024;

  // Rotation cutover + grace sweep — pairing.ts imports this module, so the
  // dependency is pulled lazily at the call sites (no static cycle).
  let cutover: ((verifiedFingerprint: string) => Promise<void>) | null = null;
  if (opts.authorizedKeysPath) {
    void (async () => {
      try {
        const { sweepStaleRotation, stripRotatingLine } = await import("./pairing.js");
        try {
          const content = fs.readFileSync(opts.authorizedKeysPath!, "utf8");
          const swept = sweepStaleRotation(content);
          if (swept !== null) {
            fs.writeFileSync(opts.authorizedKeysPath!, swept, { mode: 0o600 });
            log("botlink: swept a stale rotation grace line (never authenticated, past TTL)");
          }
        } catch {
          /* unreadable now — the cutover path retries on each auth */
        }
        cutover = async (fp: string) => {
          try {
            const content = fs.readFileSync(opts.authorizedKeysPath!, "utf8");
            const next = stripRotatingLine(content, fp);
            if (next !== null) {
              fs.writeFileSync(opts.authorizedKeysPath!, next, { mode: 0o600 });
              log(`botlink: rotation cutover — new key authenticated; removed the old rotating-from line (${fp})`);
            }
          } catch (err) {
            log(`botlink: rotation cutover check failed: ${(err as Error).message}`);
          }
        };
      } catch {
        /* pairing.js unavailable (partial build?) — cutover stays a no-op */
      }
    })();
  }

  // Unconsumed-spool depth, shared by the status snapshot and the inject cap.
  const countPending = () => {
    try {
      return fs.readdirSync(opts.spoolDir).filter((f) => f.endsWith(".inject.json")).length;
    } catch {
      return 0; // unreadable spool reads as 0 pending — same as status today
    }
  };

  // Rotation hot-reload target: the ssh2 server fixes its host key at
  // construction, so serving a rotated key means building a new server on
  // the same port. The handler body stays one closure — allowedKeys is a
  // mutable binding refreshed by the reload path below.
  const newServer = (hostKeyPem: string) =>
    new SshServer(
    { hostKeys: [hostKeyPem], ident: "clankerchat-botlink" },
    (conn, info) => {
      // info.ip's shape varies across ssh2 versions (string remoteAddress vs
      // [addr, family]) — accept either, never index a string by accident.
      const rawIp = info.ip as unknown;
      const peerIp =
        typeof rawIp === "string"
          ? rawIp
          : Array.isArray(rawIp)
            ? String(rawIp.find((x) => typeof x === "string") ?? "?")
            : "?";
      // Concurrent-connection cap: a peer (or a compromised mesh station)
      // holding idle channels open must not be able to wedge the lane with
      // less traffic than a handshake. Refused connections never authenticate.
      if (liveConnections >= maxConnections) {
        log(`botlink: connection refused from ${peerIp} — ${liveConnections} live (cap ${maxConnections})`);
        conn.end();
        return;
      }
      liveConnections++;
      conn.once("close", () => liveConnections--);
      let authed = false;
      let authedKeyFp = ""; // provenance: WHICH authorized key let this peer in
      conn.on("authentication", (ctx) => {
        const blob = ctx.method === "publickey" ? (ctx.key?.data ?? null) : null;
        if (ctx.username !== username || !blob) {
          log(`botlink: auth rejected (${ctx.method}/${ctx.username}) from ${peerIp}`);
          ctx.reject(["publickey"]);
          return;
        }
        const known = allowedKeys.some((k) => {
          if (!Buffer.from(k.getPublicSSH()).equals(blob)) return false;
          authedKeyFp = fingerprintOfPublicKey(k.getPublicSSH().toString("base64"));
          return true;
        });
        if (!known) {
          log(`botlink: unknown key from ${peerIp}`);
          ctx.reject(["publickey"]);
          return;
        }
        authed = true;
        ctx.accept();
      });
      conn.on("ready", () => {
        log(`botlink: peer authenticated from ${peerIp}`);
        // Rotation cutover: a successful auth on the NEW key retires the
        // marked old line (docs/one-tap-pairing.md — rotation must restore
        // trust; old credentials must not linger indefinitely).
        if (cutover && authedKeyFp) void cutover(authedKeyFp);
        let injects = 0;
        conn.on("session", (acceptSession, rejectSession) => {
          if (!authed) return void rejectSession();
          const session = acceptSession();
          session.on("pty", (_accept, reject) => void reject());
          session.on("shell", (_accept, reject) => void reject());
          session.on("exec", (accept, reject, info2) => {
            const verb = (info2?.command ?? "").trim().split(/\s+/)[0] ?? "";
            if (verb !== "status" && verb !== "inject") {
              log(`botlink: refused verb "${verb}" from ${peerIp}`);
              return void reject();
            }
            const stream = accept();
            // Exec watchdog: a hostile/buggy peer can open `inject` and never
            // send EOF, parking the channel forever. Any legit exchange
            // (≤4000-char payload) closes within milliseconds; drop the whole
            // connection if this channel is still open when the timer fires.
            let reaped = false; // set when the watchdog fires: late stdin 'end'
            // events (ssh2 flushes partial data as the channel closes) must
            // not try to write an ACK to a dead stream.
            const watchdog = setTimeout(() => {
              reaped = true;
              log(`botlink: exec stalled from ${peerIp} (${verb}, no payload end in ${execTimeoutMs}ms) — dropping connection`);
              try {
                stream.close();
              } catch {
                /* already gone — conn.end() below is the backstop */
              }
              conn.end();
            }, execTimeoutMs);
            stream.once("close", () => clearTimeout(watchdog));
            if (verb === "status") {
              const pending = countPending();
              // Load-balancing surface (2026-10-02): the tag-watcher writes
              // watcher-state.json into the spool on every queue change AND
              // every 120s presence tick (round 6); status serves it only
              // while fresh, so a dispatching peer routes by real load, never
              // a stale snapshot. Freshness (180s) EXCEEDS the write cadence —
              // an idle machine's 0/N load is still true load and stays
              // servable; a machine that stops writing falls out of the
              // window within 3 minutes.
              const LOAD_FRESH_MS = 180_000;
              let load: Record<string, unknown> | undefined;
              try {
                const raw = fs.readFileSync(path.join(opts.spoolDir, "watcher-state.json"), "utf8");
                const parsed = JSON.parse(raw) as { updated?: string };
                if (parsed.updated && Date.now() - Date.parse(parsed.updated) < LOAD_FRESH_MS) {
                  load = parsed as Record<string, unknown>;
                }
              } catch {
                /* absent or unreadable — status answers without load */
              }
              // Canonical ssh2 server pattern: write on the channel itself,
              // then exit-status, then close — ending a substream can close
              // the channel before the exit-status request is flushed.
              stream.write(
                JSON.stringify({
                  ok: true,
                  bot: opts.botName,
                  uptime_s: Math.round((Date.now() - startedAt) / 1000),
                  spool_pending: pending,
                  injects_total: injectsTotal,
                  ...(load ? { load } : {}),
                }) + "\n",
              );
              stream.exit(0);
              stream.close();
              return;
            }
            let data = "";
            let rawRefused = false; // oversize accumulator: stop buffering, refuse at end
            stream.stdin.on("data", (c: Buffer) => {
              if (rawRefused) return; // already over the line — keep draining, keep nothing
              data += c.toString("utf8");
              if (data.length > maxRawPayloadBytes) {
                rawRefused = true;
                data = ""; // drop the buffer, not just the flag — the bytes are garbage to us
              }
            });
            stream.stdin.on("end", async () => {
              if (reaped) return; // watchdog already dropped this channel
              clearTimeout(watchdog); // payload arrived — normal processing from here
              if (rawRefused) {
                log(`botlink: payload refused from ${peerIp} — raw body over ${maxRawPayloadBytes} bytes (pre-parse accumulator cap)`);
                stream.stderr.end(`payload too large: raw body exceeds ${maxRawPayloadBytes} bytes\n`);
                stream.exit(1);
                stream.close();
                return;
              }
              if (++injects > maxInjects) {
                stream.stderr.end("inject limit for this connection\n");
                stream.exit(1);
                stream.close();
                return;
              }
              let payload: InjectPayload;
              try {
                payload = InjectPayload.parse(JSON.parse(data));
              } catch (err) {
                stream.stderr.end(`invalid payload: ${(err as Error).message}\n`);
                stream.exit(1);
                stream.close();
                return;
              }
              // Spool-depth cap: injects are cheap for the sender and priced
              // in disk for the receiver, and the archive keeps everything —
              // a peer stuck in an ack-loop must not be able to fill this
              // machine. Refuse past the cap, loudly, nothing spooled.
              const pending = countPending();
              if (pending >= maxPending) {
                log(`botlink: inject REFUSED from ${peerIp} — spool at ${pending} pending (cap ${maxPending}); receiver is not consuming`);
                stream.stderr.end(
                  `spool full: ${pending} inject(s) pending, cap ${maxPending} — the receiver is not consuming; inject refused (nothing was spooled)\n`,
                );
                stream.exit(1);
                stream.close();
                return;
              }
              const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
              // File-carrying inject: verify, then persist the bytes under a
              // receiver-controlled path. The sender picks a NAME (sanitized
              // to a harmless basename); the destination is always
              // <spool>/files/<inject-id>/<name> — traversal has nowhere to
              // go even before the sanitizer runs. Refusals spool NOTHING.
              let fileManifest:
                | { name: string; size: number; sha256: string; note?: string; path: string }
                | undefined;
              const fileRefuse = (why: string) => {
                log(`botlink: file inject REFUSED from ${peerIp} — ${why}; nothing spooled`);
                stream.stderr.end(`${why}\n`);
                stream.exit(1);
                stream.close();
              };
              if (payload.file) {
                const f = payload.file;
                if (f.size > maxFileBytes) {
                  return void fileRefuse(`file too large: ${f.size} bytes (cap ${maxFileBytes})`);
                }
                const bytes = Buffer.from(f.content_b64, "base64");
                if (bytes.length === 0 || bytes.length !== f.size) {
                  return void fileRefuse("file size mismatch — claimed size does not match decoded bytes");
                }
                const sha = crypto.createHash("sha256").update(bytes).digest("hex");
                if (sha !== f.sha256) {
                  return void fileRefuse("file hash mismatch — corrupted or tampered in transit");
                }
                // Receiver-side exfil boundary: the sender's leak scan is
                // theirs; this end of the lane refuses secret shapes in
                // arriving files regardless of what the far side checked.
                const leakKinds = findLeakSignals(bytes.subarray(0, 65536).toString("utf8"));
                if (leakKinds.length > 0) {
                  return void fileRefuse(leakRefusal(leakKinds.map((k) => `${k} (in file "${f.name}")`)));
                }
                const safeName = sanitizeFileName(f.name);
                const dest = path.join(opts.spoolDir, "files", id, safeName);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, bytes);
                fileManifest = {
                  name: safeName,
                  size: f.size,
                  sha256: f.sha256,
                  ...(f.note ? { note: f.note } : {}),
                  // POSIX separators in the manifest regardless of host OS —
                  // manifests are audit artifacts read on both platforms.
                  path: path.relative(opts.spoolDir, dest).split(path.sep).join("/"),
                };
              }
              const file = path.join(opts.spoolDir, `${id}.inject.json`);
              // Provenance: the payload as validated, plus who delivered it —
              // the consuming side can tell WHERE a prompt came from without
              // trusting the sender's self-reported `source` field. File
              // injects persist a MANIFEST (bytes are already on disk under
              // files/<id>/), never the base64 — the spool stays an audit
              // artifact, not a blob store.
              const { file: _fileBlock, ...payloadRest } = payload;
              fs.writeFileSync(
                file,
                JSON.stringify(
                  {
                    id,
                    received: new Date().toISOString(),
                    ...payloadRest,
                    ...(fileManifest ? { file: fileManifest } : {}),
                    authenticated_key_fp: authedKeyFp,
                    peer_ip: peerIp,
                  },
                  null,
                  2,
                ),
              );
              injectsTotal++;
              try {
                // Await the audit entry BEFORE acking: the ACK must mean the
                // inject is both spooled and logged.
                await appendInjectEvent(opts.spoolDir, {
                  event: "received",
                  id,
                  source: payload.source,
                  target: payload.target,
                  detail: [
                    `key ${authedKeyFp} from ${peerIp}, ${payload.text.length} chars`,
                    payload.supersedes ? `supersedes=${payload.supersedes}` : "",
                    payload.task?.kind ? `kind=${payload.task.kind}` : "",
                    payload.task?.reply_to ? `reply_to=${payload.task.reply_to}` : "",
                    payload.task?.correlation ? `correlation=${payload.task.correlation}` : "",
                    fileManifest
                      ? `file ${fileManifest.name} ${fileManifest.size}B sha256:${fileManifest.sha256.slice(0, 12)}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                  // Structured lineage (hash-covered) — metrics read these;
                  // the detail line above stays for human eyes only.
                  meta: {
                    ...(payload.task?.reply_to ? { reply_to: payload.task.reply_to } : {}),
                    ...(payload.task?.correlation ? { correlation: payload.task.correlation } : {}),
                    ...(payload.supersedes ? { supersedes: payload.supersedes } : {}),
                  },
                });
              } catch (auditErr) {
                // Audit failure must not drop the inject itself — but never
                // silently: the entry is LOST while the log stays chain-valid,
                // so journal it loudly. `report`'s archive reconciliation is
                // the durable detector for exactly this case.
                log(`botlink: AUDIT APPEND FAILED for inject ${id}: ${(auditErr as Error).message} — received entry lost, log remains chain-valid`);
              }
              log(`botlink: inject ${id} from ${payload.source} → ${payload.target} (${payload.text.length} chars)`);
              stream.write(JSON.stringify({ ok: true, id }) + "\n");
              stream.exit(0);
              stream.close();
            });
            stream.stdin.on("error", () => void 0); // aborted inject
          });
        });
      });
      conn.on("error", (err) => log(`botlink: connection error from ${peerIp}: ${err.message}`));
    },
    );
  let server = newServer(opts.hostKeyPem);
  // Listen (port 0 = ephemeral) and surface the REAL bound port once the
  // listener is up, so tests and callers can connect without racing.
  let boundPort = opts.listen.port;
  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(opts.listen.port, opts.listen.host);
  const handle = {
    close: () => {
      if (reloadTimer) clearInterval(reloadTimer);
      server.close();
    },
    port: opts.listen.port,
    listening: listening.then(() => {
      const addr = server.address();
      handle.port = typeof addr === "object" && addr ? addr.port : handle.port;
      boundPort = handle.port;
      log(`botlink: listening on ${opts.listen.host}:${handle.port} as "${opts.botName}" (${allowedKeys.length} peer key(s))`);
    }),
  };

  // --- rotation hot-reload (owner 2026-10-04) -----------------------------
  // The pairing confirm commits new key FILES; ssh2 fixed its host key at
  // construction, so a running daemon would keep presenting the OLD key
  // until a process restart. With hostKeyPath set, mtime-poll the files:
  // authorized_keys-only change → re-parse the peer list in place; host-key
  // change → validate the new PEM, build a fresh server on the same port,
  // stop the old listener (established connections drain naturally —
  // clients dial fresh per verb). A garbage/partial write skips the swap
  // and retries on the next poll; the lane never wedges on a torn file.
  const reloadPaths = [opts.hostKeyPath, opts.authorizedKeysPath].filter(
    (p): p is string => typeof p === "string",
  );
  let lastMt = new Map<string, number>();
  const snapshotMt = () => {
    for (const p of reloadPaths) {
      try {
        lastMt.set(p, fs.statSync(p).mtimeMs);
      } catch {
        lastMt.set(p, -1);
      }
    }
  };
  const parseAuthorizedLines = (file: string) =>
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((line) => parseKey(line));
  const checkKeyFiles = () => {
    let hostChanged = false;
    let authChanged = false;
    for (const p of reloadPaths) {
      let m: number;
      try {
        m = fs.statSync(p).mtimeMs;
      } catch {
        m = -1;
      }
      if (m !== (lastMt.get(p) ?? -1)) {
        if (p === opts.hostKeyPath) hostChanged = true;
        else authChanged = true;
        lastMt.set(p, m);
      }
    }
    if (!hostChanged && !authChanged) return;
    if (!hostChanged) {
      try {
        allowedKeys = parseAuthorizedLines(opts.authorizedKeysPath!);
        log(`botlink: authorized_keys changed on disk — serving ${allowedKeys.length} peer key(s), no restart`);
      } catch (err) {
        log(`botlink: authorized_keys reload failed: ${(err as Error).message} — keeping the previous list`);
      }
      return;
    }
    try {
      const pem = fs.readFileSync(opts.hostKeyPath!, "utf8");
      parseKey(pem); // validate BEFORE swapping — a torn write never takes the lane down
      if (opts.authorizedKeysPath) allowedKeys = parseAuthorizedLines(opts.authorizedKeysPath);
      const old = server;
      server = newServer(pem);
      server.listen(boundPort, opts.listen.host);
      old.close();
      log("botlink: host key file changed — serving the rotated key (listener rebuilt, no process restart)");
    } catch (err) {
      log(`botlink: host-key reload failed: ${(err as Error).message} — still serving the previous key`);
    }
  };
  snapshotMt();
  let reloadTimer: NodeJS.Timeout | null = null;
  if (reloadPaths.length > 0) {
    // Either key surface being path-backed enables the watch — an
    // authorized_keys-only config (no hostKeyPath) still refreshes peers.
    reloadTimer = setInterval(checkKeyFiles, opts.keyReloadIntervalMs ?? 5_000);
    reloadTimer.unref?.();
  }
  return handle;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface BotlinkPeer {
  host: string;
  port?: number;
  username?: string; // default "clanker"
  privateKeyPem: string; // this bot's dedicated key
  expectedHostKey: string; // pinned: fingerprint (SHA256:…) or full public line — REQUIRED
}

/** First non-comment, non-empty line of a peer.hostkey pin file, or
 *  undefined. The file is written ONLY by the pairing ceremony (CLI confirm
 *  or phone Allow) — it is SAS-verified human output, never agent-writable
 *  config. */
export function readPinnedHostkey(file: string): string | undefined {
  try {
    const line = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    return line;
  } catch {
    return undefined;
  }
}

/** Client config resolution, rotation-ready (owner 2026-10-04: a confirmed
 *  rotation must reach RUNNING MCP servers without a session restart):
 *  pin + private key are read from disk per call, never cached at process
 *  start. Pin precedence: the ceremony's botlink-keys/peer.hostkey file
 *  WINS over CLANKER_BOTLINK_PEER_HOSTKEY env — the file updates at every
 *  confirm while env is a static bootstrap fallback that would silently go
 *  stale. Returns null when the lane isn't configured. */
export function resolveBotlinkPeerFromEnv(
  env: { CLANKER_BOTLINK_PEER?: string; CLANKER_BOTLINK_KEY?: string; CLANKER_BOTLINK_PEER_HOSTKEY?: string; CLANKER_BOTLINK_USER?: string },
  projectRoot: string,
): BotlinkPeer | null {
  const peer = env.CLANKER_BOTLINK_PEER;
  const keyPath = env.CLANKER_BOTLINK_KEY;
  const hostKey = readPinnedHostkey(path.join(projectRoot, "botlink-keys", "peer.hostkey")) ?? env.CLANKER_BOTLINK_PEER_HOSTKEY?.trim();
  if (!peer || !keyPath || !hostKey) return null;
  const [host, portStr] = peer.split(":");
  return {
    host,
    port: portStr ? Number(portStr) : undefined,
    username: env.CLANKER_BOTLINK_USER,
    privateKeyPem: fs.readFileSync(path.resolve(keyPath), "utf8"),
    expectedHostKey: hostKey,
  };
}

/** Run one verb against the peer. Resolves with the verb's stdout. */
export function botlinkRequest(peer: BotlinkPeer, verb: "status" | "inject", payload?: InjectPayload): Promise<string> {
  return new Promise((resolve, reject) => {
    let key: ParsedKey;
    try {
      key = parseKey(peer.privateKeyPem);
    } catch (err) {
      return reject(new Error(`bot key unparseable: ${(err as Error).message}`));
    }
    const want = peer.expectedHostKey.trim();
    const wantFp = want.startsWith("SHA256:") ? want : fingerprintOfPublicKey(want);
    const conn = new SshClient();
    // Every exit path must settle the promise exactly once: a peer that drops
    // the socket mid-handshake (restart, connection cap, crash) can emit ONLY
    // a 'close' — no 'error' — and without the close handler the request hung
    // forever (found by the connection-cap test: refused connections died
    // exactly this way). The absolute deadline backstops any other silent
    // stall; late settles are no-ops by Promise semantics.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      timer = null;
      fn();
    };
    const fail = (msg: string) => {
      conn.end();
      finish(() => reject(new Error(msg)));
    };
    // File-carrying injects move ~2.8 MB of base64; give them double the
    // absolute deadline so a slow link fails on the SERVER's watchdog, not
    // on our own impatience (both fire well under a healthy tailnet's time).
    const deadlineMs = verb === "inject" && payload?.file ? 60_000 : 30_000;
    timer = setTimeout(() => fail(`botlink verb "${verb}" timed out after ${deadlineMs / 1000}s without completing`), deadlineMs);
    conn
      .on("ready", () => {
        conn.exec(verb, (err, stream) => {
          if (err) return fail(err.message);
          let out = "";
          let errOut = "";
          let exitCode: number | null = null;
          stream.on("data", (c: Buffer) => (out += c.toString("utf8")));
          stream.stderr.on("data", (c: Buffer) => (errOut += c.toString("utf8")));
          // The exit code arrives on 'exit'; 'close' just means the channel is
          // gone — resolving there without tracking 'exit' loses the code.
          stream.on("exit", (code: number | null) => (exitCode = code));
          stream.on("close", () => {
            conn.end();
            finish(() =>
              exitCode === 0
                ? resolve(out.trim())
                : reject(new Error(errOut.trim() || `botlink verb failed (exit ${exitCode})`)),
            );
          });
          if (verb === "inject" && payload) stream.end(JSON.stringify(payload) + "\n");
          else stream.end();
        });
      })
      .on("error", (err) => fail(`botlink peer unreachable: ${err.message}`))
      .on("close", () => fail("botlink peer closed the connection before the verb completed"))
      .connect({
        host: peer.host,
        port: peer.port ?? BOTLINK_PORT_DEFAULT,
        username: peer.username ?? BOTLINK_USER_DEFAULT,
        privateKey: peer.privateKeyPem, // raw OpenSSH PEM (validated above)
        // Host key is PINNED — any mismatch is a hard failure. No TOFU.
        hostVerifier: (keyBuf: Buffer) => fingerprintOfPublicKey(keyBuf.toString("base64")) === wantFp,
        readyTimeout: 10_000,
        keepaliveInterval: 0,
      });
  });
}
