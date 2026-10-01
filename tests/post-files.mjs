// Uploads doc files as attachments into #clankerchat via the MCP send tool.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "1555103465179455488"; // #clankerchat

const files = [
  {
    file: path.join(root, "ONBOARDING.md"),
    caption:
      "📄 **ONBOARDING.md** — human-facing setup guide (file version of the messages above). ~5 min of browser work, your agent does the rest.",
  },
  {
    file: path.join(root, "SETUP.md"),
    caption:
      "📄 **SETUP.md** — the agent-executable runbook. Feed this file straight to your clanker; it does everything except the steps marked **[HUMAN REQUIRED]** (it will stop and tell you exactly what to click).",
  },
];

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
  clientInfo: { name: "post-files", version: "0.0.0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
if (init.result?.serverInfo?.name !== "clankerchat") throw new Error("handshake failed");

for (const { file, caption } of files) {
  const res = await rpc("tools/call", {
    name: "send",
    arguments: { channel_id: CHANNEL, message: caption, file_path: file },
  });
  const text = res.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text);
  if (res.result?.isError) {
    console.error(`FAILED ${path.basename(file)}: ${parsed.error ?? text}`);
    child.kill();
    process.exit(1);
  }
  console.log(
    `attached ${path.basename(file)} — message_id: ${parsed.message_id}` +
      (parsed.note ? ` (note: ${parsed.note})` : ""),
  );
}

child.kill();
console.log("FILES POSTED");
