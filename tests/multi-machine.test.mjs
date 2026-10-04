import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  generateBotKey,
  parseKey,
  startBotlinkServer,
  botlinkRequest,
} from "../dist/botlink.js";
import {
  createPhonePrompt,
  getPrompt,
  listClaimablePrompts,
  stampPromptEnqueued,
  finishPrompt,
  sweepExpiredPrompts,
  sweepStuckEnqueued,
  applyPeerPromptOutcome,
  PROMPT_TTL_MS,
  ROUTED_PROMPT_TTL_MS,
  STUCK_ENQUEUED_MS,
} from "../dist/prompts.js";
import {
  companionRequestMessage,
  defaultCompanionStore,
  startCompanionServer,
  enrollPhone,
} from "../dist/companion.js";
import { keydirPaths } from "../dist/pairing.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-mm-"));
}
const MIN = 60 * 1000;

// ---------------------------------------------------------------------------
// Registry core: route hint, wider routed TTLs, outcome echo
// ---------------------------------------------------------------------------

test("route hint: 'peer' persists on the record, anything else refused", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "ask the other machine", fp: "fp", route: "peer" });
  assert.equal(rec.route, "peer");
  assert.equal(getPrompt(dir, rec.promptId).route, "peer", "persists through the registry");
  const own = createPhonePrompt(dir, { text: "local", fp: "fp" });
  assert.equal(own.route, undefined, "absent route stays absent (back-compat)");
  assert.throws(
    () => createPhonePrompt(dir, { text: "x", fp: "fp", route: "bogus" }),
    /unknown route/,
    "a bogus route is refused, never silently ignored",
  );
});

test("routed TTL: 30-min budget — survives 16 min (local would rot), expires at 31", () => {
  const dir = tmp();
  const routed = createPhonePrompt(dir, { text: "r", fp: "fp", route: "peer" });
  const local = createPhonePrompt(dir, { text: "l", fp: "fp" });
  const t16 = routed.createdAt + PROMPT_TTL_MS + 1 * MIN; // past the LOCAL window
  assert.deepEqual(
    listClaimablePrompts(dir, t16).map((r) => r.promptId),
    [routed.promptId],
    "routed still claimable at 16min",
  );
  const swept16 = sweepExpiredPrompts(dir, t16);
  assert.deepEqual(swept16.map((r) => r.promptId), [local.promptId], "local rots, routed doesn't");
  const swept31 = sweepExpiredPrompts(dir, routed.createdAt + ROUTED_PROMPT_TTL_MS + MIN);
  assert.deepEqual(swept31.map((r) => r.promptId), [routed.promptId], "routed expires on its own budget");
});

test("routed stuck-enqueued: the lane round-trip outlives the local 20-min stuck window", () => {
  const dir = tmp();
  const routedRec = createPhonePrompt(dir, { text: "r", fp: "fp", route: "peer" });
  const routed = stampPromptEnqueued(dir, routedRec.promptId);
  const localRec = createPhonePrompt(dir, { text: "l", fp: "fp" });
  const local = stampPromptEnqueued(dir, localRec.promptId);
  // +21min from claim: local record fails (STUCK is 20), routed survives —
  // a healthy peer behind one queued job takes longer than a local run.
  const t21 = Math.max(routed.enqueuedAt, local.enqueuedAt) + STUCK_ENQUEUED_MS + 1 * MIN;
  assert.deepEqual(
    sweepStuckEnqueued(dir, t21).map((r) => r.promptId),
    [local.promptId],
    "local stuck-fails at 20min, routed does not",
  );
  // createdAt + 31min: the whole-lifecycle budget is up — honest failure.
  const swept = sweepStuckEnqueued(dir, routed.createdAt + ROUTED_PROMPT_TTL_MS + MIN);
  assert.deepEqual(swept.map((r) => r.promptId), [routed.promptId]);
  assert.equal(swept[0].status, "failed");
});

