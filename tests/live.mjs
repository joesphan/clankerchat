/**
 * Live check: boots the built MCP server with the real .env and exercises the
 * tools against real Discord. Verifies, in order: token valid (login), bot
 * invited somewhere (guilds present), channels visible. Optionally lists the
 * threads of one channel: `npm run live -- <channel_id>` (or set
 * CLANKER_CHANNEL_ID in .env). Prints only names/IDs — never the token.
 *
 * Usage: npm run live   (build first: npm run build)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Spawns the server and returns { rpc, callTool, kill }. */
async function connect() {
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
    clientInfo: { name: "live-test", version: "0.0.0" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  if (init.result?.serverInfo?.name !== "clankerchat") {
    throw new Error(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`);
  }

  return {
    rpc,
    callTool: (name, args = {}) => rpc("tools/call", { name, arguments: args }),
    kill: () => child.kill(),
  };
}

const conn = await connect();

const res = await conn.callTool("list_channels");

// Optional: list threads of one channel
const threadTarget = process.argv[2] || process.env.CLANKER_CHANNEL_ID;
if (threadTarget) {
  const t = await conn.callTool("list_threads", { channel_id: threadTarget });
  if (t.result?.isError) {
    console.error(`THREADS FAILED: ${t.result.content?.[0]?.text}`);
    conn.kill();
    process.exit(1);
  }
  const td = JSON.parse(t.result.content[0].text);
  console.log(`threads of channel ${td.channel_id}:`);
  for (const th of td.threads)
    console.log(`  thread: ${th.name} (${th.id})${th.archived ? " [archived]" : ""}`);
  if (!td.threads.length) console.log("  (none)");
}

conn.kill();

if (res.result?.isError) {
  console.error(`LIVE CHECK FAILED: ${res.result.content?.[0]?.text}`);
  process.exit(1);
}

const data = JSON.parse(res.result.content[0].text);
console.log(`LIVE OK — bot: ${data.bot.username} (${data.bot.id})`);
if (!data.guilds.length) {
  console.log("No servers yet — the bot has not been invited anywhere (SETUP.md Step 3).");
} else {
  for (const g of data.guilds) {
    console.log(`server: ${g.name} (${g.id})`);
    for (const c of g.channels) console.log(`  text channel: #${c.name} (${c.id})`);
    if (!g.channels.length) console.log("  (no visible text channels)");
  }
}
