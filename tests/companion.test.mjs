// Companion tests (docs/companion-app.md) — offline, no Discord, loopback
// HTTP only. Covers the properties the design claims:
//   - Enrollment: token single-use + TTL; phone pub schema enforced.
//   - Request auth: unknown key / tampered body / tampered path / replayed
//     counter all fail closed; a passing counter is consumed even when the
//     handler later refuses (no re-asking the same request).
//   - ALLOW = the CLI confirm: wrong typed SAS refuses with trust files
//     byte-identical; right SAS commits pins + backups + audit event with
//     via=companion:<phone>, clears state, single-use second allow refused.
//   - DENY clears state, writes nothing.
//   - renderAttempt sanitizes peer text; attemptId is transcript-bound.
//   - CLI: companion --enroll prints QR + loopback warning, exit 0.
//
// Usage: node --test tests/companion.test.mjs   (build first: npm run build)

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendInjectEvent, fingerprintOfPublicKey, generateBotKey, parseKey } from "../dist/botlink.js";
import {
  companionRequestMessage,
  companionStore,
  consumeEnrollToken,
  defaultCompanionStore,
  denyAttempt,
  enrollPhone,
  issueEnrollToken,
  renderAttempt,
  startCompanionServer,
  validatePhonePub,
  verifyCompanionRequest,
} from "../dist/companion.js";
import {
  attemptIdOfState,
  commitOf,
  freshNonce,
  keydirPaths,
  sasOfState,
  savePairingState,
} from "../dist/pairing.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clanker-comp-"));

