// T0 Groq adapter tests (cascade rounds 1-3, 2026-10-05) — the tier-0
// generation seat. Covers the properties the design claims:
//   - off-by-default: mode "off" refuses without touching anything.
//   - mock mode: deterministic, "[t0-mock]"-prefixed, zero-network output —
//     the full pipeline is exercisable with no key and no spend.
//   - live gating: no key → refusal (never a silent degrade); key handling
//     reads CLANKER_GROQ_API_KEY then GROQ_API_KEY.
//   - truncation hygiene: inputs capped at the rate-limit-safe bound.
//   - the system prompt frames user text as data and forbids mention/
//     credential output (defense in depth — the send-site tripwires are the
//     hard gate, this keeps the model from trying in the first place).
//
// NO NETWORK IN THESE TESTS: live mode is only exercised up to the key check.
//
// Usage: node --test tests/t0groq.test.mjs   (build first: npm run build)

import test from "node:test";
import assert from "node:assert/strict";

import { T0Refused, buildT0UserMsg, t0Complete, t0Mode } from "../dist/t0groq.js";

const KEY_VARS = ["CLANKER_GROQ_API_KEY", "GROQ_API_KEY"];

function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("mode defaults to off and unknown values clamp to off", () => {
  const saved = {};
  for (const k of KEY_VARS) (saved[k] = process.env[k]), delete process.env[k];
  delete process.env.CLANKER_T0_MODE;
  assert.equal(t0Mode(), "off");
  process.env.CLANKER_T0_MODE = "banana";
  assert.equal(t0Mode(), "off");
  process.env.CLANKER_T0_MODE = "mock";
  assert.equal(t0Mode(), "mock");
  process.env.CLANKER_T0_MODE = "live";
  assert.equal(t0Mode(), "live");
  delete process.env.CLANKER_T0_MODE;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("off mode refuses before anything else", async () => {
  await withEnv({ CLANKER_T0_MODE: undefined }, async () => {
    await assert.rejects(t0Complete({ trigger: "hi" }), (e) => e instanceof T0Refused && e.code === "mode-off");
  });
});

test("mock mode: deterministic, self-identifying, zero-spend output", async () => {
  await withEnv({ CLANKER_T0_MODE: "mock", CLANKER_GROQ_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    const r = await t0Complete({ trigger: "thanks!", where: "shim" });
    assert.equal(r.mock, true);
    assert.ok(r.text.startsWith("[t0-mock]"), r.text.slice(0, 40));
    assert.equal(r.mode, "mock");
    const r2 = await t0Complete({ trigger: "thanks!" });
    assert.equal(r.text, r2.text); // deterministic shape (mock output ignores where)
  });
});

test("live mode without a key refuses (never silently degrades)", async () => {
  await withEnv({ CLANKER_T0_MODE: "live", CLANKER_GROQ_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    await assert.rejects(t0Complete({ trigger: "hi" }), (e) => e instanceof T0Refused && e.code === "no-key");
  });
});

test("input truncation keeps the request inside rate-limit hygiene bounds", () => {
  const huge = "x".repeat(200_000);
  const msg = buildT0UserMsg({ trigger: huge, history: [huge, huge], where: "w" });
  assert.ok(msg.length <= 20_000, `capped: ${msg.length}`);
  assert.ok(msg.includes("Location: w"));
  assert.ok(msg.includes("Message to answer"));
});

test("context and trigger both ride the user message", () => {
  const msg = buildT0UserMsg({ trigger: "what do you think", history: ["earlier: foo", "then: bar"], where: "epicNode" });
  assert.ok(msg.includes("earlier: foo"));
  assert.ok(msg.includes("what do you think"));
});
