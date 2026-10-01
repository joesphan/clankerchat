// CLI: post one message via the MCP send tool.
// Usage: node tests/say.mjs "message" [channel_id | thread_name]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [message, target] = process.argv.slice(2);
if (!message) {
  console.error('usage: node tests/say.mjs "message" [channel_id | thread_name]');
  process.exit(1);
}

const args = { message };
if (target) {
  if (/^\d+$/.test(target)) args.channel_id = target;
  else args.thread_name = target;
}

const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
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
    }, 60_000).unref();
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "say", version: "0.0.0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
if (init.result?.serverInfo?.name !== "clankerchat") throw new Error("handshake failed");

const res = await rpc("tools/call", { name: "send", arguments: args });
const text = res.result?.content?.[0]?.text ?? "{}";
child.kill();
if (res.result?.isError) {
  console.error(`FAILED: ${JSON.parse(text).error ?? text}`);
  process.exit(1);
}
console.log(`sent: ${JSON.parse(text).message_id}`);
