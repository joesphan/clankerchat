/**
 * Guard tests for the tyler-hardening locks (CLANKER_ROLE=project).
 *
 * All offline: a dummy Discord token means any call that would reach Discord
 * fails with a login/ready error — which is exactly how we tell "blocked by
 * the lock" (canned guard error) apart from "passed the lock" (Discord error).
 * Expect "Discord login failed" lines on stderr; they are not failures.
 *
 * Usage: node --test tests/guards.test.mjs   (build first: npm run build)
 */

import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(root, "dist", "index.js");
const ALLOWED = "111111111111111111"; // fake snowflake — never hits Discord in tests that pass

function startServer(extraEnv) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      // Sanitize hardening keys so they never leak from the test runner's
      // environment — control cases must be genuinely unlocked unless
      // extraEnv explicitly sets them (undefined values are omitted from
      // the child env by node's spawn).
      ...Object.fromEntries(
        [
          "CLANKER_ROLE",
          "CLANKER_ALLOWED_THREADS",
          "CLANKER_FILE_ROOT",
          "CLANKER_BLOCKED_IDS",
          "CLANKER_BLOCKLIST_FILE",
        ].map((k) => [k, undefined]),
      ),
      DISCORD_TOKEN: "guards-test-dummy-token",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // login-failed noise is expected

  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });

  let nextId = 1;
  const rpc = (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15_000).unref();
    });
  };

  const call = async (name, args) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const text = res?.result?.content?.[0]?.text ?? "";
    return { isError: res?.result?.isError === true, body: JSON.parse(text) };
  };

  return { child, rpc, call, stop: () => child.kill() };
}

async function ready(server) {
  await server.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "guards-test", version: "0" },
  });
}

// --- locked instance --------------------------------------------------------

const jail = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-jail-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-outside-"));
fs.writeFileSync(path.join(jail, "ok.txt"), "inside");
fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(jail, "escape-link.txt"));

const locked = startServer({
  CLANKER_ROLE: "project",
  CLANKER_ALLOWED_THREADS: ALLOWED,
  CLANKER_FILE_ROOT: jail,
});

test.before(async () => {
  await ready(locked);
});

test.after(() => {
  locked.stop();
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("send to foreign channel_id is rejected by the lock, not by Discord", async () => {
  const r = await locked.call("send", { channel_id: "999999999999999999", message: "x" });
  assert.ok(r.isError, "must be an error");
  assert.match(r.body.error, /not permitted/);
});

test("send to allowed thread id passes the lock (fails at Discord instead)", async () => {
  const r = await locked.call("send", { channel_id: ALLOWED, message: "x" });
  assert.ok(r.isError, "dummy token — Discord itself must fail");
  assert.doesNotMatch(r.body.error, /not permitted|refusing/);
});

test("send with empty ALLOWED_THREADS refuses every target", async () => {
  const none = startServer({ CLANKER_ROLE: "project", CLANKER_ALLOWED_THREADS: "" });
  await ready(none);
  const r = await none.call("send", { channel_id: ALLOWED, message: "x" });
  none.stop();
  assert.ok(r.isError);
  assert.match(r.body.error, /refusing every target/);
});

// --- blocked-ID quarantine (mode-independent, absolute) ----------------------

const BLOCKED = "222222222222222222";

test("quarantine: send/read/list_threads/create_thread on a blocked id fail closed, any role", async () => {
  const q = startServer({ CLANKER_BLOCKED_IDS: BLOCKED }); // NO role set — must apply anyway
  await ready(q);
  for (const [tool, args] of [
    ["send", { channel_id: BLOCKED, message: "x" }],
    ["read", { channel_id: BLOCKED }],
    ["list_threads", { channel_id: BLOCKED }],
    ["create_thread", { name: "t", channel_id: BLOCKED }],
  ]) {
    const r = await q.call(tool, args);
    assert.ok(r.isError, `${tool} must be an error`);
    assert.match(r.body.error, /blocked/); // canned quarantine error, not Discord noise
  }
  q.stop();
});

test("quarantine: unblocked id still passes to Discord (dummy-token failure)", async () => {
  const q = startServer({ CLANKER_BLOCKED_IDS: BLOCKED });
  await ready(q);
  const r = await q.call("send", { channel_id: ALLOWED, message: "x" });
  q.stop();
  assert.ok(r.isError);
  assert.doesNotMatch(r.body.error, /blocked|not permitted|refusing/);
});

test("quarantine: takes precedence over the project-mode allowlist", async () => {
  const q = startServer({
    CLANKER_ROLE: "project",
    CLANKER_ALLOWED_THREADS: ALLOWED,
    CLANKER_BLOCKED_IDS: `${BLOCKED},${ALLOWED}`,
  });
  await ready(q);
  const r = await q.call("send", { channel_id: ALLOWED, message: "x" });
  q.stop();
  assert.ok(r.isError);
  assert.match(r.body.error, /blocked/); // quarantine error, not the allowlist's "not permitted"
});

test("quarantine: blocklist file re-reads on mtime change, no restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-block-"));
  const file = path.join(dir, "blocklist.txt");
  fs.writeFileSync(file, `# comment line\n${BLOCKED}\nnot-a-snowflake\n`);
  const q = startServer({ CLANKER_BLOCKLIST_FILE: file });
  await ready(q);
  const first = await q.call("send", { channel_id: BLOCKED, message: "x" });
  assert.ok(first.isError);
  assert.match(first.body.error, /blocked/);
  const LATER = "444444444444444444";
  fs.appendFileSync(file, `${LATER}\n`);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // force a distinct mtime
  const second = await q.call("send", { channel_id: LATER, message: "x" });
  q.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(second.isError);
  assert.match(second.body.error, /blocked/);
});

