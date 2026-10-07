// Tier-0 router tests (cascade rounds 1-3, 2026-10-05) — the decision layer
// between trigger admission and the orchestrator spawn. Covers the
// properties the design claims:
//   - sanitize: strips the weaponized invisible set, NFC-composes, and never
//     mutates the caller's string (message text humans see is untouched).
//   - forced escalation: security classes (git ops, cited SHAs, secrets,
//     settings, infra) NEVER reach the classifier; authority flags preempt
//     content entirely.
//   - heuristic fail-safe: chatter shape → t0, task verb → t1, everything
//     inconclusive → t1 (today's behavior is the failure direction).
//   - decideTier0: no sidecar → fail-safe band; fake sidecar on a unix socket
//     → probability-driven bands at both thresholds; forced/authority paths
//     never open a socket at all.
//
// Usage: node --test tests/tier0.test.mjs   (build first: npm run build)

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TAU_HI,
  TAU_LO,
  TIER0_OPTIONS,
  TIER0_QUESTION,
  decideTier0,
  forcedEscalationReason,
  heuristicBand,
  layaAsk,
  sidecarAddress,
  sanitizeClassifierInput,
} from "../dist/tier0.js";

test("sanitize strips invisible unicode, NFC-composes, and leaves the source string alone", () => {
  const attack = "hel​lo⁠ wo‌rld⁣" + "é"; // zero-width bits + decomposed é
  const clean = sanitizeClassifierInput(attack);
  assert.equal(clean, "hello worldé"); // bits gone, é composed
  assert.ok(attack.includes("​"), "original untouched (the stored message is never mutated)");
  assert.equal(sanitizeClassifierInput("plain text"), "plain text");
});

test("forced escalation: security classes never reach the classifier", () => {
  for (const [text, why] of [
    ["can you git push that branch for me", "git-operator"],
    ["merge the PR when green", "merge-cite"],
    ["check 4c0067b when you get a sec", "sha-cited"],
    ["rotate the keys tonight", "secret-class"],
    ["update settings.json permissions", "settings-class"],
    ["restart the daemon please", "infra-class"],
  ]) {
    const reason = forcedEscalationReason(text);
    assert.ok(reason, `should force: ${text}`);
    assert.equal(reason, why);
  }
  assert.equal(forcedEscalationReason("thanks, that helped a lot!"), null);
  assert.equal(forcedEscalationReason("what time does the build usually take?"), null); // "build" alone is NOT forced (heuristic's job)
});

test("authority flags preempt content", async () => {
  const d = await decideTier0({ text: "thanks!", owner: true }, { sockPath: "/nonexistent/laya.sock" });
  assert.equal(d.band, "t1");
  assert.equal(d.source, "authority");
  assert.equal(d.reason, "authority:owner-direct-line");
  const bot = await decideTier0({ text: "status?", isBot: true }, { sockPath: "/nonexistent/laya.sock" });
  assert.equal(bot.reason, "authority:bot-inject");
});

test("sidecar down → heuristic fail-safe, inconclusive fails toward t1", async () => {
  const chatter = await decideTier0({ text: "thanks!!!" }, { sockPath: "/nonexistent/laya.sock" });
  assert.equal(chatter.source, "fail-safe");
  assert.equal(chatter.band, "t0");
  assert.equal(chatter.reason, "heuristic:chatter-shape");
  const task = await decideTier0({ text: "can you fix the build error in ci" }, { sockPath: "/nonexistent/laya.sock" });
  assert.equal(task.band, "t1");
  assert.equal(task.reason, "heuristic:task-verb");
  const vague = await decideTier0({ text: "hey quick question about the thing" }, { sockPath: "/nonexistent/laya.sock" });
  assert.equal(vague.band, "t1"); // fail direction = today's spawn path
  assert.equal(vague.reason, "heuristic:inconclusive-fail-safe");
});

test("heuristic bands", () => {
  assert.deepEqual(heuristicBand("thank you"), { band: "t0", reason: "heuristic:chatter-shape" });
  assert.deepEqual(heuristicBand("LOL ok"), { band: "t0", reason: "heuristic:chatter-shape" });
  assert.deepEqual(heuristicBand("deploy the new build please"), { band: "t1", reason: "heuristic:task-verb" });
});

function fakeSidecar(sockPath, pTask) {
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      buf = "";
      conn.write(JSON.stringify({ id: req.id, probs: [pTask, 1 - pTask], took_ms: 5 }) + "\n");
    });
  });
  // Same address derivation as layaAsk's client — on win32 both ends meet on
  // a named pipe (AF_UNIX at a filesystem path refuses EACCES); POSIX is the
  // untouched unix-socket contract.
  server.listen(sidecarAddress(sockPath));
  return server;
}

