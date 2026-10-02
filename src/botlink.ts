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
// Payload — what an `inject` may carry. Deliberately tiny: a prompt is text
// plus routing hints, nothing else. The receiving machine treats it as
// untrusted input (same rule as Discord messages).
// ---------------------------------------------------------------------------

export const InjectPayload = z.object({
  source: z.string().min(1).max(64), // who is asking (peer bot/agent name)
  target: z.string().min(1).max(64), // routing hint, e.g. "orchestrator" | "shim"
  text: z.string().min(1).max(BOTLINK_MAX_TEXT), // the prompt itself
  thread: z.string().max(64).optional(), // reply venue hint (thread name/id)
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
      const peerIp = info.ip?.[0] ?? "?";
      let authed = false;
      conn.on("authentication", (ctx) => {
        const blob = ctx.method === "publickey" ? (ctx.key?.data ?? null) : null;
        if (ctx.username !== username || !blob) {
          log(`botlink: auth rejected (${ctx.method}/${ctx.username}) from ${peerIp}`);
          ctx.reject(["publickey"]);
          return;
        }
        const known = allowedKeys.some((k) => Buffer.from(k.getPublicSSH()).equals(blob));
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
            stream.stdin.on("end", () => {
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
              fs.writeFileSync(file, JSON.stringify({ id, received: new Date().toISOString(), ...payload }, null, 2));
              injectsTotal++;
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