test("attachment outside FILE_ROOT is rejected", async () => {
  const r = await locked.call("send", {
    channel_id: ALLOWED,
    message: "x",
    file_path: path.join(outside, "secret.txt"),
  });
  assert.ok(r.isError);
  assert.match(r.body.error, /must live inside/);
});

test("attachment via .. escape is rejected", async () => {
  const r = await locked.call("send", {
    channel_id: ALLOWED,
    message: "x",
    // Points at a file that EXISTS outside the root — a containment-free
    // implementation would find the file and send it, so only the jail
    // error passes this test (not "File not found").
    file_path: path.join(jail, "..", path.basename(outside), "secret.txt"),
  });
  assert.ok(r.isError);
  assert.match(r.body.error, /must live inside/);
});

test("attachment via symlink inside root pointing outside is rejected", async () => {
  const r = await locked.call("send", {
    channel_id: ALLOWED,
    message: "x",
    file_path: path.join(jail, "escape-link.txt"),
  });
  assert.ok(r.isError);
  assert.match(r.body.error, /must live inside/);
});

test("attachment inside FILE_ROOT passes the jail (fails at Discord instead)", async () => {
  const r = await locked.call("send", {
    channel_id: ALLOWED,
    message: "x",
    file_path: path.join(jail, "ok.txt"),
  });
  assert.ok(r.isError, "dummy token — Discord itself must fail");
  assert.doesNotMatch(r.body.error, /must live inside|disabled/);
});

test("CLANKER_FILE_ROOT=none disables attachments entirely", async () => {
  const none = startServer({
    CLANKER_ROLE: "project",
    CLANKER_ALLOWED_THREADS: ALLOWED,
    CLANKER_FILE_ROOT: "none",
  });
  await ready(none);
  const r = await none.call("send", {
    channel_id: ALLOWED,
    message: "x",
    file_path: path.join(jail, "ok.txt"),
  });
  none.stop();
  assert.ok(r.isError);
  assert.match(r.body.error, /Attachments are disabled/);
});

test("list_channels is disabled in project mode", async () => {
  const r = await locked.call("list_channels", {});
  assert.ok(r.isError);
  assert.match(r.body.error, /disabled on this clankerchat instance/);
});

test("list_threads is disabled in project mode", async () => {
  const r = await locked.call("list_threads", {});
  assert.ok(r.isError);
  assert.match(r.body.error, /disabled on this clankerchat instance/);
});

test("create_thread is disabled in project mode", async () => {
  const r = await locked.call("create_thread", { name: "Shim" });
  assert.ok(r.isError);
  assert.match(r.body.error, /disabled on this clankerchat instance/);
});

// --- unlocked instance (orchestrator / legacy) ------------------------------

const open = startServer({}); // no CLANKER_ROLE — upstream behavior

test("unlocked instance: foreign channel_id is NOT blocked by a lock", async () => {
  await ready(open);
  const r = await open.call("send", { channel_id: "999999999999999999", message: "x" });
  assert.ok(r.isError, "dummy token — Discord itself must fail");
  assert.doesNotMatch(r.body.error, /not permitted|refusing|disabled/);
});

test("unlocked instance: list_channels is not canned-disabled", async () => {
  const r = await open.call("list_channels", {});
  assert.ok(r.isError, "dummy token — Discord itself must fail");
  assert.doesNotMatch(r.body.error, /disabled on this clankerchat instance/);
});

test.after(() => {
  open.stop();
});

// --- outbound tripwires on the COMPOSED wire string (2026-10-04 audit) -------
// The leak scan must cover withSender's output: a shape hidden in the sender
// param (send) or a thread's opening message (create_thread — previously
// mass-mention-only) is an exfil path the raw-message scans missed.

test("send: leak shape in the SENDER param is refused (composed-string scan)", async () => {
  const s = startServer({});
  await ready(s);
  const r = await s.call("send", {
    channel_id: ALLOWED,
    message: "clean body, the identity is the problem",
    sender: "stolen-key sk-" + "z".repeat(32),
  });
  s.stop();
  assert.ok(r.isError, "must refuse");
  assert.match(r.body.error, /^REFUSED:.*secret-shape/);
});

test("create_thread: leak-shaped opening message refused BEFORE the thread is minted", async () => {
  const s = startServer({});
  await ready(s);
  const r = await s.call("create_thread", {
    name: "t",
    channel_id: ALLOWED,
    message: "here is a github token ghp_" + "a".repeat(36),
  });
  s.stop();
  // REFUSED = the local tripwire fired; any other error means the request got
  // as far as Discord (dummy token) — i.e. the scan ran too late or not at all.
  assert.ok(r.isError, "must refuse");
  assert.match(r.body.error, /^REFUSED:.*secret-shape/);
  assert.doesNotMatch(r.body.error, /Could not create thread/);
});
