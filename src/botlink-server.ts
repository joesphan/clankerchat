#!/usr/bin/env node
/**
 * botlink-server — the SSH half of clankerchat's machine-to-machine lane.
 *
 * Run as a standalone daemon (one per machine; systemd/LaunchDaemon/overseer-
 * spawned, your choice). The MCP half (bot_status / bot_inject tools in
 * index.ts) is the client that connects here from the peer machine.
 *
 *   node dist/botlink-server.js keygen [--out DIR] [--name NAME]
 *       Generate this machine's two keypairs: a HOST key (server identity,
 *       the peer pins its fingerprint) and a BOT key (client identity, its
 *       public line goes into the PEER's authorized_keys). Prints both.
 *
 *   node dist/botlink-server.js fingerprint <keyfile>
 *       Print the SHA256 fingerprint of a public or private key file.
 *
 *   node dist/botlink-server.js report [spoolDir]
 *       Chain-verify inject.log and print lane metrics (counts by source/
 *       target, received→consumed latency, completed events, rework rounds).
 *
 *   node dist/botlink-server.js pair --arm [--rotate] [--port N] [--bind H]
 *       One-tap pairing (docs/one-tap-pairing.md). Arms a single-use,
 *       10-minute-TTL ephemeral listener on main-port+1 and prints the SAS
 *       tap block when the peer dials. --rotate stages .next candidate keys
 *       and authenticates the exchange with the OLD bot key.
 *
 *   node dist/botlink-server.js pair --dial <host>[:47422]
 *       Dial the peer's armed pairing listener; runs the same exchange from
 *       the initiator side, prints the SAS, saves state for --confirm.
 *
 *   node dist/botlink-server.js pair --confirm
 *       The tap. LOCAL interactive TTY only — shows the peer's full
 *       fingerprints + SAS, requires typing the peer's SAS back (transcription
 *       check), then commits pins atomically with a journaled two-phase write.
 *
 *   node dist/botlink-server.js pair --status | pair --rollback
 *       Inspect pairing state / finish-or-clean an interrupted commit.
 *
 *   node dist/botlink-server.js companion --enroll
 *       Phone allow/deny for pairing confirmations (docs/companion-app.md):
 *       print a single-use 10-minute QR the app scans to enroll (the phone
 *       generates its own keypair; the machine pins only its public line).
 *
 *   node dist/botlink-server.js companion --serve [--port N] [--bind H]
 *       The companion HTTP surface (default main port + 2): signed
 *       GET /attempts, POST /attempts/:id/allow|deny. Allow reuses the
 *       exact `pair --confirm` commit path (typed-SAS check included).
 *
 *   node dist/botlink-server.js serve
 *       Listen and serve the two verbs (status / inject). Config from env:
 *         CLANKER_BOTLINK_LISTEN          host:port   (default 127.0.0.1:47421)
 *         CLANKER_BOTLINK_HOST_KEY        path to THIS machine's host key (private)
 *         CLANKER_BOTLINK_AUTHORIZED_KEYS path to authorized_keys (peer bot lines)
 *         CLANKER_BOTLINK_USER            required SSH username (default "clanker")
 *         CLANKER_BOTLINK_SPOOL           inject spool dir (default ./botlink-spool)
 *         CLANKER_BOTLINK_NAME            this bot's link name (default CLANKER_NAME/hostname)
 *         CLANKER_BOTLINK_MAX_PENDING     refuse injects at this spool depth (default 100)
 *         CLANKER_BOTLINK_MAX_CONNECTIONS concurrent-connection cap (default 10)
 *         CLANKER_BOTLINK_MAX_FILE_BYTES  per-file cap for file-carrying injects (default 2 MB)
 *         CLANKER_BOTLINK_MAX_PAYLOAD_BYTES raw stdin cap before parsing (default 12 MB)
 *
 * stdout is reserved for keygen/fingerprint output; serve logs to stderr.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { defaultCompanionStore, issueEnrollToken, startCompanionServer } from "./companion.js";
import { appendInjectEvent, fingerprintOfPublicKey, generateBotKey, parseKey, renderInjectReport, startBotlinkServer } from "./botlink.js";
import {
  buildConfirmPlan,
  clearPairingState,
  freshNonce,
  keydirPaths,
  loadPairingState,
  normalizeSasInput,
  pairDial,
  PAIRING_TTL_MS,
  renderTapBlock,
  rollbackInterruptedCommit,
  sanitizePeerText,
  sasOfState,
  savePairingState,
  stageAndCommit,
  startPairingListener,
  type PairingState,
} from "./pairing.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT_DEFAULT = 47421;

function cmdKeygen(args: string[]): void {
  const out = argValue(args, "--out") ?? path.join(PROJECT_ROOT, "botlink-keys");
  const name = argValue(args, "--name") ?? process.env.CLANKER_BOTLINK_NAME ?? process.env.CLANKER_NAME ?? os.hostname();
  fs.mkdirSync(out, { recursive: true });
  const host = generateBotKey(`${name} host key`);
  const bot = generateBotKey(`${name} bot key`);
  for (const [file, pem] of [
    ["host_key", host.privatePem],
    ["bot_key", bot.privatePem],
  ] as const) {
    fs.writeFileSync(path.join(out, file), pem, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(out, "host_key.pub"), host.publicLine + "\n");
  fs.writeFileSync(path.join(out, "bot_key.pub"), bot.publicLine + "\n");
  // chmod AFTER write — Windows ignores it, POSIX needs the 600 on privates.
  for (const f of ["host_key", "bot_key"]) fs.chmodSync(path.join(out, f), 0o600);
  console.log(`keys written to ${out}/ (host_key, bot_key — private, 0600)`);
  console.log(`\nHOST KEY fingerprint (peer pins this as their expected host key):\n  ${host.fingerprint}`);
  console.log(`\nBOT KEY public line (peer pastes into their authorized_keys):\n  ${bot.publicLine}`);
  console.log(`\nBOT KEY fingerprint (for eyeball-verification over any channel):\n  ${bot.fingerprint}`);
}

function cmdFingerprint(file: string): void {
  const material = fs.readFileSync(file, "utf8");
  // Private keys carry the public blob inside; ssh2 parses both forms.
  console.log(fingerprintOfPublicKey(material.includes("PRIVATE") ? parseKey(material).getPublicSSH().toString("base64") : material));
}

function cmdServe(): void {
  const listenSpec = process.env.CLANKER_BOTLINK_LISTEN ?? `127.0.0.1:${PORT_DEFAULT}`;
  const [host, portStr] = listenSpec.split(":");
  const hostKeyPath = requiredEnv("CLANKER_BOTLINK_HOST_KEY");
  const authorizedPath = requiredEnv("CLANKER_BOTLINK_AUTHORIZED_KEYS");
  const spoolDir = defaultSpoolDir();
  const botName = process.env.CLANKER_BOTLINK_NAME ?? process.env.CLANKER_NAME ?? os.hostname();

  const { close } = startBotlinkServer({
    listen: { host: host || "127.0.0.1", port: Number(portStr) || PORT_DEFAULT },
    hostKeyPem: fs.readFileSync(hostKeyPath, "utf8"),
    authorizedPublicKeys: fs
      .readFileSync(authorizedPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
    // Rotation cutover (docs/one-tap-pairing.md): with the PATH, the daemon
    // auto-revokes a `# rotating-from` line after the first successful auth
    // on its replacement, and sweeps stale grace lines at boot.
    authorizedKeysPath: authorizedPath,
    username: process.env.CLANKER_BOTLINK_USER,
    spoolDir,
    botName,
    maxSpoolPending: numEnv("CLANKER_BOTLINK_MAX_PENDING"),
    maxConnections: numEnv("CLANKER_BOTLINK_MAX_CONNECTIONS"),
    maxFileBytes: numEnv("CLANKER_BOTLINK_MAX_FILE_BYTES"),
    maxRawPayloadBytes: numEnv("CLANKER_BOTLINK_MAX_PAYLOAD_BYTES"),
    log: (line) => console.error(line),
  });
  console.error(`botlink-server: serving as "${botName}" (spool: ${spoolDir})`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      close();
      process.exit(0);
    });
  }
  // Service managers should see the process stay up; if config was bad we
  // already threw above (non-zero exit), so an idle loop is all that's left.
  setInterval(() => void 0, 1 << 30);
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Shared spool resolution so `serve` and `pair --confirm` audit into the
 *  same hash-chained inject.log. */
