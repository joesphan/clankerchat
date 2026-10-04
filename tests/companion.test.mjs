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

import { fingerprintOfPublicKey, generateBotKey, parseKey } from "../dist/botlink.js";
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
    const msg = companionRequestMessage(method, urlPath, sha, String(counter));
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
    const msg = companionRequestMessage(method, urlPath, sha, String(counter));
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
    const msg = companionRequestMessage(method, urlPath, sha, String(counter));
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
  } finally {
    listener.close();
  }
});
