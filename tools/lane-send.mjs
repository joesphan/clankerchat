// lane-send.mjs — one-shot botlink inject from the CLI (worker-side twin of the
// MCP bot_inject tool). The consumer's worker sessions run with only the
// clankerchat MCP tools allowed and that instance has no botlink client env,
// so lane replies need this. Reads the pinned peer hostkey from .env; key and
// peer come from env or defaults matching this machine's setup.
//   node tools/lane-send.mjs --target orchestrator --text "..." [--thread shim]
//          [--kind question] [--correlation ID] [--reply-to ID] [--file PATH --file-note "..."]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { botlinkRequest } from "../dist/botlink.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const envUrl = fs.readFileSync(path.join(ROOT, ".env"), "utf8")
  .match(/^CLANKER_BOTLINK_PEER_HOSTKEY=(.+)$/m)?.[1]?.trim();

const peer = {
  host: process.env.CLANKER_BOTLINK_PEER_HOST ?? "100.64.0.1",
  port: Number(process.env.CLANKER_BOTLINK_PEER_PORT ?? 47421),
  user: process.env.CLANKER_BOTLINK_USER ?? "clanker",
  privateKeyPem: fs.readFileSync(path.join(ROOT, "botlink-keys", "bot_key"), "utf8"),
  expectedHostKey: process.env.CLANKER_BOTLINK_PEER_HOSTKEY ?? envUrl,
};

const text = opt("text");
if (!text) {
  console.error("usage: lane-send.mjs --target NAME --text TEXT [--thread NAME] [--kind ...] [--correlation ID] [--reply-to ID] [--file PATH --file-note LINE]");
  process.exit(2);
}
const filePath = opt("file");
let filePart;
if (filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
    console.error(`file out of bounds: ${bytes.length} bytes (cap 2 MB)`);
    process.exit(2);
  }
  filePart = {
    name: path.basename(filePath),
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    content_b64: bytes.toString("base64"),
    ...(opt("file-note") ? { note: opt("file-note") } : {}),
  };
}
const payload = {
  source: "joesp-desktop",
  target: opt("target") ?? "orchestrator",
  text,
  ...(opt("thread") ? { thread: opt("thread") } : {}),
  ...(opt("kind") || opt("correlation") || opt("reply-to")
    ? { task: {
        ...(opt("kind") ? { kind: opt("kind") } : {}),
        ...(opt("correlation") ? { correlation: opt("correlation") } : {}),
        ...(opt("reply-to") ? { reply_to: opt("reply-to") } : {}),
      } }
    : {}),
  ...(filePart ? { file: filePart } : {}),
};

try {
  const out = await botlinkRequest(peer, "inject", payload);
  console.log(out.trim() || "inject accepted (no stdout)");
} catch (err) {
  console.error(`lane-send FAILED: ${err.message}`);
  process.exit(1);
}
