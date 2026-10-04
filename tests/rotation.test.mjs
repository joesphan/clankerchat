// Rotation zero-touch (owner 2026-10-04: "automatically rotate … all we need
// to do is use the app, no console" + "confirm and it keeps going"):
//  - client pin resolution is per-call and the ceremony file beats env;
//  - the daemon serves a rotated host key + refreshed authorized_keys after
//    an mtime poll, with no process restart;
//  - a torn/garbage key write never wedges the lane (previous key keeps
//    serving until a parseable file lands).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateBotKey, startBotlinkServer, botlinkRequest, resolveBotlinkPeerFromEnv } from "../dist/botlink.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "botlink-rotation-"));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("client pin precedence: ceremony file beats env, and file changes are live", () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "botlink-keys"), { recursive: true });
  const pinFile = path.join(root, "botlink-keys", "peer.hostkey");
  const keyA = generateBotKey("peer-host-a");
  const keyB = generateBotKey("peer-host-b");
  const bot = generateBotKey("self-bot");
  const botKeyFile = path.join(root, "bot_key");
  fs.writeFileSync(botKeyFile, bot.privatePem + "\n", { mode: 0o600 });

  const env = {
    CLANKER_BOTLINK_PEER: "100.64.0.4:47421",
    CLANKER_BOTLINK_KEY: botKeyFile,
    CLANKER_BOTLINK_PEER_HOSTKEY: keyA.fingerprint, // stale env pin
  };

  // No file → env fallback still works (pre-pairing bootstrap).
  const boot = resolveBotlinkPeerFromEnv(env, root);
  assert.equal(boot?.expectedHostKey, keyA.fingerprint, "env pin used when no file exists");

  // File appears (ceremony wrote it) → FILE wins over the env value.
  fs.writeFileSync(pinFile, keyB.fingerprint + "\n", { mode: 0o600 });
  const pinned = resolveBotlinkPeerFromEnv(env, root);
  assert.equal(pinned?.expectedHostKey, keyB.fingerprint, "ceremony file beats env pin");

  // Rotation rewrites the file → the NEXT call sees the new pin (no process
  // restart — this is the whole point).
  fs.writeFileSync(pinFile, keyA.fingerprint + "\n", { mode: 0o600 });
  assert.equal(resolveBotlinkPeerFromEnv(env, root)?.expectedHostKey, keyA.fingerprint, "rotated pin picked up on next call");

  // Incomplete env → lane reported unconfigured.
  assert.equal(resolveBotlinkPeerFromEnv({ CLANKER_BOTLINK_PEER: "x" }, root), null);
});