function writeKeys(p, name) {
  fs.mkdirSync(p.dir, { recursive: true });
  const host = generateBotKey(`${name} host key`);
  const bot = generateBotKey(`${name} bot key`);
  fs.writeFileSync(p.hostKey, host.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(p.hostKey + ".pub", host.publicLine + "\n");
  fs.writeFileSync(p.botKey, bot.privatePem + "\n", { mode: 0o600 });
  fs.writeFileSync(p.botKey + ".pub", bot.publicLine + "\n");
  return { host, bot };
}

/** A completed first-pairing exchange, exactly the shape pairDial persists. */
function exchangedState(selfKeys, peerKeys, selfName, peerName) {
  const peerNonce = freshNonce();
  return {
    v: 1,
    mode: "first",
    status: "exchanged",
    armedAt: Date.now(),
    role: "initiator",
    self: {
      name: selfName,
      hostkeyFp: fingerprintOfPublicKey(selfKeys.host.publicLine),
      botPub: selfKeys.bot.publicLine,
    },
    nonce: freshNonce(),
    peer: {
      name: peerName,
      hostkeyFp: fingerprintOfPublicKey(peerKeys.host.publicLine),
      botPub: peerKeys.bot.publicLine,
      commit: commitOf(peerNonce),
      nonce: peerNonce,
    },
  };
}

// ---------------------------------------------------------------------------

test("enrollment token: single-use + TTL + wrong-token does not burn the real one", () => {
  const dir = tmp();
  const store = companionStore(path.join(dir, "companion-keys"));
  const { token } = issueEnrollToken(store);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(consumeEnrollToken(store, token), "first consume succeeds");
  assert.equal(consumeEnrollToken(store, token), false, "second consume fails");
  // A NEW token is unaffected by the consumed one.
  const t2 = issueEnrollToken(store).token;
  assert.equal(consumeEnrollToken(store, "f".repeat(64)), false, "wrong token fails");
  assert.ok(consumeEnrollToken(store, t2), "real token survives a wrong attempt");
  // Expired: craft the record in the past.
  const t3 = issueEnrollToken(store).token;
  const rec = JSON.parse(fs.readFileSync(store.enrollFile, "utf8"));
  rec.expiresAt = Date.now() - 1000;
  fs.writeFileSync(store.enrollFile, JSON.stringify(rec));
  assert.equal(consumeEnrollToken(store, t3), false, "expired token fails");
});

test("validatePhonePub: schema + injection vectors refused", () => {
  const k = generateBotKey("phone");
  assert.equal(validatePhonePub(k.publicLine), k.publicLine.trim());
  for (const bad of ["", "not a key", "ssh-ed25519 AAAA\nssh-ed25519 BBBB", "x".repeat(700), "ssh-ed25519"]) {
    assert.throws(() => validatePhonePub(bad), undefined, `should refuse ${JSON.stringify(bad.slice(0, 20))}`);
  }
});

test("verifyCompanionRequest: pin, tamper, replay", async () => {
  const dir = tmp();
  const store = companionStore(path.join(dir, "companion-keys"));
  const phone = generateBotKey("phone key");
  const id = enrollPhone(store, phone.publicLine);
  assert.equal(id, phone.fingerprint);
  const keyObj = parseKey(phone.privatePem);
  const body = Buffer.from(JSON.stringify({ sas: "ABCD-EFGH" }));
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const sign = (counter, method = "POST", urlPath = "/attempts/x/allow", bodySha = sha) =>
    keyObj.sign(companionRequestMessage(method, urlPath, bodySha, String(counter))).toString("base64");

  // Unknown phone (no pin file) → 401
  let r = verifyCompanionRequest(store, { id: "SHA256:" + "Z".repeat(43), counter: "1", sig: sign(1) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);

  // Valid signature → ok, counter consumed
  r = verifyCompanionRequest(store, { id, counter: "7", sig: sign(7) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.phone.counter, 7);

  // Replayed counter (same 7) → 403 even with a fresh valid signature
  r = verifyCompanionRequest(store, { id, counter: "7", sig: sign(7) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);

  // Atomic swap (audit fix 3): a consumed counter must never be observable
  // as a torn or missing file — the write is tmp+rename, so no .tmp residue
  // and the JSON always parses
  r = verifyCompanionRequest(store, { id, counter: "8", sig: sign(8) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(store.countersFile + ".tmp"), "no torn tmp left behind");
  assert.equal(JSON.parse(fs.readFileSync(store.countersFile, "utf8"))[id], 8);

  // Corruption (disk-level now that writes are atomic): fail-open, logged —
  // counter bookkeeping restarts, the surface stays alive. Burn a HIGH
  // counter after the reset so the counter-regression check below (3 <
  // floor) keeps its meaning.
  fs.writeFileSync(store.countersFile, "{torn");
  r = verifyCompanionRequest(store, { id, counter: "100", sig: sign(100) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, true, "fail-open keeps the surface alive on corruption");
  assert.equal(JSON.parse(fs.readFileSync(store.countersFile, "utf8"))[id], 100);

  // Tampered body (sha of different bytes) → signature fails
  const otherSha = crypto.createHash("sha256").update(Buffer.from("{}")).digest("hex");
  r = verifyCompanionRequest(store, { id, counter: "8", sig: sign(8, "POST", "/attempts/x/allow", sha) }, "POST", "/attempts/x/allow", Buffer.from("{}"));
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /signature/);

  // Path substituted after signing → fails
  r = verifyCompanionRequest(store, { id, counter: "9", sig: sign(9, "POST", "/attempts/x/deny") }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, false);

  // Counter regression (below 7? already burned; use 3 < 7 with valid sig) → 403
  r = verifyCompanionRequest(store, { id, counter: "3", sig: sign(3) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);

  // Malformed headers → 401
  r = verifyCompanionRequest(store, { id, counter: "abc", sig: sign(10) }, "POST", "/attempts/x/allow", body);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("renderAttempt: sanitized peer text, transcript-bound attemptId", () => {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "a"));
  const ka = writeKeys(p, "a");
  const kbKeys = generateBotKey("b host key");
  const kbBot = generateBotKey("b bot key");
  const st = {
    v: 1,
    mode: "first",
    status: "exchanged",
    armedAt: Date.now(),
    role: "responder",
    self: { name: "a", hostkeyFp: fingerprintOfPublicKey(ka.host.publicLine), botPub: ka.bot.publicLine },
    nonce: freshNonce(),
    peer: {
      name: "b\x1b[31mevil",
      hostkeyFp: fingerprintOfPublicKey(kbKeys.publicLine),
      botPub: kbBot.publicLine,
      commit: commitOf(freshNonce()),
      nonce: freshNonce(),
    },
  };
  const view = renderAttempt(st);
  assert.ok(view);
  assert.ok(!/[\x00-\x1f]/.test(view.peer.name), "no control chars in rendered name");
  assert.equal(view.sas, sasOfState(st));
  assert.equal(view.attemptId, attemptIdOfState(st));
  // Same transcript both roles → same id (the phone never learns the role rule)
  const flipped = {
    ...st,
    role: "initiator",
    self: { name: "b", hostkeyFp: fingerprintOfPublicKey(kbKeys.publicLine), botPub: kbBot.publicLine },
    nonce: st.peer.nonce,
    peer: { name: "a", hostkeyFp: st.self.hostkeyFp, botPub: st.self.botPub, commit: commitOf(st.nonce), nonce: st.nonce },
  };
  assert.equal(attemptIdOfState(flipped), view.attemptId, "attemptId is transcript-bound, not role-order-bound");
});

test("HTTP e2e: enroll, attempts, allow (wrong/right SAS), replay, single-use, deny", async () => {
  const dir = tmp();
  const keydir = path.join(dir, "a");
  const p = keydirPaths(keydir);
  const store = defaultCompanionStore(keydir);
  const spoolDir = path.join(dir, "spool");
  const ka = writeKeys(p, "machine-a");
  const kb = writeKeys(keydirPaths(path.join(dir, "b")), "machine-b");
  const logs = [];
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir,
    store,
    log: (l) => logs.push(l),
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${listener.port}`;

  // Phone key + signer (noble-equivalent: raw ed25519 over the canonical msg)
  const phone = generateBotKey("phone key");
  const keyObj = parseKey(phone.privatePem);
  let counter = 0;
  const signed = async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };

  try {
    // -- enroll: bad token refused; good token pins the phone, single-use
    const { token } = issueEnrollToken(store);
    let res = await fetch(base + "/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "0".repeat(64), phonePub: phone.publicLine }),
    });
    assert.equal(res.status, 403);
    res = await fetch(base + "/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, phonePub: phone.publicLine }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, phone.fingerprint);
    res = await fetch(base + "/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, phonePub: phone.publicLine }),
    });
    assert.equal(res.status, 403, "token burned after first use");

    // -- unsigned request → 401
    res = await fetch(base + "/attempts");
    assert.equal(res.status, 401);

    // -- no state → empty object
    res = await signed("GET", "/attempts");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});

    // -- a completed exchange appears, sanitized
    const st = exchangedState(ka, kb, "machine-a", "machine-b");
    savePairingState(p, st);
    // Realistic machine: an UNRELATED peer is already pinned (must survive
    // the allow, and its presence is what makes a backup meaningful).
    const unrelated = generateBotKey("unrelated peer");
    fs.writeFileSync(p.authorizedKeys, unrelated.publicLine + "\n", { mode: 0o600 });
    const sas = sasOfState(st);
    const attemptId = attemptIdOfState(st);
    res = await signed("GET", "/attempts");
    const view = await res.json();
    assert.equal(view.attemptId, attemptId);
    assert.equal(view.sas, sas);
    assert.equal(view.peer.name, "machine-b");

    // -- allow with the WRONG typed SAS → 403, trust files byte-identical
    const before = fs.existsSync(p.authorizedKeys) ? fs.readFileSync(p.authorizedKeys, "utf8") : null;
    res = await signed("POST", `/attempts/${attemptId}/allow`, { sas: "ZZZZ-ZZZZ" });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /transcription mismatch/);
    const after = fs.existsSync(p.authorizedKeys) ? fs.readFileSync(p.authorizedKeys, "utf8") : null;
    assert.equal(after, before, "nothing written on refusal");
    assert.ok(fs.existsSync(p.state), "state kept for a correct retry");

    // -- replaying the exact (already-consumed) request → stale counter
    const replayBody = Buffer.from(JSON.stringify({ sas: "ZZZZ-ZZZZ" }));
    const replaySha = crypto.createHash("sha256").update(replayBody).digest("hex");
    const replaySig = keyObj
      .sign(companionRequestMessage("POST", `/attempts/${attemptId}/allow`, replaySha, String(counter)))
      .toString("base64");
    res = await fetch(base + `/attempts/${attemptId}/allow`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-companion-id": phone.fingerprint,
        "x-counter": String(counter),
        "x-sig": replaySig,
      },
      body: replayBody,
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /stale\/replayed/);

    // -- allow with the RIGHT typed SAS (lowercase, ungrouped → normalization)
    res = await signed("POST", `/attempts/${attemptId}/allow`, { sas: sas.replace("-", "").toLowerCase() });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.ok(out.changes.includes("authorized_keys"));
    const lines = fs.readFileSync(p.authorizedKeys, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.includes(kb.bot.publicLine.trim()), "peer bot line pinned");
    assert.ok(lines.includes(unrelated.publicLine.trim()), "unrelated peers survive the allow");
    assert.equal(fs.readFileSync(p.peerHostkey, "utf8").trim(), st.peer.hostkeyFp);
    assert.ok(
      fs.readdirSync(p.dir).some((f) => f.startsWith("authorized_keys.bak-")),
      "backup kept",
    );
    assert.ok(!fs.existsSync(p.state), "single-use: state cleared after allow");
    const audit = fs.readFileSync(path.join(spoolDir, "inject.log"), "utf8");
    assert.ok(audit.includes(`via=companion:${phone.fingerprint}`), "audit names the phone");

    // -- second allow (fresh counter, valid sig) → refused, no live state
    res = await signed("POST", `/attempts/${attemptId}/allow`, { sas });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no live pairing state/);

    // -- wrong attemptId never aliases onto a live exchange
    const st2 = exchangedState(ka, kb, "machine-a", "machine-b");
    savePairingState(p, st2);
    res = await signed("POST", `/attempts/${"0".repeat(16)}/allow`, { sas: sasOfState(st2) });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /attemptId/);

    // -- deny: clears, writes nothing
    res = await signed("POST", `/attempts/${attemptIdOfState(st2)}/deny`, {});
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(p.state));
    const linesAfterDeny = fs.readFileSync(p.authorizedKeys, "utf8");
    assert.ok(linesAfterDeny.includes(kb.bot.publicLine.trim()), "deny wrote nothing");

    // -- over-cap body → the server kills the connection (fail-closed:
    // -- destroy, not a polite drain of an oversized body)
    await assert.rejects(() => signed("POST", `/attempts/${"0".repeat(16)}/allow`, { sas: "x".repeat(9000) }));

    // -- unknown route → 404
    res = await signed("GET", "/nope");
    assert.equal(res.status, 404);

    // -- expired state fails closed
    const st3 = exchangedState(ka, kb, "machine-a", "machine-b");
    st3.armedAt = Date.now() - 11 * 60_000;
    savePairingState(p, st3);
    res = await signed("GET", "/attempts");
    assert.deepEqual(await res.json(), {}, "expired arm is invisible");
    res = await signed("POST", `/attempts/${attemptIdOfState(st3)}/allow`, { sas: sasOfState(st3) });
    assert.equal(res.status, 403);
  } finally {
    listener.close();
  }
});

test("doctor: surface + spool verdicts from machine-side facts (metro/journal/ufw skipped)", async () => {
  const { runDoctor } = await import("../dist/doctor.js");
  const dir = tmp();
  const keysDir = path.join(dir, "companion-keys");
  fs.mkdirSync(keysDir, { recursive: true });
  const spool = path.join(dir, "spool");
  fs.mkdirSync(path.join(spool, "pending-prompts"), { recursive: true });

  // dead port → FAIL on the surface check, everything else still reports
  let lines = await runDoctor({
    keysDir,
    companionHost: "127.0.0.1",
    companionPort: 1, // nothing listens here
    spoolDir: spool,
    skip: ["metro", "journal", "ufw"],
  });
  assert.equal(lines.find((l) => l.check === "companion signed surface").state, "FAIL");

  // a stuck pending prompt (older than 60s) → the sweep-down verdict
  fs.writeFileSync(
    path.join(spool, "pending-prompts", "pmtstuck01.json"),
    JSON.stringify({ promptId: "pmtstuck01", text: "x", fp: "fp", createdAt: Date.now() - 120_000, status: "pending" }),
  );
  lines = await runDoctor({
    keysDir,
    companionHost: "127.0.0.1",
    companionPort: 1,
    spoolDir: spool,
    skip: ["metro", "journal", "ufw"],
  });
  assert.equal(lines.find((l) => l.check === "prompt delivery sweep").state, "FAIL");
  assert.match(lines.find((l) => l.check === "prompt delivery sweep").detail, /sweep is down/);

  // live surface + clean spool → PASS; a live server is the real thing
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const listener = startCompanionServer({ bind: "127.0.0.1", port: 0, paths: p, spoolDir: spool, store, log: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  try {
    fs.rmSync(path.join(spool, "pending-prompts", "pmtstuck01.json"));
    lines = await runDoctor({
      keysDir,
      companionHost: "127.0.0.1",
      companionPort: listener.port,
      spoolDir: spool,
      skip: ["metro", "journal", "ufw"],
    });
    assert.equal(lines.find((l) => l.check === "companion signed surface").state, "PASS");
    assert.equal(lines.find((l) => l.check === "prompt delivery sweep").state, "PASS");
    assert.equal(lines.find((l) => l.check === "ask decision delivery").state, "PASS");
  } finally {
    listener.close();
  }
});

test("machine route (round 6): lane + pool facts from watcher state, honest staleness", async () => {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const spool = path.join(dir, "spool");
  fs.mkdirSync(path.join(spool), { recursive: true });
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir: spool,
    store,
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${listener.port}`;

  const phone = generateBotKey("phone key");
  const keyObj = parseKey(phone.privatePem);
  enrollPhone(store, phone.publicLine);
  let counter = 0;
  const signed = async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };

  try {
    // unsigned → 401 (same gate as every signed route)
    let res = await fetch(base + "/machine");
    assert.equal(res.status, 401);

    // no watcher state at all → honest stale, not an error; lane health is
    // audit-log truth and rides along (no inject.log here → null/0)
    res = await signed("GET", "/machine");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { machine: { stale: true, laneHealthMs: null, lanePaired: 0, alerts: [] } });

    // fresh state with lane facts → facts on the wire, minimum shape
    fs.writeFileSync(
      path.join(spool, "watcher-state.json"),
      JSON.stringify({
        active: 1,
        queued_human: 0,
        queued_bot: 2,
        max_concurrent: 2,
        lane: {
          ok: true,
          bot: "joesp-desktop",
          pending: 1,
          injects: 109,
          probedAt: new Date().toISOString(),
          peerLastRunAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        },
        last_run_at: new Date().toISOString(),
        updated: new Date().toISOString(),
      }) + "\n",
    );
    res = await signed("GET", "/machine");
    const m = (await res.json()).machine;
    assert.equal(m.stale, false);
    assert.equal(m.active, 1);
    assert.equal(m.queuedBot, 2);
    assert.equal(m.laneOk, true);
    assert.equal(m.lanePeer, "joesp-desktop");
    assert.equal(m.lanePending, 1);
    assert.ok(m.lanePeerLastRunAt, "peer last-run rides the heartbeat facts (phase 0)");
    assert.ok(m.lastRunAt);
    // wire shape is fixed — nothing else rides out
    assert.deepEqual(
      Object.keys(m).sort(),
      ["active", "alerts", "laneHealthMs", "laneOk", "lanePaired", "lanePeer", "lanePeerLastRunAt", "lanePending", "lastRunAt", "maxConcurrent", "queuedBot", "queuedHuman", "stale", "updated"],
    );
    assert.deepEqual(m.alerts, [], "healthy spool → no alerts");

    // doctor-subset escalation: a prompt pending >60s turns the card red
    fs.mkdirSync(path.join(spool, "pending-prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(spool, "pending-prompts", "pmstuck99.json"),
      JSON.stringify({ promptId: "pmstuck99", text: "stuck", fp: phone.fingerprint, createdAt: Date.now() - 120_000, status: "pending" }),
    );
    res = await signed("GET", "/machine");
    const ma = (await res.json()).machine;
    assert.equal(ma.alerts.length, 1);
    assert.match(ma.alerts[0], /1 prompt\(s\) pending >60s/);
    fs.rmSync(path.join(spool, "pending-prompts", "pmstuck99.json"));

    // lane health from the audit log: one received→consumed pair → median
    // lands on the wire (injects: Xs median · 1 paired)
    await appendInjectEvent(spool, { event: "received", id: "h1", source: "peer", target: "shim" });
    await new Promise((r) => setTimeout(r, 25)); // distinct ts → a real duration
    await appendInjectEvent(spool, { event: "consumed", id: "h1", source: "peer", target: "shim" });
    res = await signed("GET", "/machine");
    const mh = (await res.json()).machine;
    assert.equal(mh.lanePaired, 1);
    assert.ok(mh.laneHealthMs !== null && mh.laneHealthMs >= 20, `median ${mh.laneHealthMs}ms from one paired inject`);

    // stale state (>5min) → honest stale flag, no facts served as truth
    fs.writeFileSync(
      path.join(spool, "watcher-state.json"),
      JSON.stringify({ active: 0, updated: new Date(Date.now() - 360_000).toISOString() }) + "\n",
    );
    res = await signed("GET", "/machine");
    assert.equal((await res.json()).machine.stale, true);

    // S-tier #5 (LAST — it leaves card state behind): the audit watch's
    // live alert lines ride the card from the watcher's state (bounded by
    // the writer, strings only)
    fs.writeFileSync(
      path.join(spool, "watcher-state.json"),
      JSON.stringify({
        active: 0,
        queued_human: 0,
        queued_bot: 0,
        max_concurrent: 2,
        audit_alerts: ["webhook created in watched channel 1555103465179455488 by user 210949752617959424 (audit 999)", 42],
        updated: new Date().toISOString(),
      }) + "\n",
    );
    res = await signed("GET", "/machine");
    const m2 = (await res.json()).machine;
    assert.equal(m2.alerts.length, 1, "only the string alert rides, non-strings dropped");
    assert.match(m2.alerts[0], /webhook created/);

    // S-tier #4: refused interactions in the journal surface as a card alert.
    // (Written through appendJournal — a hand-forged h makes the chain check
    // refuse the file, which is exactly what should happen to a forgery.)
    const { appendJournal } = await import("../dist/journal.js");
    appendJournal(spool, { ts: Date.now(), kind: "interaction", outcome: "refused", detail: "non-approver click on ask x: user 123" });
    res = await signed("GET", "/machine");
    const m3 = (await res.json()).machine;
    assert.ok(m3.alerts.some((a) => /1 refused interaction/.test(a)), "journal refusal stat rides the card");
  } finally {
    listener.close();
  }
});

// --- round 8: notices — the machine→phone report lane. The phone surface
// READS and ACKS only (writers are local processes on the spool file); the
// wire carries the newest window plus a whole-registry unacked count so the
// badge never lies when the window is all-read.
test("notices routes: newest window + honest unacked count, ack one/all, auth", async () => {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const spool = path.join(dir, "spool");
  fs.mkdirSync(path.join(spool), { recursive: true });
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir: spool,
    store,
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${listener.port}`;

  const phone = generateBotKey("phone key");
  const keyObj = parseKey(phone.privatePem);
  enrollPhone(store, phone.publicLine);
  let counter = 0;
  const signed = async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };

  try {
    const { appendNotice } = await import("../dist/notices.js");

    // unsigned → 401 (same gate as every signed route)
    let res = await fetch(base + "/notices");
    assert.equal(res.status, 401);

    // empty lane → honest empty
    res = await signed("GET", "/notices");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { notices: [], unacked: 0 });

    // three reports land (one is a warn)
    const n1 = appendNotice(spool, { from: "gateway", text: "round 3 landed" });
    const n2 = appendNotice(spool, { from: "agy-runner", text: "web route used for mectric follow-up" });
    const n3 = appendNotice(spool, { from: "daemon", text: "audit watch degraded (403)", severity: "warn" });

    // default window: all three, registry order (oldest-first — the app
    // reverses), unacked counts the WHOLE registry
    res = await signed("GET", "/notices");
    let body = await res.json();
    assert.deepEqual(body.notices.map((n) => n.id), [n1.id, n2.id, n3.id]);
    assert.equal(body.unacked, 3);
    assert.equal(body.notices[2].severity, "warn");
    assert.equal(body.notices[0].acked, false);
    // minimum wire shape — nothing else rides out
    assert.deepEqual(Object.keys(body.notices[0]).sort(), ["acked", "from", "id", "severity", "text", "ts"]);

    // limit=2 windows to the newest two; unacked stays 3 (registry-wide)
    res = await signed("GET", "/notices?limit=2");
    body = await res.json();
    assert.deepEqual(body.notices.map((n) => n.id), [n2.id, n3.id]);
    assert.equal(body.unacked, 3, "badge counts the whole registry, not the window");

    // ack one: 200, idempotent on re-tap, unknown → 404
    res = await signed("POST", `/notices/${n1.id}/ack`);
    assert.equal(res.status, 200);
    res = await signed("POST", `/notices/${n1.id}/ack`);
    assert.equal(res.status, 200, "re-ack is idempotent");
    res = await signed("POST", "/notices/ntcdeadbeef/ack");
    assert.equal(res.status, 404);

    res = await signed("GET", "/notices");
    body = await res.json();
    assert.equal(body.unacked, 2);
    assert.equal(body.notices.find((n) => n.id === n1.id).acked, true);
    assert.equal(body.notices.find((n) => n.id === n2.id).acked, false);

    // ack-all: only the remaining two
    res = await signed("POST", "/notices/ack-all");
    assert.deepEqual(await res.json(), { acked: 2 });
    res = await signed("GET", "/notices");
    assert.equal((await res.json()).unacked, 0);
  } finally {
    listener.close();
  }
});

test("CLI: companion --enroll with existing keys", () => {
  const dir = tmp();
  const keydir = path.join(dir, "keys");
  const p = keydirPaths(keydir);
  writeKeys(p, "cli-machine");
  const r = spawnSync(
    process.execPath,
    ["dist/botlink-server.js", "companion", "--enroll", "--keys", keydir, "--bind", "127.0.0.1"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = r.stderr; // enroll prints to stderr by design (stdout stays machine-readable)
  assert.match(out, /single-use/i);
  assert.match(out, /phones cannot reach it/); // loopback warning fires on a loopback bind
  assert.match(out, /█/); // the QR itself
  assert.match(out, /SHA256:[A-Za-z0-9+/]{43}/);
  const store = defaultCompanionStore(keydir);
  assert.ok(fs.existsSync(store.enrollFile), "token persisted for the server to consume");
});

// --- round 4: asks on the phone — signed list/decide over the shared registry
// The phone surface DECIDES (registry write with companion: provenance); it
// never delivers (the gateway watcher stamps enqueuedAt and runs the trigger).
test("asks routes: list pending, decide with provenance, races and replays stay honest", async () => {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const spool = path.join(dir, "spool");
  fs.mkdirSync(spool, { recursive: true });
  const logs = [];
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir: spool,
    store,
    log: (l) => logs.push(l),
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${listener.port}`;

  // enroll a phone directly through the store (the QR path is covered above)
  const phone = generateBotKey("phone key");
  const keyObj = parseKey(phone.privatePem);
  enrollPhone(store, phone.publicLine);
  let counter = 0;
  const signed = async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };

  try {
    const { createPendingAsk, getAsk, decideAsk, listCompanionDecisions } = await import("../dist/asks.js");
    const A = "187396435283542016";

    // empty list
    let res = await signed("GET", "/asks");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).asks, []);

    // two live asks + one already expired + one already click-decided
    // (2ms apart so createdAt ordering is real, not a same-ms id tiebreak)
    const live = createPendingAsk(spool, { question: "ship round 4?", channelId: "1", messageId: null, approvers: [A] });
    await new Promise((r) => setTimeout(r, 2));
    const lazy = createPendingAsk(spool, { question: "lazy one", channelId: "1", messageId: null, approvers: [A], onExpiry: "approve" });
    createPendingAsk(spool, { question: "stale", channelId: "1", messageId: null, approvers: [A], ttlMs: -5_000 });
    const clicked = createPendingAsk(spool, { question: "clicked", channelId: "1", messageId: null, approvers: [A] });
    decideAsk(spool, clicked.askId, "denied", A);

    res = await signed("GET", "/asks");
    const listed = (await res.json()).asks;
    assert.deepEqual(listed.map((a) => a.askId), [live.askId, lazy.askId], "only live pending asks, oldest first");
    assert.equal(listed[1].lazy, true);
    assert.equal(listed[0].channelId, undefined, "no channel ids on the wire");

    // unsigned → 401
    res = await fetch(base + "/asks");
    assert.equal(res.status, 401);

    // decide from the phone
    res = await signed("POST", `/asks/${live.askId}/approve`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "approved");
    const rec = getAsk(spool, live.askId);
    assert.equal(rec.status, "approved");
    assert.equal(rec.decidedBy, `companion:${phone.fingerprint}`, "provenance is the phone fingerprint");
    assert.equal(listCompanionDecisions(spool).map((r) => r.askId).join(), live.askId, "awaiting watcher delivery");

    // tap on an already-decided ask → 409, nothing changes
    res = await signed("POST", `/asks/${live.askId}/deny`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).status, "approved", "the first decision stands");
    assert.equal(getAsk(spool, live.askId).status, "approved");

    // replay of the SAME signed request (same counter) → 403 before any handler
    counter -= 1; // force reuse of the last counter value
    const body = Buffer.from(JSON.stringify({}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage("POST", `/asks/${lazy.askId}/deny`, sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    res = await fetch(base + `/asks/${lazy.askId}/deny`, {
      method: "POST",
      headers: { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig, "content-type": "application/json" },
      body,
    });
    assert.equal(res.status, 403, "replayed counter refused");
    assert.equal(getAsk(spool, lazy.askId).status, "pending", "replay decided nothing");

    // deny from the phone works the same
    counter += 2; // skip past the burned value (gaps are fine, repeats never)
    res = await signed("POST", `/asks/${lazy.askId}/deny`);
    assert.equal(res.status, 200);
    assert.equal(getAsk(spool, lazy.askId).status, "denied");

    // YOLO from the phone (round 12): third verb records "yolo" with phone
    // provenance — NOT a deny-else default (the round-11 binary-map class).
    const yoloAsk = createPendingAsk(spool, { question: "yolo me", channelId: "1", messageId: null, approvers: [A] });
    res = await signed("POST", `/asks/${yoloAsk.askId}/yolo`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "yolo");
    const yRec = getAsk(spool, yoloAsk.askId);
    assert.equal(yRec.status, "yolo", "a YOLO tap is a YOLO decision");
    assert.equal(yRec.decidedBy, `companion:${phone.fingerprint}`);
    assert.ok(listCompanionDecisions(spool).some((r) => r.askId === yoloAsk.askId), "awaiting watcher delivery");

    // unknown ask id → 404
    res = await signed("POST", "/asks/no-such-ask/approve");
    assert.equal(res.status, 404);
  } finally {
    listener.close();
  }
});

test("prompt routes (round 5): send from the phone, list lifecycle, caps and auth", async () => {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const spool = path.join(dir, "spool");
  fs.mkdirSync(spool, { recursive: true });
  const logs = [];
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir: spool,
    store,
    log: (l) => logs.push(l),
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${listener.port}`;

  const phone = generateBotKey("phone key");
  const keyObj = parseKey(phone.privatePem);
  enrollPhone(store, phone.publicLine);
  let counter = 0;
  const signed = async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };

  try {
    // unsigned → 401 before any handler (same gate as every signed route)
    let res = await fetch(base + "/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "spoofed" }),
    });
    assert.equal(res.status, 401);

    res = await signed("GET", "/prompts");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).prompts, [], "empty list");

    // empty text → 400
    res = await signed("POST", "/prompt", { text: "   " });
    assert.equal(res.status, 400);

    // happy path
    res = await signed("POST", "/prompt", { text: "what's the machine doing?" });
    assert.equal(res.status, 200);
    const { promptId, status } = await res.json();
    assert.equal(status, "pending");
    assert.match(promptId, /^pmt[a-z]{8}$/);

    // lifecycle visibility: watcher-side transitions show through the list,
    // including the answer excerpt once the run's exit hook writes one
    const { stampPromptEnqueued, finishPrompt } = await import("../dist/prompts.js");
    stampPromptEnqueued(spool, promptId);
    finishPrompt(spool, promptId, { exit: 0, posted: true, excerpt: "done: 3 tests added, suite green" });
    res = await signed("GET", "/prompts");
    const listed = (await res.json()).prompts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "answered");
    assert.equal(listed[0].promptId, promptId);
    assert.equal(listed[0].answerExcerpt, "done: 3 tests added, suite green");
    assert.equal(listed[0].fp, undefined, "no fingerprint on the wire");
    assert.equal(listed[0].channelId, undefined, "no channel ids on the wire");

    // queue-full cap → 429 (5 in flight max)
    for (let i = 0; i < 5; i++) {
      res = await signed("POST", "/prompt", { text: `filler ${i}` });
      assert.equal(res.status, 200);
    }
    res = await signed("POST", "/prompt", { text: "one too many" });
    assert.equal(res.status, 429);
    assert.match(String((await res.json()).error), /queue full/);

    // replay of a burned counter → 403, nothing written
    counter -= 1;
    const body = Buffer.from(JSON.stringify({ text: "replayed" }));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage("POST", "/prompt", sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    res = await fetch(base + "/prompt", {
      method: "POST",
      headers: { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig, "content-type": "application/json" },
      body,
    });
    assert.equal(res.status, 403, "replayed counter refused");
    const inFlight = (await import("../dist/prompts.js")).listPhonePrompts(spool).filter((r) => r.text === "replayed");
    assert.equal(inFlight.length, 0, "replay prompted nothing");

    // ?q= searches the WHOLE registry — an old, long-finished prompt the
    // default list no longer surfaces is findable by a text substring and
    // by promptId; case-insensitive both ways. (Restore the counter the
    // replay check deliberately burned above.)
    counter += 1;
    const old = {
      promptId: "pmtuesday1",
      text: "the tuesday audit question",
      fp: phone.fingerprint,
      createdAt: Date.now() - 3 * 24 * 3600_000,
      status: "answered",
      finishedAt: Date.now() - 3 * 24 * 3600_000,
      exit: 0,
    };
    fs.writeFileSync(
      path.join(spool, "pending-prompts", `${old.promptId}.json`),
      JSON.stringify(old),
    );
    res = await signed("GET", "/prompts");
    assert.ok(
      !((await res.json()).prompts).some((r) => r.promptId === "pmtuesday1"),
      "3-day-old answer is not in the default recent list",
    );
    res = await signed("GET", "/prompts?q=tuesday audit");
    const hits = (await res.json()).prompts;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].promptId, "pmtuesday1");
    assert.equal(hits[0].status, "answered");
    res = await signed("GET", "/prompts?q=PMTUESDAY1");
    assert.equal(((await res.json()).prompts).length, 1, "promptId match, case-insensitive");
    res = await signed("GET", "/prompts?q=no-such-thing");
    assert.deepEqual(((await res.json()).prompts), []);

    // ?before=<createdAt> pages OLDER history (round 7): strictly older than
    // the cursor, newest-last, `more` true until the registry runs out. The
    // 3-day-old record above is the oldest thing here, so the final page
    // says more:false.
    const nowMs = Date.now();
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(spool, "pending-prompts", `pmthist${i}.json`),
        JSON.stringify({
          promptId: `pmthist${i}`,
          text: `history ${i}`,
          fp: phone.fingerprint,
          createdAt: nowMs - (10 + i) * 60_000, // 1, 2, ... minutes ago (i=0 newest)
          status: "answered",
          finishedAt: nowMs - (10 + i) * 60_000,
          exit: 0,
        }),
      );
    }
    // cursor = pmthist0's createdAt (10 min ago) → strictly older = tuesday,
    // pmthist2, pmthist1 (registry order is oldest-first, same as the
    // default branch), more:false (end of registry)
    res = await signed("GET", `/prompts?before=${nowMs - 10 * 60_000}`);
    let page = await res.json();
    assert.deepEqual(page.prompts.map((r) => r.promptId), ["pmtuesday1", "pmthist2", "pmthist1"]);
    assert.equal(page.more, false, "no older records exist");
    // cursor above all of history (8 min ago) → the whole older tail (4
    // records), and limit=1 windows to the newest of those alone, more:true
    res = await signed("GET", `/prompts?before=${nowMs - 8 * 60_000}`);
    page = await res.json();
    assert.deepEqual(page.prompts.map((r) => r.promptId), ["pmtuesday1", "pmthist2", "pmthist1", "pmthist0"]);
    res = await signed("GET", `/prompts?before=${nowMs - 8 * 60_000}&limit=1`);
    page = await res.json();
    assert.deepEqual(page.prompts.map((r) => r.promptId), ["pmthist0"]);
    assert.equal(page.more, true, "older records remain under limit");
    // junk cursor → 400, never a silent fall-through to the default list
    res = await signed("GET", "/prompts?before=not-a-number");
    assert.equal(res.status, 400);
  } finally {
    listener.close();
  }
});

// --- round 17 (audit round 3, findings 1+5) --------------------------------
// Expiry is a hard boundary on EVERY deciding surface. The GET /asks filter
// already hides expired asks, but a stale card can still drive a POST: past
// the fuse the sweep owns the ask — the route must answer 409/expired and
// leave the record pending, never approve what "buttons die at expiry"
// promised would die (the TOCTOU the sweep/decide race used to have).
test("asks routes (round 17): a tap on an expired ask is refused, the record stays pending for the sweep", async () => {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const spool = path.join(dir, "spool");
  fs.mkdirSync(spool, { recursive: true });
  const logs = [];
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir: spool,
    store,
    log: (l) => logs.push(l),
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${listener.port}`;

  const phone = generateBotKey("phone key");
  const keyObj = parseKey(phone.privatePem);
  enrollPhone(store, phone.publicLine);
  let counter = 0;
  const signed = async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };

  try {
    const { createPendingAsk, getAsk } = await import("../dist/asks.js");
    // Expired while UNDECIDED, and — the sharper edge — an approve-on-expiry
    // ask: the old route would have run decideAsk and recorded "approved"
    // (or flipped an in-flight phone DENY) past the fuse.
    const stale = createPendingAsk(spool, { question: "late tap", channelId: "1", messageId: null, approvers: ["1"], ttlMs: -1_000 });
    const staleApprove = createPendingAsk(spool, { question: "late tap, lazy", channelId: "1", messageId: null, approvers: ["1"], ttlMs: -1_000, onExpiry: "approve" });

    const res = await signed("POST", `/asks/${stale.askId}/approve`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.status, "expired");
    assert.ok(body.error.includes("expired"), "the error names expiry, not a generic conflict");

    const res2 = await signed("POST", `/asks/${staleApprove.askId}/approve`);
    assert.equal(res2.status, 409, "an approve-on-expiry ask is STILL sweep-owned after the fuse");
    assert.equal((await res2.json()).status, "expired");

    assert.equal(getAsk(spool, stale.askId).status, "pending", "the sweep owns expiry, not the tap");
    assert.equal(getAsk(spool, staleApprove.askId).status, "pending");
    assert.ok(logs.some((l) => l.includes("AFTER expiry")), "the refusal is logged for the security trail");

    // Fresh ask still decides normally through the same route (guard did not
    // over-fire and wedge the surface).
    const fresh = createPendingAsk(spool, { question: "on time", channelId: "1", messageId: null, approvers: ["1"], ttlMs: 60_000 });
    const res3 = await signed("POST", `/asks/${fresh.askId}/deny`);
    assert.equal(res3.status, 200);
    assert.equal(getAsk(spool, fresh.askId).status, "denied");
  } finally {
    listener.close();
  }
});
