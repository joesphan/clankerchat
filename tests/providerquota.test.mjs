import test from "node:test";
import assert from "node:assert/strict";

import { parseQuota, quotaLine, pollProviderQuota } from "../dist/providerquota.js";

// providerquota (round 24.2 producer): the vendor monitor API's raw types are
// the contract — TOKENS_LIMIT/TIME_LIMIT, never the plugin's display renames
// ("Token usage(5 Hour)" parses null — the first-try mistake on both sides).
// parseQuota/quotaLine are pure; pollProviderQuota's host allowlist is the
// one network-adjacent path tested here (it short-circuits before any fetch).

const QUOTA = {
  limits: [
    { type: "TOKENS_LIMIT", percentage: 24, nextResetTime: Date.UTC(2026, 9, 5, 9, 10, 44) },
    { type: "TIME_LIMIT", percentage: 7, currentValue: 304, usage: 4000 },
  ],
};
const MODEL = { totalUsage: { totalModelCallCount: 15770, totalTokensUsage: 2372550071 } };

test("parseQuota: raw TOKENS_LIMIT + nextResetTime + model totals", () => {
  const q = parseQuota(Date.UTC(2026, 9, 5, 5, 20), QUOTA, MODEL);
  assert.equal(q.pct5h, 24);
  assert.equal(q.resetAt, "2026-10-05T09:10:44.000Z");
  assert.equal(q.mcpPct, 7);
  assert.equal(q.calls24h, 15770);
  assert.equal(q.tokens24h, 2372550071);
});

test("parseQuota: display-renamed types parse null (raw-type law)", () => {
  const renamed = {
    limits: QUOTA.limits.map((l) =>
      l.type === "TOKENS_LIMIT" ? { type: "Token usage(5 Hour)", percentage: l.percentage } : l,
    ),
  };
  assert.equal(parseQuota(0, renamed), null);
  assert.equal(parseQuota(0, { limits: [] }), null);
});

test("quotaLine: card contract shape, mention-safe", () => {
  const line = quotaLine(parseQuota(0, QUOTA, MODEL));
  assert.equal(line, "5h quota 24% (15770 calls/24h · 2373M tok · reset 09:10Z)");
  assert.ok(!line.includes("@"), "card lines never carry @ (mass-mention law)");
});

test("quotaLine: quota-only reading renders without context", () => {
  assert.equal(quotaLine(parseQuota(0, QUOTA)), "5h quota 24% (reset 09:10Z)");
  const bare = { now: 0, pct5h: 3, resetAt: null, mcpPct: null, calls24h: null, tokens24h: null };
  assert.equal(quotaLine(bare), "5h quota 3%");
});

test("pollProviderQuota: non-allowlisted origin never sees the token", async () => {
  assert.equal(
    await pollProviderQuota({ baseUrl: "https://evil.example.com/api/anthropic", token: "x" }),
    null,
  );
  assert.equal(await pollProviderQuota({ baseUrl: "not a url", token: "x" }), null);
});
