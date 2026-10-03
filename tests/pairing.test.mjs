// Pairing tests (docs/one-tap-pairing.md) — offline, no Discord, no network
// beyond loopback. Covers the properties the design claims:
//   - SAS: deterministic for honest values, differs under key substitution,
//     truncation collisions don't show up in 10k grinding attempts.
//   - Commit-then-reveal: a reveal that doesn't match the phase-1 commitment
//     aborts the exchange and leaves NOTHING confirmable.
//   - Rotation: signed exchange verified against the pinned old key; a bad
//     signature aborts with nothing written; single-side rotation works.
//   - Input validation: peer text with newlines/ANSI never passes.
//   - Confirm: two-phase journaled commit, backups, grace replace that
//     preserves unrelated peers, auto-revoke of the rotating-from line.
//
// Usage: node --test tests/pairing.test.mjs   (build first: npm run build)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { fingerprintOfPublicKey, generateBotKey } from "../dist/botlink.js";
import {
  buildConfirmPlan,
  commitOf,
  deriveSas,
  freshNonce,
  keydirPaths,
  normalizeSasInput,
  pairDial,
  rollbackInterruptedCommit,
  sanitizePeerText,
  signRotation,
  stageAndCommit,
  startPairingListener,
  stateIsLive,
  stripRotatingLine,
  sweepStaleRotation,
  validatePeerValues,
  verifyRotation,
} from "../dist/pairing.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clanker-pair-"));

