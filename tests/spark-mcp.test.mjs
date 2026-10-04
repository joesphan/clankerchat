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
