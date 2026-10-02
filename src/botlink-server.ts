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
 *   node dist/botlink-server.js serve
 *       Listen and serve the two verbs (status / inject). Config from env:
 *         CLANKER_BOTLINK_LISTEN          host:port   (default 127.0.0.1:47421)
 *         CLANKER_BOTLINK_HOST_KEY        path to THIS machine's host key (private)
 *         CLANKER_BOTLINK_AUTHORIZED_KEYS path to authorized_keys (peer bot lines)
 *         CLANKER_BOTLINK_USER            required SSH username (default "clanker")
 *         CLANKER_BOTLINK_SPOOL           inject spool dir (default ./botlink-spool)
 *         CLANKER_BOTLINK_NAME            this bot's link name (default CLANKER_NAME/hostname)
 *
 * stdout is reserved for keygen/fingerprint output; serve logs to stderr.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOfPublicKey, generateBotKey, parseKey, renderInjectReport, startBotlinkServer } from "./botlink.js";

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
  const spoolDir = process.env.CLANKER_BOTLINK_SPOOL ?? path.join(PROJECT_ROOT, "botlink-spool");
  const botName = process.env.CLANKER_BOTLINK_NAME ?? process.env.CLANKER_NAME ?? os.hostname();

  const { close } = startBotlinkServer({
    listen: { host: host || "127.0.0.1", port: Number(portStr) || PORT_DEFAULT },
    hostKeyPem: fs.readFileSync(hostKeyPath, "utf8"),
    authorizedPublicKeys: fs
      .readFileSync(authorizedPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
    username: process.env.CLANKER_BOTLINK_USER,
    spoolDir,
    botName,
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

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`botlink-server: ${name} is required for serve (see header of src/botlink-server.ts)`);
    process.exit(1);
  }
  return v;
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

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "keygen") cmdKeygen(rest);
else if (cmd === "fingerprint") cmdFingerprint(rest[0]);
else if (cmd === "report") cmdReport(rest[0]);
else if (cmd === "serve" || cmd === undefined) cmdServe();
else {
  console.error(`botlink-server: unknown command "${cmd}" (keygen | fingerprint | serve)`);
  process.exit(1);
}
