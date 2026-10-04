import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilityMatch,
  bearerOk,
  secretMatch,
  sparkFp,
  rateAllow,
  safeExcerpt,
  scrubForEgress,
  isSparkRecord,
  projectWatcherFacts,
  createSparkListener,
} from "../dist/spark-mcp.js";

test("capabilityMatch: exact normalized path only — no prefix/suffix/trailing-slash relatives", () => {
  const cap = "a3f9c2".padEnd(32, "b");
  assert.equal(capabilityMatch(`/${cap}`, cap), true);
  assert.equal(capabilityMatch(`/${cap}/`, cap), true); // trailing slash tolerated (normalized)
  assert.equal(capabilityMatch(`/${cap}/../etc`, cap), false);
  assert.equal(capabilityMatch(`/${cap}x`, cap), false);
  assert.equal(capabilityMatch(`/x${cap}`, cap), false);
  assert.equal(capabilityMatch("/", cap), false);
  assert.equal(capabilityMatch("/mcp", cap), false);
  assert.equal(capabilityMatch("", cap), false);
});

test("bearerOk/secretMatch: absence and mismatch both fail; timing-safe compare used", () => {
  const tok = "t".repeat(64);
  assert.equal(bearerOk(`Bearer ${tok}`, tok), true);
  assert.equal(bearerOk(undefined, tok), false);
  assert.equal(bearerOk("Basic abc", tok), false);
  assert.equal(bearerOk(`Bearer ${"t".repeat(63)}u`, tok), false);
  // length-different inputs must not throw (timingSafeEqual via sha256 digest)
  assert.equal(secretMatch("short", tok), false);
  assert.equal(bearerOk(undefined, undefined), true); // path-only mode: no token configured
});

test("sparkFp: hash-head provenance, never the secret; stable per input", () => {
  const a = sparkFp("secret-token", "/cap");
  const b = sparkFp("secret-token", "/cap");
  const c = sparkFp(undefined, "/cap");
  assert.equal(a, b);
  assert.equal(a.startsWith("spark:"), true);
  assert.match(a, /^spark:[0-9a-f]{16}$/);
  assert.notEqual(a, c); // path-only deployments get a distinct identity
  assert.ok(!a.includes("secret-token"));
});

test("rateAllow: real cap behavior", () => {
  const gate = { hits: [] };
  const t0 = 5_000_000;
  let admitted = 0;
  for (let i = 0; i < 200; i++) if (rateAllow(gate, t0)) admitted++;
  assert.equal(admitted, 60); // RATE_MAX
  assert.equal(rateAllow(gate, t0 + 1), false); // still full
  assert.equal(rateAllow(gate, t0 + 61_000), true); // window slid
});

test("safeExcerpt: leak-shaped blanks, long caps", () => {
  assert.equal(safeExcerpt("all good"), "all good");
  assert.equal(safeExcerpt(undefined), "");
  assert.equal(safeExcerpt(""), "");
  assert.equal(safeExcerpt("sk-" + "A".repeat(30)), ""); // secret-shaped → blanked
  assert.equal(safeExcerpt("x".repeat(5000)).length, 800);
});

// --- HTTP listener: uniform dead-host 404 + full MCP roundtrip on the right path ---
// MCP streamable HTTP servers may answer application/json OR text/event-stream
// (SSE-framed `data:` lines) depending on negotiation — parse either.
async function rpcBody(res) {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    return JSON.parse(data[0]);
  }
  return JSON.parse(text);
}

async function withServer(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-test-"));
  const cap = "c0ffee".padEnd(32, "0");
  const token = "k".repeat(48);
  const listener = createSparkListener({ capPath: cap, token }, { spoolDir: tmp, fp: "spark:test" });
  const srv = http.createServer(listener);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  try {
    await fn({ base: `http://127.0.0.1:${port}`, cap, token, tmp });
  } finally {
    srv.close();
  }
}

test("listener: uniform 404 for scans — wrong path, no path, wrong/absent bearer all look dead", async () => {
  await withServer(async ({ base, cap, token }) => {
    const cases = [
      ["GET", "/", undefined],
      ["GET", "/mcp", undefined],
      ["POST", "/mcp", token],
      ["GET", `/${cap}`, undefined], // right path, NO bearer → still dead-host
      ["POST", `/${cap}`, "Bearer wrong"],
      ["POST", `/${cap}x`, `Bearer ${token}`],
    ];
    for (const [method, p, auth] of cases) {
      const res = await fetch(base + p, { method, headers: auth ? { authorization: auth } : {} });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  });
});

test("listener: MCP initialize + tools/list roundtrip on the capability path", async () => {
  await withServer(async ({ base, cap, token }) => {
    const rpc = (id, method, params) =>
      fetch(`${base}/${cap}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    let res = await rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(res.status, 200);
    const info = await rpcBody(res);
    assert.equal(info.jsonrpc, "2.0");
    assert.equal(info.result.protocolVersion, "2025-06-18");
    assert.equal(info.result.serverInfo.name, "clankerchat-spark");
    res = await rpc(2, "tools/list", {});
    assert.equal(res.status, 200);
    const tools = (await rpcBody(res)).result.tools.map((t) => t.name);
    assert.deepEqual([...tools].sort(), ["ask_clanker", "list_recent_prompts", "machine_status", "prompt_result"]);
  });
});

test("listener: ask_clanker refuses leak-shaped and mass-mention text at the door, accepts clean", async () => {
  await withServer(async ({ base, cap, token }) => {
    const call = (args) =>
      fetch(`${base}/${cap}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ask_clanker", arguments: args } }),
      }).then(async (r) => ({ status: r.status, body: await rpcBody(r) }));
    const leak = await call({ text: "my token is ghp_" + "A".repeat(30) });
    assert.equal(leak.status, 200);
    assert.equal(leak.body.result.isError, true);
    assert.match(leak.body.result.content[0].text, /REFUSED/);
    const mention = await call({ text: "ping " + "@".concat("everyone") + " now" });
    assert.equal(mention.body.result.isError, true);
    const clean = await call({ text: "status check please" });
    assert.equal(clean.body.result.isError, undefined);
    assert.match(clean.body.result.content[0].text, /prompt_id/);
  });
});