test("applyPeerPromptOutcome: happy path — routed enqueued resolves like a local run", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "r", fp: "fp", route: "peer" });
  stampPromptEnqueued(dir, rec.promptId);
  const done = applyPeerPromptOutcome(dir, {
    promptId: rec.promptId,
    exit: 0,
    posted: true,
    excerpt: "  the peer answered:  all green  ",
  });
  assert.equal(done.status, "answered");
  assert.equal(done.answerExcerpt, "the peer answered: all green", "normalized like a local excerpt");
  // second apply is a no-op (terminal records are final)
  assert.equal(
    applyPeerPromptOutcome(dir, { promptId: rec.promptId, exit: 1, posted: false }),
    null,
    "terminal record is final — echoes are once",
  );
});

test("applyPeerPromptOutcome: failure exit → failed; late echo overwrites the stuck guess", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "r", fp: "fp", route: "peer" });
  stampPromptEnqueued(dir, rec.promptId);
  // stuck sweep guessed failure at the 30-min budget…
  const [guess] = sweepStuckEnqueued(dir, rec.createdAt + ROUTED_PROMPT_TTL_MS + MIN);
  assert.equal(guess.status, "failed");
  // …but the peer's run DID finish (slow lane, queued behind work): the real
  // outcome wins, same law as local late finishes.
  const late = applyPeerPromptOutcome(dir, { promptId: rec.promptId, exit: 0, posted: true, excerpt: "better late" });
  assert.equal(late.status, "answered");
  assert.equal(late.answerExcerpt, "better late");
});

test("applyPeerPromptOutcome: registry guards — miss, LOCAL record, bad id shape", () => {
  const dir = tmp();
  // miss: no such record
  assert.equal(applyPeerPromptOutcome(dir, { promptId: "pmtnope123", exit: 0, posted: true }), null);
  // LOCAL record: the lane may never stamp a prompt this machine runs itself
  const local = createPhonePrompt(dir, { text: "l", fp: "fp" });
  stampPromptEnqueued(dir, local.promptId);
  assert.equal(
    applyPeerPromptOutcome(dir, { promptId: local.promptId, exit: 0, posted: true }),
    null,
    "local records are untouchable from the lane",
  );
  assert.equal(getPrompt(dir, local.promptId).status, "enqueued", "and were not modified");
  // id shape: path components and junk are refused before any file access
  for (const bad of ["../../etc/passwd", "a/b", "x".repeat(200), "", "has space"]) {
    assert.equal(applyPeerPromptOutcome(dir, { promptId: bad, exit: 0, posted: true }), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("applyPeerPromptOutcome: leak-shaped excerpt → answered, but no preview", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "r", fp: "fp", route: "peer" });
  stampPromptEnqueued(dir, rec.promptId);
  const done = applyPeerPromptOutcome(dir, {
    promptId: rec.promptId,
    exit: 0,
    posted: true,
    excerpt: `leak? ghp_${"a".repeat(36)}`,
  });
  assert.equal(done.status, "answered", "the outcome still resolves");
  assert.equal(done.answerExcerpt, undefined, "but the phone gets NO excerpt, not the secret shape");
});

// ---------------------------------------------------------------------------
// Lane verb: prompt-outcome over the real SSH server
// ---------------------------------------------------------------------------

async function makeLane(t) {
  const dir = tmp();
  const host = generateBotKey("test-host");
  const clientBot = generateBotKey("client-bot");
  const spool = path.join(dir, "spool");
  const srv = startBotlinkServer({
    listen: { host: "127.0.0.1", port: 0 },
    hostKeyPem: host.privatePem,
    authorizedPublicKeys: [clientBot.publicLine],
    spoolDir: spool,
    botName: "test-machine",
  });
  await srv.listening;
  t.after(() => srv.close());
  return {
    spool,
    peer: {
      host: "127.0.0.1",
      port: srv.port,
      privateKeyPem: clientBot.privatePem,
      expectedHostKey: host.fingerprint,
    },
  };
}

test("prompt-outcome verb: lands an outcome file the sweep can apply", async (t) => {
  const { spool, peer } = await makeLane(t);
  // the asking machine's record exists BEFORE the peer reports its outcome
  const rec = createPhonePrompt(spool, { text: "r", fp: "fp", route: "peer" });
  stampPromptEnqueued(spool, rec.promptId);
  const ack = JSON.parse(
    await botlinkRequest(peer, "prompt-outcome", {
      promptId: rec.promptId,
      exit: 0,
      posted: true,
      excerpt: "peer says hi",
    }),
  );
  assert.equal(ack.ok, true);
  const outDir = path.join(spool, "prompt-outcomes");
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".outcome.json"));
  assert.equal(files.length, 1);
  const landed = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), "utf8"));
  assert.equal(landed.promptId, rec.promptId);
  assert.equal(landed.posted, true);
  assert.match(landed.authenticated_key_fp, /^SHA256:/, "provenance rides the file like injects");
  // end-to-end: the landed file IS the sweep's input
  const done = applyPeerPromptOutcome(spool, landed);
  assert.equal(done.status, "answered");
});

