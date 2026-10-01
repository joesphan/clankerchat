/**
 * End-to-end test (SETUP.md Step 9, automated): exercises the full chain
 * against real Discord — channel discovery, project-thread creation,
 * sending, and cursor-based reading. Posts real messages into the team
 * channel's "clankerchat" thread; that's the point.
 *
 * Usage: npm run e2e   (build first: npm run build)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const conn = await connect();

function step(name) {
  console.log(`--- ${name}`);
}
function fail(msg) {
  console.error(`E2E FAIL: ${msg}`);
  conn.kill();
  process.exit(1);
}

async function tool(name, args) {
  const res = await conn.callTool(name, args);
  const text = res.result?.content?.[0]?.text ?? "{}";
  if (res.result?.isError) {
    fail(`${name} returned: ${JSON.parse(text).error ?? text}`);
  }
  return JSON.parse(text);
}

// 1 — find the team channel
step("list_channels");
const channels = await tool("list_channels", {});
const byId = process.env.CLANKER_CHANNEL_ID;
const channel =
  channels.guilds.flatMap((g) => g.channels).find((c) => c.id === byId) ??
  channels.guilds.flatMap((g) => g.channels).find((c) => c.name === "clankerchat");
if (!channel) fail("team channel not found — is the bot added to it? (SETUP.md Step 5)");
console.log(`channel: #${channel.name} (${channel.id})`);

// 2 — create (or find) the project thread
step("create_thread");
const thread = await tool("create_thread", {
  name: "clankerchat",
  channel_id: channel.id,
  message: "👋 clankerchat e2e — project thread bootstrapped.",
});
console.log(`thread: ${thread.name} (${thread.thread_id}) existed=${thread.existed}`);

// 3 — send via thread_name
step("send (by thread_name)");
const sender = process.env.CLANKER_NAME || "e2e";
const sent = await tool("send", {
  thread_name: "clankerchat",
  message: `e2e ping from **${sender}** — send-by-name works.`,
  sender,
});
console.log(`sent message_id: ${sent.message_id}`);

// 4 — read only newer messages (cursor)
step("read (after cursor)");
const read1 = await tool("read", { thread_name: "clankerchat", limit: 5, after: sent.message_id });
if (read1.messages.some((m) => m.id === sent.message_id)) {
  fail("cursor broken: already-seen message came back");
}
const read0 = await tool("read", { thread_name: "clankerchat", limit: 10 });
const mine = read0.messages.find((m) => m.id === sent.message_id);
if (!mine) fail("sent message not found on re-read");
if (mine.sender !== sender) fail(`sender not parsed back: got ${JSON.stringify(mine.sender)}`);
console.log(`read back ok — sender parsed as "${mine.sender}"`);
console.log(`next cursor: ${read0.last_message_id}`);

conn.kill();
console.log("E2E OK — channel, thread creation, send-by-name, cursor read, sender parsing all verified");

/** Spawns the server and returns { callTool, kill }. */
async function connect() {
  loadEnv();
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
      }, 30_000).unref();
    });
  }

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "0.0.0" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  if (init.result?.serverInfo?.name !== "clankerchat") {
    throw new Error(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`);
  }
  return {
    callTool: (name, args = {}) => rpc("tools/call", { name, arguments: args }),
    kill: () => child.kill(),
  };
}