function writeKeys(p, name) {
  const host = generateBotKey(`${name} host key`);
  const bot = generateBotKey(`${name} bot key`);
  fs.writeFileSync(p.hostKey, host.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(p.hostKey + ".pub", host.publicLine + "\n");
  fs.writeFileSync(p.botKey, bot.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(p.botKey + ".pub", bot.publicLine + "\n");
  return { host, bot };
}

function readPub(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")).trim();
}

function armedState(self, mode = "first") {
  return {
    v: 1,
    mode,
    status: "armed",
    armedAt: Date.now(),
    self,
    nonce: freshNonce(),
  };
}

// ---------------------------------------------------------------------------

test("SAS: deterministic, role-ordered, substitution-detected", () => {
  const a = { hostkeyFp: "SHA256:" + "A".repeat(43), botPub: "ssh-ed25519 " + "a".repeat(68), nonce: freshNonce() };
  const b = { hostkeyFp: "SHA256:" + "B".repeat(43), botPub: "ssh-ed25519 " + "b".repeat(68), nonce: freshNonce() };
  const sas = deriveSas(a, b);
  assert.match(sas, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(sas, deriveSas(a, b));
  // initiator/responder roles are bound: swapped derivation is a different string
  assert.notEqual(deriveSas(a, b), deriveSas(b, a));
  // substitution of either key material changes the SAS
  const mitm = { ...b, botPub: "ssh-ed25519 " + "e".repeat(68) };
  assert.notEqual(deriveSas(a, b), deriveSas(a, mitm));
  const mitm2 = { ...a, hostkeyFp: "SHA256:" + "C".repeat(43) };
  assert.notEqual(deriveSas(a, b), deriveSas(mitm2, b));
  // nonce freshness: same keys, new nonces → new SAS (no replay)
  assert.notEqual(deriveSas(a, b), deriveSas({ ...a, nonce: freshNonce() }, b));
});

test("SAS: 10k grinding attempts never collide with the honest value", () => {
  const a = { hostkeyFp: "SHA256:" + "A".repeat(43), botPub: "ssh-ed25519 " + "a".repeat(68), nonce: freshNonce() };
  const b = { hostkeyFp: "SHA256:" + "B".repeat(43), botPub: "ssh-ed25519 " + "b".repeat(68), nonce: freshNonce() };
  const honest = normalizeSasInput(deriveSas(a, b));
  for (let i = 0; i < 10_000; i++) {
    const fake = {
      hostkeyFp: "SHA256:" + Buffer.from([i % 256, i % 7, i % 11, i % 13]).toString("base64").padEnd(43, "x").slice(0, 43),
      botPub: "ssh-ed25519 " + Buffer.from(`attacker-${i}`).toString("base64").padEnd(68, "y").slice(0, 68),
      nonce: freshNonce(),
    };
    if (normalizeSasInput(deriveSas(fake, b)) === honest) {
      assert.fail(`grinding collision at attempt ${i} — truncation too short`);
    }
  }
});

test("commitment binds the reveal", () => {
  const n1 = freshNonce();
  const n2 = freshNonce();
  assert.equal(commitOf(n1), commitOf(n1));
  assert.notEqual(commitOf(n1), commitOf(n2));
});

test("validatePeerValues: schema + injection vectors refused", () => {
  const k = generateBotKey("t");
  const base = {
    name: "joesp-desktop",
    hostkeyFp: "SHA256:" + "Q".repeat(43),
    botPub: k.publicLine,
    commit: freshNonce(),
  };
  assert.ok(validatePeerValues(base));
  // newlines / ANSI / oversize / spaces in the name
  for (const bad of ["bad\nname", "bad\x1b[31m", "x".repeat(65), "has space"]) {
    assert.throws(() => validatePeerValues({ ...base, name: bad }), /name/);
  }
  assert.throws(() => validatePeerValues({ ...base, hostkeyFp: "SHA256:short" }), /hostkeyFp/);
  assert.throws(() => validatePeerValues({ ...base, botPub: "not a key" }), /botPub/);
  assert.throws(() => validatePeerValues({ ...base, commit: "zz" }), /commit/);
  assert.throws(() => validatePeerValues({ ...base, nonce: "XY" }), /nonce/);
  // sanitize neutralizes control characters for terminal/log safety (each
  // control char → "?"; the CSI payload "[2j" left behind is inert without ESC)
  const out = sanitizePeerText("a\x1b[2jb\nc");
  assert.equal(out, "a?[2jb?c");
  assert.ok(!/[\x00-\x1f\x7f]/.test(out), "no control chars survive");
});

// --- e2e exchange over loopback --------------------------------------------

function e2eFixture() {
  const dirA = tmp();
  const dirB = tmp();
  const A = keydirPaths(dirA);
  const B = keydirPaths(dirB);
  const keysA = writeKeys(A, "machine-a");
  const keysB = writeKeys(B, "machine-b");
  return { A, B, keysA, keysB };
}

async function withListener(B, state, opts = {}) {
  const logs = [];
  const outcomes = [];
  const listener = startPairingListener({
    bind: "127.0.0.1",
    port: 0,
    state,
    paths: B,
    authorizedLines: () => {
      try {
        return fs.readFileSync(B.authorizedKeys, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      } catch {
        return [];
      }
    },
    onExchanged: (o) => outcomes.push(o),
    log: (l) => logs.push(l),
    ...opts,
  });
  await new Promise((r) => setTimeout(r, 50)); // let listen() bind
  return { listener, outcomes, logs };
}

test("e2e first pairing: both ends derive the SAME SAS; single-use afterwards", async () => {
  const { A, B, keysA, keysB } = e2eFixture();
  const stateB = armedState({
    name: "machine-b",
    hostkeyFp: fingerprintOfPublicKey(keysB.host.publicLine),
    botPub: keysB.bot.publicLine,
  });
  const { listener, outcomes } = await withListener(B, stateB);
  try {
    const stateA = armedState({
      name: "machine-a",
      hostkeyFp: fingerprintOfPublicKey(keysA.host.publicLine),
      botPub: keysA.bot.publicLine,
    });
    const dial = await pairDial({
      host: "127.0.0.1",
      port: listener.port,
      state: stateA,
      paths: A,
      authorizedLines: () => [],
      log: () => {},
    });
    assert.equal(outcomes.length, 1);
    assert.equal(dial.sas, outcomes[0].sas); // identical SAS on both screens
    assert.equal(dial.state.role, "initiator");
    assert.equal(outcomes[0].state.role, "responder");
    assert.ok(dial.state.peer.nonce && outcomes[0].state.peer.nonce);
    // single-use: a second dial cannot connect (listener closed)
    await assert.rejects(() =>
      pairDial({
        host: "127.0.0.1",
        port: listener.port,
        state: armedState(stateA.self),
        paths: A,
        authorizedLines: () => [],
        log: () => {},
      }),
    );
  } finally {
    listener.close();
  }
});

test("e2e reveal-mismatch aborts: nothing confirmable remains", async () => {
  const { B, keysB } = e2eFixture();
  const stateB = armedState({
    name: "machine-b",
    hostkeyFp: fingerprintOfPublicKey(keysB.host.publicLine),
    botPub: keysB.bot.publicLine,
  });
  const { listener, logs } = await withListener(B, stateB);
  try {
  // raw hostile socket: valid phase 1, then a reveal that doesn't match
  await new Promise((resolve, reject) => {
    const sock = net.connect(listener.port, "127.0.0.1");
    sock.on("error", reject);
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      if (!buf.includes("\n")) return;
      // phase-1 reply arrived → send the WRONG reveal
      sock.write(JSON.stringify({ cmd: "pair-hello", phase: 2, nonce: freshNonce() }) + "\n");
      sock.end();
      setTimeout(resolve, 150);
    });
    sock.write(
      JSON.stringify({
        cmd: "pair-hello",
        phase: 1,
        peer: {
          name: "attacker",
          hostkeyFp: "SHA256:" + "Z".repeat(43),
          botPub: generateBotKey("attacker").publicLine,
          commit: commitOf("0".repeat(64)), // commitment for a DIFFERENT nonce
        },
      }) + "\n",
    );
  });
  assert.ok(logs.some((l) => l.includes("does not match commitment")), logs.join("; "));
    // half-exchange wiped: no peer stored → confirm impossible
    const saved = JSON.parse(fs.readFileSync(B.state, "utf8"));
    assert.equal(saved.peer, undefined);
  } finally {
    listener.close();
  }
});

test("e2e rotation: signed exchange verifies against the pinned OLD key; bad sig aborts", async () => {
  const { A, B, keysA, keysB } = e2eFixture();
  // Both rotate: B stages .next keys; each side pins the other's OLD bot key.
  const nextB = writeKeys({ ...B, hostKey: B.hostKeyNext, botKey: B.botKeyNext }, "machine-b-next");
  fs.writeFileSync(A.authorizedKeys, keysB.bot.publicLine + "\n");
  fs.writeFileSync(B.authorizedKeys, keysA.bot.publicLine + "\n");
  const stateB = armedState(
    {
      name: "machine-b",
      hostkeyFp: fingerprintOfPublicKey(nextB.host.publicLine),
      botPub: nextB.bot.publicLine,
    },
    "rotate",
  );
  const { listener, outcomes } = await withListener(B, stateB);
  try {
    const stateA = armedState({
      name: "machine-a",
      hostkeyFp: fingerprintOfPublicKey(keysA.host.publicLine),
      botPub: keysA.bot.publicLine,
    });
    const dial = await pairDial({
      host: "127.0.0.1",
      port: listener.port,
      state: { ...stateA, mode: "rotate" },
      paths: A,
      authorizedLines: () => [keysB.bot.publicLine],
      log: () => {},
    });
    assert.equal(outcomes.length, 1);
    assert.equal(dial.sas, outcomes[0].sas);
    // each side recorded the OTHER's old public line as the rotation anchor
    assert.equal(dial.state.peer.prevBotPub.trim(), keysB.bot.publicLine.trim());
    assert.equal(outcomes[0].state.peer.prevBotPub.trim(), keysA.bot.publicLine.trim());
  } finally {
    listener.close();
  }

  // --- hostile dial: claims the pinned old identity, reveal matches its own
  // commitment, but the signature is forged → aborted, nothing confirmable.
  const stateB2 = armedState(
    {
      name: "machine-b",
      hostkeyFp: fingerprintOfPublicKey(nextB.host.publicLine),
      botPub: nextB.bot.publicLine,
    },
    "rotate",
  );
  const l2 = await withListener(B, stateB2);
  const attackerNonce = freshNonce();
  try {
    await new Promise((resolve, reject) => {
      const sock = net.connect(l2.listener.port, "127.0.0.1");
      sock.on("error", reject);
      let buf = "";
      sock.on("data", (c) => {
        buf += c.toString();
        if (!buf.includes("\n")) return;
        sock.write(
          JSON.stringify({
            cmd: "pair-hello",
            phase: 2,
            nonce: attackerNonce,
            sig: Buffer.from("forged").toString("base64"),
          }) + "\n",
        );
        sock.end();
        setTimeout(resolve, 150);
      });
      sock.write(
        JSON.stringify({
          cmd: "pair-hello",
          phase: 1,
          peer: {
            name: "machine-a",
            hostkeyFp: fingerprintOfPublicKey(keysA.host.publicLine),
            botPub: nextB.bot.publicLine,
            commit: commitOf(attackerNonce),
            prevBotPub: keysA.bot.publicLine, // claims the identity pinned on B
          },
        }) + "\n",
      );
    });
    assert.ok(l2.logs.some((l) => l.includes("signature FAILED")), l2.logs.join("; "));
    const saved2 = JSON.parse(fs.readFileSync(B.state, "utf8"));
    assert.equal(saved2.peer, undefined);
  } finally {
    l2.listener.close();
  }
});

test("e2e single-side rotation: responder rotates, initiator dials first-mode", async () => {
  const { A, B, keysA, keysB } = e2eFixture();
  const nextB = writeKeys({ ...B, hostKey: B.hostKeyNext, botKey: B.botKeyNext }, "machine-b-next2");
  fs.writeFileSync(A.authorizedKeys, keysB.bot.publicLine + "\n");
  fs.writeFileSync(B.authorizedKeys, keysA.bot.publicLine + "\n");
  const stateB = armedState(
    {
      name: "machine-b",
      hostkeyFp: fingerprintOfPublicKey(nextB.host.publicLine),
      botPub: nextB.bot.publicLine,
    },
    "rotate",
  );
  const { listener, outcomes } = await withListener(B, stateB);
  try {
    const stateA = armedState({
      name: "machine-a",
      hostkeyFp: fingerprintOfPublicKey(keysA.host.publicLine),
      botPub: keysA.bot.publicLine,
    });
    // dialer is FIRST-mode: no prevBotPub claim, no signature from A — B must
    // not demand one, and A must still verify B's rotation signature.
    const dial = await pairDial({
      host: "127.0.0.1",
      port: listener.port,
      state: stateA,
      paths: A,
      authorizedLines: () => [keysB.bot.publicLine],
      log: () => {},
    });
    assert.equal(dial.sas, outcomes[0].sas);
    assert.equal(dial.state.peer.prevBotPub.trim(), keysB.bot.publicLine.trim());
    assert.equal(outcomes[0].state.peer.prevBotPub, undefined); // A claimed no rotation
  } finally {
    listener.close();
  }
});

// --- confirm: plan + journaled commit --------------------------------------

function exchangedState(self, peer, mode = "first", role = "initiator") {
  return { v: 1, mode, status: "exchanged", armedAt: Date.now(), role, self, nonce: freshNonce(), peer: { ...peer, nonce: freshNonce() } };
}

test("confirm plan: first pairing adds the peer, preserves unrelated peers", () => {
  const dir = tmp();
  const p = keydirPaths(dir);
  writeKeys(p, "local");
  const otherPeer = generateBotKey("other-peer");
  fs.writeFileSync(p.authorizedKeys, otherPeer.publicLine + "\n");
  const peerKey = generateBotKey("peer");
  const s = exchangedState(
    { name: "local", hostkeyFp: "SHA256:" + "L".repeat(43), botPub: readPub(p.botKey + ".pub") },
    { name: "peer", hostkeyFp: "SHA256:" + "P".repeat(43), botPub: peerKey.publicLine, commit: freshNonce() },
  );
  const plan = buildConfirmPlan(p, s);
  const lines = plan.authorizedKeys.split("\n").filter(Boolean);
  assert.ok(lines.includes(otherPeer.publicLine), "unrelated peer preserved");
  assert.ok(lines.includes(peerKey.publicLine), "new peer added");
  assert.deepEqual(plan.changes.sort(), ["authorized_keys", "peer.hostkey"].sort());
  assert.equal(plan.cutoverSelfKeys, false);
  stageAndCommit(p, plan, "teststamp");
  const committed = fs.readFileSync(p.authorizedKeys, "utf8");
  assert.ok(committed.includes(peerKey.publicLine));
  assert.ok(fs.existsSync(p.authorizedKeys + ".bak-teststamp"));
  assert.equal(fs.readFileSync(p.peerHostkey, "utf8").trim(), "SHA256:" + "P".repeat(43));
});

test("confirm plan: rotation = replace-with-grace, cutover of .next keys, auto-revoke", () => {
  const dir = tmp();
  const p = keydirPaths(dir);
  writeKeys(p, "local");
  const oldPeer = generateBotKey("peer-old");
  const newPeer = generateBotKey("peer-new");
  const thirdParty = generateBotKey("third");
  fs.writeFileSync(p.authorizedKeys, `${oldPeer.publicLine}\n${thirdParty.publicLine}\n`);
  const s = exchangedState(
    { name: "local", hostkeyFp: "SHA256:" + "L".repeat(43), botPub: readPub(p.botKey + ".pub") },
    { name: "peer", hostkeyFp: "SHA256:" + "N".repeat(43), botPub: newPeer.publicLine, commit: freshNonce(), prevBotPub: oldPeer.publicLine },
    "rotate",
    "responder",
  );
  // staged .next for the LOCAL rotation cutover
  const nextLocal = writeKeys({ ...p, hostKey: p.hostKeyNext, botKey: p.botKeyNext }, "local-next");
  const plan = buildConfirmPlan(p, s);
  assert.equal(plan.cutoverSelfKeys, true);
  const lines = plan.authorizedKeys.split("\n");
  assert.ok(lines.some((l) => l.includes("# rotating-from") && l.includes(oldPeer.publicLine.split(" ")[1])), "old line kept, marked");
  assert.ok(lines.includes(newPeer.publicLine), "new line active");
  assert.ok(lines.includes(thirdParty.publicLine), "third peer untouched");
  stageAndCommit(p, plan, "rot1");
  // .next became active — private AND pub sidecar (a pub left behind would
  // claim the old key while the daemon serves the new one)
  assert.ok(!fs.existsSync(p.botKeyNext));
  assert.equal(readPub(p.botKey + ".pub"), nextLocal.bot.publicLine);

  // auto-revoke: only the auth of a DIFFERENT key retires the marked line —
  // auth presenting the marked key itself changes nothing
  const committed = fs.readFileSync(p.authorizedKeys, "utf8");
  assert.equal(stripRotatingLine(committed, fingerprintOfPublicKey(newPeer.publicLine)), null);
  const afterOld = stripRotatingLine(committed, fingerprintOfPublicKey(oldPeer.publicLine));
  assert.ok(afterOld !== null && !afterOld.includes("# rotating-from"));
  assert.ok(afterOld.includes(newPeer.publicLine));
  // grace sweep drops a stale marked line past its window; fresh ones stay
  const stale = committed.replace(
    /# rotating-from (\S+)/,
    `# rotating-from ${new Date(Date.now() - 25 * 3600_000).toISOString()}`,
  );
  const swept = sweepStaleRotation(stale);
  assert.ok(swept !== null && !swept.includes("# rotating-from"));
  assert.equal(sweepStaleRotation(committed), null, "fresh grace lines stay");
});

test("journaled commit: interrupted phase is detected and finished or cleaned", () => {
  const dir = tmp();
  const p = keydirPaths(dir);
  fs.mkdirSync(p.stageDir, { recursive: true });
  // no journal → nothing to do
  assert.equal(rollbackInterruptedCommit(p), false);
  // staged journal + staged file → completes the rename
  fs.writeFileSync(path.join(p.stageDir, "journal.json"), JSON.stringify({ phase: "staged", backupStamp: "x1" }));
  fs.writeFileSync(path.join(p.stageDir, "authorized_keys"), "staged-content\n");
  assert.equal(rollbackInterruptedCommit(p), true);
  assert.equal(fs.readFileSync(p.authorizedKeys, "utf8"), "staged-content\n");
  assert.ok(!fs.existsSync(p.stageDir));
});

test("TTL: expired state is not live — fail closed", () => {
  const stale = { v: 1, mode: "first", status: "exchanged", armedAt: Date.now() - 11 * 60_000, self: { name: "x", hostkeyFp: "", botPub: "" }, nonce: freshNonce() };
  assert.equal(stateIsLive(stale), false);
  assert.equal(stateIsLive(null), false);
});

test("rotation signatures: sign with the old key, verify; tamper fails", () => {
  const k = generateBotKey("signer");
  const a = { hostkeyFp: "SHA256:" + "A".repeat(43), botPub: "ssh-ed25519 " + "a".repeat(68), nonce: freshNonce() };
  const b = { hostkeyFp: "SHA256:" + "B".repeat(43), botPub: "ssh-ed25519 " + "b".repeat(68), nonce: freshNonce() };
  const sig = signRotation(k.privatePem, a, b);
  assert.ok(verifyRotation(k.publicLine, a, b, sig));
  assert.equal(verifyRotation(k.publicLine, { ...a, nonce: freshNonce() }, b, sig), false, "tampered transcript rejected");
  const other = generateBotKey("other");
  assert.equal(verifyRotation(other.publicLine, a, b, sig), false, "wrong anchor key rejected");
});
