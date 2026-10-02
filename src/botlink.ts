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
 *                   always keep priority.
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

export const BOTLINK_PORT_DEFAULT = 47421;
export const BOTLINK_USER_DEFAULT = "clanker";
export const BOTLINK_MAX_TEXT = 4000;

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
  const pair = utils.generateKeyPairSync("ed25519", { comment }) as unknown as {
    public: string;
    private: string;
  };
  return {
    privatePem: pair.private,
    publicLine: pair.public.trim(),
    fingerprint: fingerprintOfPublicKey(pair.public),
  };
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

export function appendInjectEvent(
  spoolDir: string,
  evt: {
    event: string; // "received" | "consumed" are the lane's own; receivers may append lifecycle events ("completed", …)
    id: string;
    source: string;
    target: string;
    detail?: string;
  },
): Promise<void> {
  // Serialize read-prev/append inside this process: two connections landing
  // injects simultaneously could otherwise interleave and break the chain.
  // (A cross-PROCESS race — daemon vs. trigger layer — still exists but is
  // detectable: verifyInjectLog throws, fail-visible not fail-silent.)
  appendQueue = appendQueue.then(() => {
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
  });
  // Callers on the daemon path are fire-and-forget; a rejected link must
  // not poison subsequent appends. Callers who need the flush (the daemon
  // ACKs only after the audit entry landed) await the returned promise.
  appendQueue.catch(() => {});
  return appendQueue;
}

/** Replay inject.log and verify the hash chain. Returns entries, or throws. */
export function verifyInjectLog(
  spoolDir: string,
): Array<{ event: string; id: string; hash: string; ts?: string; source?: string; target?: string; detail?: string }> {
  const lines = fs.readFileSync(path.join(spoolDir, "inject.log"), "utf8").split("\n").filter(Boolean);
  let prev = "";
  const out: Array<{ event: string; id: string; hash: string; ts?: string; source?: string; target?: string; detail?: string }> = [];
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
  entries: Array<{ event: string; id: string; ts?: string; source?: string; target?: string; detail?: string }>,
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
    if (e.event === "received" && e.detail) {
      const m = e.detail.match(/reply_to[=:]([A-Za-z0-9-]+)/);
      if (m) replyTo.set(m[1], (replyTo.get(m[1]) ?? 0) + 1);
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
});
export type InjectPayload = z.infer<typeof InjectPayload>;

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
  fs.mkdirSync(opts.spoolDir, { recursive: true });

  const allowedKeys = opts.authorizedPublicKeys.map((line) => parseKey(line));
  // Zero authorized keys = the lane is UP but trusts nobody (every auth is
  // refused). That's better ops than refusing to boot: the daemon comes up
  // before the peer's key has been exchanged, and self-tests still work.
  // Validate parseability, but hand ssh2 the ORIGINAL OpenSSH PEM —
  // getPrivatePEM() re-serializes to PKCS8, which ssh2's server rejects.
  parseKey(opts.hostKeyPem);
  const username = opts.username ?? BOTLINK_USER_DEFAULT;
  const maxInjects = opts.maxInjectsPerConnection ?? 30;

  const server = new SshServer(
    { hostKeys: [opts.hostKeyPem], ident: "clankerchat-botlink" },
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
            if (verb === "status") {
              let pending = 0;
              try {
                pending = fs.readdirSync(opts.spoolDir).filter((f) => f.endsWith(".inject.json")).length;
              } catch {
                /* unreadable spool reads as 0 pending */
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
                }) + "\n",
              );
              stream.exit(0);
              stream.close();
              return;
            }
            let data = "";
            stream.stdin.on("data", (c: Buffer) => (data += c.toString("utf8")));
            stream.stdin.on("end", async () => {
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
              const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
              const file = path.join(opts.spoolDir, `${id}.inject.json`);
              // Provenance: the payload as validated, plus who delivered it —
              // the consuming side can tell WHERE a prompt came from without
              // trusting the sender's self-reported `source` field.
              fs.writeFileSync(
                file,
                JSON.stringify(
                  {
                    id,
                    received: new Date().toISOString(),
                    ...payload,
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
                  ]
                    .filter(Boolean)
                    .join(" "),
                });
              } catch {
                /* audit failure must not drop the inject itself */
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
  // Listen (port 0 = ephemeral) and surface the REAL bound port once the
  // listener is up, so tests and callers can connect without racing.
  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(opts.listen.port, opts.listen.host);
  const handle = {
    close: () => server.close(),
    port: opts.listen.port,
    listening: listening.then(() => {
      const addr = server.address();
      handle.port = typeof addr === "object" && addr ? addr.port : handle.port;
      log(`botlink: listening on ${opts.listen.host}:${handle.port} as "${opts.botName}" (${allowedKeys.length} peer key(s))`);
    }),
  };
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
    const fail = (msg: string) => {
      conn.end();
      reject(new Error(msg));
    };
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
            if (exitCode === 0) return resolve(out.trim());
            reject(new Error(errOut.trim() || `botlink verb failed (exit ${exitCode})`));
          });
          if (verb === "inject" && payload) stream.end(JSON.stringify(payload) + "\n");
          else stream.end();
        });
      })
      .on("error", (err) => fail(`botlink peer unreachable: ${err.message}`))
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