test("prompt-outcome verb: malformed payload and leak-shaped excerpt refused at the door", async (t) => {
  const { spool, peer } = await makeLane(t);
  // wrong shapes
  await assert.rejects(
    botlinkRequest(peer, "prompt-outcome", { promptId: "pmtok1234", exit: "zero", posted: true }),
    /invalid outcome payload/,
  );
  await assert.rejects(
    botlinkRequest(peer, "prompt-outcome", { promptId: "../escape", exit: 0, posted: true }),
    /invalid outcome payload/,
  );
  // secret-shaped excerpt: the lane refuses regardless of what the far side checked
  await assert.rejects(
    botlinkRequest(peer, "prompt-outcome", {
      promptId: "pmtok1234",
      exit: 0,
      posted: true,
      excerpt: `ghp_${"b".repeat(36)}`,
    }),
    /REFUSED.*secret-shape/i,
  );
  const outDir = path.join(spool, "prompt-outcomes");
  assert.equal(fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0, 0, "refusals land NOTHING");
});

// ---------------------------------------------------------------------------
// Phone surface: route accepted when the lane is configured, refused when not
// ---------------------------------------------------------------------------

function phoneClient(base, phone) {
  const keyObj = parseKey(phone.privatePem);
  let counter = 0;
  return async (method, urlPath, bodyObj) => {
    counter += 1;
    const body = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj ?? {}));
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const msg = companionRequestMessage(method, urlPath.split("?")[0], sha, String(counter));
    const sig = keyObj.sign(msg).toString("base64");
    const headers = { "x-companion-id": phone.fingerprint, "x-counter": String(counter), "x-sig": sig };
    if (method !== "GET") headers["content-type"] = "application/json";
    return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
  };
}

async function makeCompanion(t, canRouteToPeer) {
  const dir = tmp();
  const p = keydirPaths(path.join(dir, "keys"));
  const store = defaultCompanionStore(p.dir);
  const spool = path.join(dir, "spool");
  const listener = startCompanionServer({
    bind: "127.0.0.1",
    port: 0,
    paths: p,
    spoolDir: spool,
    store,
    log: () => {},
    ...(canRouteToPeer !== undefined ? { canRouteToPeer } : {}),
  });
  await new Promise((r) => setTimeout(r, 50));
  t.after(() => listener.close());
  const phone = generateBotKey("phone key");
  enrollPhone(store, phone.publicLine);
  return { base: `http://127.0.0.1:${listener.port}`, signed: phoneClient(`http://127.0.0.1:${listener.port}`, phone), spool };
}

test("POST /prompt route:peer — accepted with a lane, record carries route", async (t) => {
  const { signed, spool } = await makeCompanion(t, () => true);
  const res = await signed("POST", "/prompt", { text: "run this on the peer", route: "peer" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.route, "peer", "the ack tells the phone where it's going");
  assert.equal(getPrompt(spool, body.promptId).route, "peer");
  // and the plain local prompt is unchanged
  const local = await signed("POST", "/prompt", { text: "local one" });
  assert.equal((await local.json()).route, null);
});

test("POST /prompt route:peer without a lane → 400 now, not a 30-min lie later", async (t) => {
  const { signed, spool } = await makeCompanion(t); // no canRouteToPeer → lane absent
  const res = await signed("POST", "/prompt", { text: "route me", route: "peer" });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /no peer lane/);
  const pDir = path.join(spool, "pending-prompts");
  assert.equal(fs.existsSync(pDir) ? fs.readdirSync(pDir).length : 0, 0, "nothing written");
  // bogus route values are refused outright
  const bogus = await signed("POST", "/prompt", { text: "x", route: "everywhere" });
  assert.equal(bogus.status, 400);
});