function defaultSpoolDir(): string {
  return process.env.CLANKER_BOTLINK_SPOOL ?? path.join(PROJECT_ROOT, "botlink-spool");
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`botlink-server: ${name} is required for serve (see header of src/botlink-server.ts)`);
    process.exit(1);
  }
  return v;
}

/** Positive-integer env value, or undefined to take the library default. */
function numEnv(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`botlink-server: ${name} must be a positive integer (got "${v}")`);
    process.exit(1);
  }
  return n;
}

function cmdReport(dirArg?: string): void {
  const spoolDir = dirArg ?? process.env.CLANKER_BOTLINK_SPOOL ?? path.join(PROJECT_ROOT, "botlink-spool");
  try {
    console.log(renderInjectReport(spoolDir));
  } catch (err) {
    console.error(`report: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// pair — one-tap first pairing + rotation (docs/one-tap-pairing.md)
// ---------------------------------------------------------------------------

function readPub(file: string, what: string): string {
  try {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
    if (!line) throw new Error("empty");
    return line.trim();
  } catch {
    console.error(`botlink-server pair: cannot read ${what} (${file}) — run keygen first.`);
    process.exit(1);
  }
}

function authorizedLinesOf(p: ReturnType<typeof keydirPaths>): string[] {
  try {
    return fs
      .readFileSync(p.authorizedKeys, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function selfValuesOf(p: ReturnType<typeof keydirPaths>, mode: "first" | "rotate", name: string) {
  const [hostPub, botPub] =
    mode === "rotate"
      ? [readPub(p.hostKeyNext + ".pub", "staged host_key.next.pub"), readPub(p.botKeyNext + ".pub", "staged bot_key.next.pub")]
      : [readPub(p.hostKey + ".pub", "host_key.pub"), readPub(p.botKey + ".pub", "bot_key.pub")];
  return { name, hostkeyFp: fingerprintOfPublicKey(hostPub), botPub };
}

async function cmdPair(args: string[]): Promise<void> {
  const keydir = argValue(args, "--keys") ?? path.join(PROJECT_ROOT, "botlink-keys");
  const p = keydirPaths(keydir);
  const name =
    process.env.CLANKER_BOTLINK_NAME ?? process.env.CLANKER_NAME ?? os.hostname();
  const log = (line: string) => console.error(`botlink-server pair: ${line}`);

  // Always finish/clean an interrupted commit before anything else.
  if (rollbackInterruptedCommit(p)) {
    console.error("botlink-server pair: finished an interrupted commit from the journal (see backups).");
  }

  const sub = args.find((a) => a.startsWith("--")) ?? "--status";

  if (sub === "--status") {
    const s = loadPairingState(p);
    if (!s) return void console.log("pairing: no state (never armed, or consumed/expired).");
    console.log(renderTapBlock(s, sasOfState(s) ?? "(pending exchange)"));
    return;
  }

  if (sub === "--rollback") {
    console.log(
      rollbackInterruptedCommit(p)
        ? "pairing: interrupted commit finished/cleaned."
        : "pairing: no interrupted commit found.",
    );
    return;
  }

  if (sub === "--arm") {
    const mode = args.includes("--rotate") ? "rotate" : "first";
    if (mode === "rotate") {
      // Staged candidates only — active keys never move until the confirm
      // cutover, so a failed rotation cannot strand the working lane.
      if (!fs.existsSync(p.hostKey) || !fs.existsSync(p.botKey)) {
        console.error("botlink-server pair: --rotate needs existing active keys (keygen first).");
        process.exit(1);
      }
      const host = generateBotKey(`${name} host key next`);
      const bot = generateBotKey(`${name} bot key next`);
      fs.writeFileSync(p.hostKeyNext, host.privatePem + "\n", { mode: 0o600 });
      fs.writeFileSync(p.hostKeyNext + ".pub", host.publicLine + "\n");
      fs.writeFileSync(p.botKeyNext, bot.privatePem + "\n", { mode: 0o600 });
      fs.writeFileSync(p.botKeyNext + ".pub", bot.publicLine + "\n");
      for (const f of [p.hostKeyNext, p.botKeyNext]) fs.chmodSync(f, 0o600);
    }
    const state: PairingState = {
      v: 1,
      mode,
      status: "armed",
      armedAt: Date.now(),
      self: selfValuesOf(p, mode, name),
      nonce: freshNonce(),
    };
    savePairingState(p, state);
    const listenSpec = process.env.CLANKER_BOTLINK_LISTEN ?? "127.0.0.1:47421";
    const mainPort = Number(listenSpec.split(":")[1]) || 47421;
    const bind = argValue(args, "--bind") ?? listenSpec.split(":")[0] ?? "127.0.0.1";
    const port = Number(argValue(args, "--port")) || mainPort + 1;
    const listener = startPairingListener({
      bind,
      port,
      state,
      paths: p,
      authorizedLines: () => authorizedLinesOf(p),
      onExchanged: ({ state: s, sas }) => {
        console.error("\n" + renderTapBlock(s, sas) + "\n");
        console.error("Exchange complete. Compare the two owners' SAS values, then run:");
        console.error("  npm run botlink -- pair --confirm        (each owner, locally)");
        clearTimeout(ttl);
        setTimeout(() => process.exit(0), 250);
      },
      log,
    });
    const ttl = setTimeout(() => {
      clearPairingState(p);
      listener.close();
      console.error(`botlink-server pair: TTL ${PAIRING_TTL_MS / 60000}min expired — state cleared, nothing written.`);
      process.exit(1);
    }, PAIRING_TTL_MS);
    console.error(
      `armed (${mode}) as "${name}" — single-use listener on ${bind}:${listener.port}, TTL ${PAIRING_TTL_MS / 60000}min.\n` +
        `The PEER runs:  npm run botlink -- pair --dial <this-host>:${listener.port}\n` +
        `Already-paired boxes: this is also how a rotation starts (--rotate).`,
    );
    setInterval(() => void 0, 1 << 30); // stay up like serve
    return;
  }

  if (sub === "--dial") {
    const target = argValue(args, "--dial") ?? "";
    const [host, portStr] = target.split(":");
    if (!host) {
      console.error('botlink-server pair: --dial needs <host>[:port] (peer\'s armed pairing port, main+1).');
      process.exit(1);
    }
    const mode = args.includes("--rotate") ? "rotate" : "first";
    const state: PairingState = {
      v: 1,
      mode,
      status: "armed",
      armedAt: Date.now(),
      self: selfValuesOf(p, mode, name),
      nonce: freshNonce(),
    };
    if (mode === "rotate") {
      if (!fs.existsSync(p.botKeyNext + ".pub")) {
        console.error("botlink-server pair: --dial --rotate needs staged keys — run pair --arm --rotate first.");
        process.exit(1);
      }
    }
    try {
      const { state: done, sas } = await pairDial({
        host,
        port: Number(portStr) || 47422,
        state,
        paths: p,
        authorizedLines: () => authorizedLinesOf(p),
        log,
      });
      console.error("\n" + renderTapBlock(done, sas) + "\n");
      console.error("Exchange complete. Compare the two owners' SAS values, then run:");
      console.error("  npm run botlink -- pair --confirm        (each owner, locally)");
    } catch (err) {
      console.error(`botlink-server pair: dial failed — ${(err as Error).message}`);
      console.error("Nothing was written; arm again if the TTL lapsed.");
      process.exit(1);
    }
    return;
  }

  if (sub === "--confirm") {
    if (!process.stdin.isTTY) {
      // Intent-gathering, not a security boundary (see docs). Refusing
      // non-interactive use keeps scripted/remote automation from riding
      // this path without a human at the terminal.
      console.error("botlink-server pair --confirm: requires an interactive terminal (TTY). Nothing done.");
      process.exit(1);
    }
    const s = loadPairingState(p);
    if (!s || s.status !== "exchanged" || !s.peer?.nonce) {
      console.error('botlink-server pair --confirm: no completed exchange — run "--arm" + peer "--dial" (or vice versa).');
      process.exit(1);
    }
    const sas = sasOfState(s);
    if (sas === null) {
      console.error("botlink-server pair --confirm: exchange incomplete.");
      process.exit(1);
    }
    const plan = buildConfirmPlan(p, s);
    console.error("\n" + renderTapBlock(s, sas) + "\n");
    if (plan.changes.length === 0) {
      console.error("Nothing to change — the peer's values are already pinned. Clearing pairing state.");
      clearPairingState(p);
      return;
    }
    console.error(`This confirm will write: ${plan.changes.join(", ")} (backups kept).`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const typed = await rl.question(
      `Type the PEER's 8-character SAS exactly as shown on the PEER's screen (XXXX-XXXX), to confirm you compared both: `,
    );
    if (normalizeSasInput(typed) !== normalizeSasInput(sas)) {
      rl.close();
      console.error("SAS transcription mismatch — refusing. (If the two SCREENS differ, do NOT confirm: report a possible MITM.)");
      process.exit(1);
    }
    const yes = await rl.question("Commit the pins now? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(yes.trim())) {
      console.error("Declined — nothing written; pairing state kept until TTL expiry.");
      return;
    }
    stageAndCommit(p, plan, new Date().toISOString().replace(/[:.]/g, ""));
    clearPairingState(p); // single-use: a confirmed arm can never confirm twice
    // Pin changes land in the same tamper-evident audit trail as injects
    // (docs/one-tap-pairing.md). Audit-only: a failure is loud but never
    // undoes the committed pins.
    try {
      await appendInjectEvent(defaultSpoolDir(), {
        event: s.mode === "rotate" ? "rotated" : "paired",
        id: `pair-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        source: sanitizePeerText(s.peer!.name),
        target: "pairing",
        detail: `hostkey ${s.peer!.hostkeyFp}, bot ${fingerprintOfPublicKey(s.peer!.botPub)}`,
      });
    } catch (auditErr) {
      console.error(`pair --confirm: AUDIT APPEND FAILED: ${(auditErr as Error).message} — pins are committed, the log entry is lost`);
    }
    console.error(`Committed: ${plan.changes.join(", ")}. Restart botlink services to load the new pins.`);
    return;
  }

  console.error(`botlink-server pair: unknown option "${sub}" (--arm | --dial | --confirm | --status | --rollback)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// companion — phone allow/deny for pairing confirmations (docs/companion-app.md)
// ---------------------------------------------------------------------------

/** For the QR: the address a phone on the same network should dial. A
 *  wildcard bind resolves to the first non-internal IPv4. */
function lanHostForQr(bind: string): string {
  if (bind === "" || bind === "0.0.0.0" || bind === "::" || bind === "[::]") {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return ni.address;
      }
    }
    return "127.0.0.1";
  }
  return bind;
}

function cmdCompanion(args: string[]): void {
  const keydir = argValue(args, "--keys") ?? path.join(PROJECT_ROOT, "botlink-keys");
  const p = keydirPaths(keydir);
  const store = defaultCompanionStore(keydir);
  const sub = args.find((a) => a.startsWith("--")) ?? "--serve";
  const listenSpec = process.env.CLANKER_BOTLINK_LISTEN ?? `127.0.0.1:${PORT_DEFAULT}`;
  const mainPort = Number(listenSpec.split(":")[1]) || PORT_DEFAULT;
  const bind = argValue(args, "--bind") ?? (listenSpec.split(":")[0] || "127.0.0.1");
  const port = Number(argValue(args, "--port")) || mainPort + 2;

  if (sub === "--enroll") {
    const host = lanHostForQr(bind);
    const { token, expiresAt } = issueEnrollToken(store);
    const payload = {
      v: 1,
      kind: "clanker-companion-enroll",
      host,
      port,
      fp: fingerprintOfPublicKey(readPub(p.hostKey + ".pub", "host_key.pub")),
      tkn: token,
    };
    console.error(`companion enrollment — phone scans this QR. Single-use, expires ${new Date(expiresAt).toISOString()}.`);
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      console.error(
        `WARNING: companion bind resolves to loopback (${host}) — phones cannot reach it.\n` +
          `Re-run with --bind <LAN address> (or point CLANKER_BOTLINK_LISTEN at the LAN) before enrolling.`,
      );
    }
    console.error(`Eyeball-check on the phone: the machine fingerprint shown there must be\n  ${payload.fp}`);
    // stderr for the secret-bearing artifact (stdout stays machine-readable).
    qrcode.generate(JSON.stringify(payload), { small: true }, (code) => console.error("\n" + code));
    return;
  }

  if (sub === "--serve") {
    const { close } = startCompanionServer({
      bind,
      port,
      paths: p,
      spoolDir: defaultSpoolDir(),
      store,
      log: (line) => console.error(`companion: ${line}`),
    });
    console.error(`companion: serving on ${bind}:${port} — enroll phones with "companion --enroll".`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        close();
        process.exit(0);
      });
    }
    setInterval(() => void 0, 1 << 30); // stay up like serve
    return;
  }

  console.error(`botlink-server companion: unknown option "${sub}" (--enroll | --serve)`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "keygen") cmdKeygen(rest);
else if (cmd === "fingerprint") cmdFingerprint(rest[0]);
else if (cmd === "report") cmdReport(rest[0]);
else if (cmd === "pair") void cmdPair(rest);
else if (cmd === "companion") cmdCompanion(rest);
else if (cmd === "serve" || cmd === undefined) cmdServe();
else {
  console.error(`botlink-server: unknown command "${cmd}" (keygen | fingerprint | report | pair | serve)`);
  process.exit(1);
}
