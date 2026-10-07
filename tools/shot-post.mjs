// shot-post.mjs — AI-free scheduled Discord post (owner guideline 2026-10-05:
// "the task should send to the thread without AI agent involvement").
// Posts one image to the pinned thread using this repo's .env (token never
// printed). usage: node tools/shot-post.mjs <image-path> [message]
import fs from "node:fs";
import path from "node:path";
import { Client } from "discord.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const env = Object.fromEntries(
    fs.readFileSync(path.join(ROOT, ".env"), "utf8")
        .split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const img = process.argv[2];
const threadId = process.argv[3] || env.CLANKER_THREAD_ID;
const msg = process.argv.slice(4).join(" ") || "🖥️ auto-shot (scheduled task, no AI)";
if (!img || !fs.existsSync(img)) { console.error("usage: node tools/shot-post.mjs <image> [threadId] [msg...]"); process.exit(1); }

const t = setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
const client = new Client({ intents: [] });
client.once("ready", async () => {
    try {
        const ch = await client.channels.fetch(threadId);
        await ch.send({ content: msg, files: [img] });
        console.log("posted to", threadId);
    } catch (e) { console.error("send failed:", e.message); process.exitCode = 1; }
    clearTimeout(t);
    client.destroy();
});
client.login(env.DISCORD_TOKEN).catch((e) => { console.error("login failed:", e.message); process.exit(1); });
