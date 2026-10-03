/**
 * Smoke test: boots the built MCP server and checks the JSON-RPC handshake.
 *
 * No real Discord token needed — it runs with a dummy token and only verifies
 * that the server speaks MCP (initialize + tools/list). A "Discord login
 * failed" line on stderr is EXPECTED with the dummy token and is not a failure.
 *
 * Usage: npm run smoke   (build first: npm run build)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
  env: {
    ...process.env,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN || "smoke-test-dummy-token",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 10_000).unref();
  });
}

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  child.kill();
  process.exit(1);
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
if (init.result?.serverInfo?.name !== "clankerchat") {
  fail(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`);
}

// notifications carry no id — write it raw so we don't wait for a reply
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const tools = await rpc("tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
const expected = ["bot_file", "bot_inject", "bot_status", "create_thread", "list_channels", "list_threads", "read", "send"].sort();
if (names.join(",") !== expected.join(",")) {
  fail(`unexpected tools: ${names.join(", ")} (expected ${expected.join(", ")})`);
}

console.log(`SMOKE OK — serverInfo: ${JSON.stringify(init.result.serverInfo)}`);
console.log(`SMOKE OK — tools: ${names.join(", ")}`);
child.kill();
