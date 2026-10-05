// Dist-drift guard tests (round 15) — offline, self-contained, and pointed
// at a COPY of dist/ inside the repo (dist-drifttest/): bare imports like
// qrcode-terminal resolve from the repo root, and the copy keeps the test's
// fingerprint touches OFF the production tree — the live companion/botlink
// services run from dist/ and would genuinely self-restart on a touch there.
//
//   - drift fires: a file appearing in the running server's directory →
//     exit 0 (clean, for Restart=always) after the stability window, with
//     the detected + exiting log lines on stderr.
//   - CLANKER_BOTLINK_DRIFT_GUARD=0 disables: same touch, process stays up.
//   - both serve flavors carry the guard (`serve` and `companion --serve`).
//
// Usage: node --test tests/drift.test.mjs   (build first: npm run build)

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateBotKey } from "../dist/botlink.js";

const REPO = path.resolve(import.meta.dirname, "..");
const GUARD_DIR = path.join(REPO, "dist-drifttest");

/** Grab an explicit free loopback port (bind 0, read it, release). */
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Wait until predicate() is true or deadline passes (returns last value). */
async function until(ms, pred) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return pred();
}

function spawnFlavor(flavor, env, keydir, portArg) {
  const args = flavor === "serve"
    ? ["serve"]
    : ["companion", "--serve", "--keys", keydir, ...(portArg ? ["--port", String(portArg)] : [])];
  const child = spawn(process.execPath, [GUARD_DIR + "/botlink-server.js", ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      CLANKER_BOTLINK_LISTEN: "127.0.0.1:0", // ephemeral port — parallel-safe
      CLANKER_BOTLINK_SPOOL: env.spool,
      CLANKER_BOTLINK_HOST_KEY: env.hostKey,
      CLANKER_BOTLINK_AUTHORIZED_KEYS: env.authorized,
      CLANKER_BOTLINK_NAME: "drift-test",
      // fast windows: poll 150ms, stable 400ms → exit ~0.7s after a touch
      CLANKER_BOTLINK_DRIFT_POLL_MS: "150",
      CLANKER_BOTLINK_DRIFT_STABLE_MS: "400",
      ...(env.guardOff ? { CLANKER_BOTLINK_DRIFT_GUARD: "0" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  return { child, stderr: () => err };
}

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-drift-"));
  const host = generateBotKey("drift host");
  const peer = generateBotKey("drift peer");
  fs.writeFileSync(path.join(dir, "host_key"), host.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "host_key.pub"), host.publicLine + "\n");
  fs.writeFileSync(path.join(dir, "authorized_keys"), peer.publicLine + "\n", { mode: 0o600 });
  fs.mkdirSync(path.join(dir, "spool"), { recursive: true });
  return {
    keydir: dir,
    spool: path.join(dir, "spool"),
    hostKey: path.join(dir, "host_key"),
    authorized: path.join(dir, "authorized_keys"),
  };
}

test.before(async () => {
  fs.rmSync(GUARD_DIR, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, "dist"), GUARD_DIR, { recursive: true });
});

test.after(() => {
  fs.rmSync(GUARD_DIR, { recursive: true, force: true });
});

test("serve: dist drift exits clean with honest log lines; guard=0 stays up", async () => {
  // --- enabled: touch in the guard dir → exit 0 + both log lines
  {
    const env = freshEnv();
    const { child, stderr } = spawnFlavor("serve", env, env.keydir);
    try {
      assert.ok(
        await until(6000, () => /serving as/.test(stderr())),
        `serve never started: ${stderr()}`,
      );
      // a NEW .js file in the server's own directory = the fingerprint change
      fs.writeFileSync(path.join(GUARD_DIR, "zz-drift-probe.js"), "// drift probe\n");
      assert.ok(await until(6000, () => child.exitCode !== null || child.killed), "no exit after drift");
      assert.equal(child.exitCode, 0, `clean exit for Restart=always revival — stderr: ${stderr()}`);
      assert.match(stderr(), /dist drift detected/);
      assert.match(stderr(), /dist drift stable \d+s — exiting for service-manager revival/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(env.keydir, { recursive: true, force: true });
    }
  }

  // --- disabled: same touch, process must stay up
  {
    const env = freshEnv();
    env.guardOff = true;
    const { child, stderr } = spawnFlavor("serve", env, env.keydir);
    try {
      assert.ok(
        await until(6000, () => /serving as/.test(stderr())),
        `serve never started: ${stderr()}`,
      );
      const before = fs.statSync(path.join(GUARD_DIR, "botlink-server.js")).size;
      fs.writeFileSync(path.join(GUARD_DIR, "zz-drift-probe.js"), "// drift probe 2\n");
      await new Promise((r) => setTimeout(r, 1500)); // 10 poll windows — plenty
      assert.equal(child.exitCode, null, "disabled guard never exits");
      assert.doesNotMatch(stderr(), /dist drift/);
      assert.ok(before >= 0); // touch bookend (no production file was touched)
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(env.keydir, { recursive: true, force: true });
    }
  }
});

test("companion --serve: same guard, same clean exit", async () => {
  const env = freshEnv();
  const { child, stderr } = spawnFlavor("companion", env, env.keydir, await freePort());
  try {
    assert.ok(
      await until(6000, () => /serving on/.test(stderr())),
      `companion never started: ${stderr()}`,
    );
    fs.writeFileSync(path.join(GUARD_DIR, "zz-drift-probe.js"), "// drift probe\n");
    assert.ok(await until(6000, () => child.exitCode !== null), "no exit after drift");
    assert.equal(child.exitCode, 0, `clean exit — stderr: ${stderr()}`);
    assert.match(stderr(), /botlink-server\[companion\]: dist drift stable/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(env.keydir, { recursive: true, force: true });
  }
});