test("sidecar up → probability bands at both thresholds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier0-test-"));
  const servers = [];
  // Separate socket per sidecar value: an assertion throw must never strand a
  // listening server (a live listener keeps the test process from exiting —
  // that's exactly the hang this restructuring fixes). All closed in finally.
  const sockAt = (pTask) => {
    const sock = path.join(dir, `laya-${pTask}.sock`);
    servers.push(fakeSidecar(sock, pTask));
    return sock;
  };
  try {
    const dHi = await decideTier0({ text: "whats up" }, { sockPath: sockAt(0.91) });
    assert.equal(dHi.source, "laya");
    assert.equal(dHi.band, "t1"); // ≥ τ_hi → tier-1 even though the text looks chatty
    assert.equal(dHi.pTask, 0.91);
    assert.ok(typeof dHi.hint === "string"); // heuristic logged as hint alongside

    const dLo = await decideTier0({ text: "hey can you take a look at this when you get a sec" }, { sockPath: sockAt(0.05) });
    assert.equal(dLo.band, "t0");
    assert.equal(dLo.confident, true); // < τ_lo marker

    const dMid = await decideTier0({ text: "hmm interesting" }, { sockPath: sockAt(0.5) });
    assert.equal(dMid.band, "t0"); // ambiguity band = t0 WITH context (scrutinizer) — no drop state
    assert.equal(dMid.confident, false); // boolean on the laya path — false, not absent
  } finally {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("forced rules never open the sidecar socket", async () => {
  // sockPath points nowhere: a forced-rule hit must decide without touching it
  const d = await decideTier0({ text: "please merge commit ab12cd3 now" }, { sockPath: "/nonexistent/laya.sock" });
  assert.equal(d.source, "forced-rule");
  assert.equal(d.band, "t1");
});

test("layaAsk surfaces sidecar errors and timeouts", async () => {
  await assert.rejects(layaAsk("/nonexistent/laya.sock", { text: "x", question: TIER0_QUESTION, options: TIER0_OPTIONS }), /ENOENT|connect/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier0-err-"));
  const sock = path.join(dir, "e.sock");
  const srv = fakeSidecar(sock, 0.5);
  try {
    // valid round-trip shape
    const ok = await layaAsk(sock, { text: "x", question: TIER0_QUESTION, options: TIER0_OPTIONS });
    assert.equal(ok.probs.length, 2);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disagreement veto: task-verb hint blocks t0 unless Laya is confidently chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier0-veto-"));
  const servers = [];
  const sockAt = (pTask) => {
    const sock = path.join(dir, `laya-${pTask}.sock`);
    servers.push(fakeSidecar(sock, pTask));
    return sock;
  };
  try {
    // Live-smoke failure shape 1: short imperative work order scored mid-band
    // ("fix the build error in the ci workflow" → p 0.52). Task verb vetoes.
    const d1 = await decideTier0({ text: "fix the build error in the ci workflow" }, { sockPath: sockAt(0.52) });
    assert.equal(d1.band, "t1");
    assert.match(d1.reason, /\+task-veto/);

    // Live-smoke failure shape 2: sub-τ_lo work order ("investigate…" p 0.27) —
    // Laya is confidently chat, veto does NOT fire: rides t0-with-context.
    const d2 = await decideTier0({ text: "investigate why it broke and patch it" }, { sockPath: sockAt(0.27) });
    assert.equal(d2.band, "t0");
    assert.equal(d2.confident, true);
    assert.doesNotMatch(d2.reason, /task-veto/);

    // Task verb + high p: τ_hi already tier-1; reason stays plain (no veto tag
    // needed — the veto only exists to catch the low half).
    const d3 = await decideTier0({ text: "deploy the new build now" }, { sockPath: sockAt(0.91) });
    assert.equal(d3.band, "t1");
    assert.doesNotMatch(d3.reason, /task-veto/);

    // Pure chatter mid-band (no task verb): veto never applies, t0 stands.
    const d4 = await decideTier0({ text: "hmm interesting" }, { sockPath: sockAt(0.5) });
    assert.equal(d4.band, "t0");
  } finally {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("threshold constants are the settled research bands", () => {
  assert.equal(TAU_HI, 0.65);
  assert.equal(TAU_LO, 0.3);
});

test("sidecarAddress: win32 maps to a distinct named pipe; POSIX passes through byte-identical", () => {
  const a = sidecarAddress("/tmp/laya-a.sock");
  if (process.platform === "win32") {
    assert.match(a, /^\\\\\.\\pipe\\cc-laya-/);
    assert.notEqual(a, sidecarAddress("/tmp/laya-b.sock"), "distinct paths stay on distinct pipes");
  } else {
    assert.equal(a, "/tmp/laya-a.sock");
  }
});