// --- EGRESS LAW (owner 2026-10-04): no other-user content, no email/PII out ---

test("scrubForEgress: emails, mention tokens, 7+ digit runs blanked; plain text intact", () => {
  const out = scrubForEgress("mail someone@example.com or <@123456789012345678> re: order 4821 within 7 days");
  assert.ok(!out.includes("someone@example.com"));
  assert.ok(!out.includes("<@123456789012345678>"));
  assert.match(out, /\[redacted-email\]/);
  assert.match(out, /\[redacted-mention\]/);
  assert.ok(out.includes("4821")); // short digit groups survive
  assert.equal(scrubForEgress("plain text, 123 456 fine"), "plain text, 123 456 fine");
  assert.ok(!scrubForEgress("user 9988776655 called").includes("9988776655")); // phone/snowflake-shaped
  assert.ok(!scrubForEgress("channel <#1555103465179455488>").includes("1555103465179455488"));
});

test("safeExcerpt: clean text carrying an email rides scrubbed, never raw", () => {
  const out = safeExcerpt("a teammate wrote tyler@fastmail.example about the build");
  assert.ok(out.includes("[redacted-email]"));
  assert.ok(!out.includes("tyler@fastmail.example"));
});

test("isSparkRecord: spark fp yes; phone fp, missing fp, null all no", () => {
  assert.equal(isSparkRecord({ fp: "spark:6964a8fcba93dea7" }), true);
  assert.equal(isSparkRecord({ fp: "phone:abc" }), false);
  assert.equal(isSparkRecord({}), false);
  assert.equal(isSparkRecord(null), false);
});

test("projectWatcherFacts: numbers/timestamps/lane-ok survive; names and unknowns dropped", () => {
  const out = projectWatcherFacts({
    active: 1,
    queued_human: 0,
    queued_bot: 2,
    max_concurrent: 2,
    last_run_at: "2026-10-04T18:21:23.456Z",
    updated: "2026-10-04T18:22:00.000Z",
    lane: { ok: true, pending: 0, injects: 41, bot: "joesp-desktop", peerLastRunAt: "2026-10-04T18:00:00.000Z" },
    junk: { deep: "stuff" },
  });
  assert.equal(out.activeRuns, 1);
  assert.equal(out.queuedBot, 2);
  assert.equal(out.laneUp, true);
  assert.equal(out.lastRunAt, "2026-10-04T18:21:23.456Z");
  assert.equal(out.stale, false);
  const s = JSON.stringify(out);
  assert.ok(!s.includes("joesp-desktop")); // identities never ride the WAN leg
  assert.ok(!s.includes("junk"));
  // garbage in → honest stale marker, no throw
  assert.equal(projectWatcherFacts(null).stale, true);
});

test("listener: prompt_result and list_recent_prompts see spark records ONLY, scrubbed", async () => {
  await withServer(async ({ base, cap, token, tmp }) => {
    // Plant two records in the shared prompt registry: one phone-surface
    // (foreign — must be invisible here), one spark-surface whose excerpt
    // carries other-user content + PII shapes (must ride scrubbed).
    const dir = path.join(tmp, "pending-prompts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pmphone0001.json"),
      JSON.stringify({
        promptId: "pmphone0001",
        text: "phone prompt text",
        fp: "phone: enrolled-device",
        status: "answered",
        exit: 0,
        createdAt: Date.now(),
        answerExcerpt: "quoted ggurov saying tyler@fastmail.example",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "pmspark0002.json"),
      JSON.stringify({
        promptId: "pmspark0002",
        text: "spark prompt text",
        fp: "spark:test",
        status: "answered",
        exit: 0,
        createdAt: Date.now(),
        answerExcerpt: "done — cc someone@example.com and <@210949752617959424> per 4821",
      }),
    );
    const call = (name, args, id) =>
      fetch(`${base}/${cap}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      }).then((r) => rpcBody(r));
    // foreign record: indistinguishable miss
    const foreign = await call("prompt_result", { prompt_id: "pmphone0001" }, 21);
    assert.equal(foreign.result.isError, true);
    assert.match(foreign.result.content[0].text, /no such prompt_id/);
    // spark record: visible, excerpt scrubbed — no raw email/mention/snowflake
    const own = await call("prompt_result", { prompt_id: "pmspark0002" }, 22);
    assert.equal(own.result.isError, undefined);
    const ownText = own.result.content[0].text;
    assert.ok(!ownText.includes("someone@example.com"));
    assert.ok(!ownText.includes("<@210949752617959424>"));
    assert.match(ownText, /\[redacted-email\]/);
    assert.match(ownText, /\[redacted-mention\]/);
    assert.ok(ownText.includes("4821"));
    // list: spark only
    const list = await call("list_recent_prompts", {}, 23);
    const listText = list.result.content[0].text;
    assert.ok(listText.includes("pmspark0002"));
    assert.ok(!listText.includes("pmphone0001"));
    assert.ok(!listText.includes("phone prompt text"));
  });
});