test("daemon hot-reload: a rotation cutover serves new keys with no restart", async (t) => {
  const dir = tmpDir();
  const genA = generateBotKey("host-a");
  const genB = generateBotKey("host-b");
  const botA = generateBotKey("bot-a");
  const botB = generateBotKey("bot-b");
  const hostKeyFile = path.join(dir, "host_key");
  const authFile = path.join(dir, "authorized_keys");
  fs.writeFileSync(hostKeyFile, genA.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(authFile, botA.publicLine + "\n", { mode: 0o600 });
  const spool = path.join(dir, "spool");

  const srv = startBotlinkServer({
    listen: { host: "127.0.0.1", port: 0 },
    hostKeyPem: fs.readFileSync(hostKeyFile, "utf8"),
    authorizedPublicKeys: [botA.publicLine],
    hostKeyPath: hostKeyFile,
    authorizedKeysPath: authFile,
    keyReloadIntervalMs: 40,
    spoolDir: spool,
    botName: "hot-reload-machine",
  });
  t.after(() => srv.close());
  await srv.listening;

  const client = (hostFp, bot) => ({
    host: "127.0.0.1",
    port: srv.port,
    privateKeyPem: bot.privatePem,
    expectedHostKey: hostFp,
  });

  // Baseline: keyset A works.
  assert.equal(JSON.parse(await botlinkRequest(client(genA.fingerprint, botA), "status")).bot, "hot-reload-machine");

  // The confirmed rotation cutover rewrites both files (as stageAndCommit does).
  fs.writeFileSync(hostKeyFile, genB.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(authFile, botB.publicLine + "\n", { mode: 0o600 });
  await sleep(300); // several poll intervals

  // New keyset works against the SAME server process; the old bot key is
  // retired and the old host pin no longer matches.
  assert.equal(JSON.parse(await botlinkRequest(client(genB.fingerprint, botB), "status")).bot, "hot-reload-machine");
  await assert.rejects(() => botlinkRequest(client(genA.fingerprint, botA), "status"));
});

test("daemon hot-reload: garbage host-key write never wedges the lane", async (t) => {
  const dir = tmpDir();
  const gen = generateBotKey("host-stable");
  const botA = generateBotKey("bot-stable");
  const hostKeyFile = path.join(dir, "host_key");
  const authFile = path.join(dir, "authorized_keys");
  fs.writeFileSync(hostKeyFile, gen.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(authFile, botA.publicLine + "\n", { mode: 0o600 });

  const srv = startBotlinkServer({
    listen: { host: "127.0.0.1", port: 0 },
    hostKeyPem: fs.readFileSync(hostKeyFile, "utf8"),
    authorizedPublicKeys: [botA.publicLine],
    hostKeyPath: hostKeyFile,
    keyReloadIntervalMs: 40,
    spoolDir: path.join(dir, "spool"),
    botName: "stable-machine",
  });
  t.after(() => srv.close());
  await srv.listening;

  const peer = { host: "127.0.0.1", port: srv.port, privateKeyPem: botA.privatePem, expectedHostKey: gen.fingerprint };
  assert.ok(JSON.parse(await botlinkRequest(peer, "status")).ok);

  // A torn/partial write (crash mid-cutover, disk hiccup) must be skipped:
  // the daemon keeps serving the previous key and retries on later polls.
  fs.writeFileSync(hostKeyFile, "NOT A KEY —— torn write\n", { mode: 0o600 });
  await sleep(300);
  assert.ok(JSON.parse(await botlinkRequest(peer, "status")).ok, "previous key still serving after garbage write");
});

test("daemon hot-reload: authorized_keys-only change refreshes peers without a rebuild", async (t) => {
  const dir = tmpDir();
  const gen = generateBotKey("host-authonly");
  const botA = generateBotKey("bot-authonly-a");
  const botB = generateBotKey("bot-authonly-b");
  const hostKeyFile = path.join(dir, "host_key");
  const authFile = path.join(dir, "authorized_keys");
  fs.writeFileSync(hostKeyFile, gen.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(authFile, botA.publicLine + "\n", { mode: 0o600 });

  const srv = startBotlinkServer({
    listen: { host: "127.0.0.1", port: 0 },
    hostKeyPem: fs.readFileSync(hostKeyFile, "utf8"),
    authorizedPublicKeys: [botA.publicLine],
    authorizedKeysPath: authFile, // no hostKeyPath → authorized-only watching
    keyReloadIntervalMs: 40,
    spoolDir: path.join(dir, "spool"),
    botName: "authonly-machine",
  });
  t.after(() => srv.close());
  await srv.listening;

  const client = (bot) => ({ host: "127.0.0.1", port: srv.port, privateKeyPem: bot.privatePem, expectedHostKey: gen.fingerprint });
  assert.ok(JSON.parse(await botlinkRequest(client(botA), "status")).ok);

  // Peer rotates its bot key only (host key untouched): the new line takes
  // over, the old one is gone.
  fs.writeFileSync(authFile, botB.publicLine + "\n", { mode: 0o600 });
  await sleep(300);
  assert.ok(JSON.parse(await botlinkRequest(client(botB), "status")).ok, "new peer key accepted after file change");
  await assert.rejects(() => botlinkRequest(client(botA), "status"));
});
