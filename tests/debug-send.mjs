// Temporary probe: find which exact call throws "Unknown Channel".
import { Client, GatewayIntentBits } from "discord.js";
import fs from "node:fs";

const env = {};
for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(env.DISCORD_TOKEN);
console.log("logged in as", client.user.username);

const ch = await client.channels.fetch(env.CLANKER_CHANNEL_ID);
console.log("1. channel fetch ok:", ch.name, "type:", ch.type);

const active = await ch.threads.fetchActive();
const names = [...active.threads.values()].map((t) => t.name);
console.log("2. fetchActive ok:", JSON.stringify(names));

try {
  const arch = await ch.threads.fetchArchived();
  console.log("3. fetchArchived ok:", JSON.stringify([...arch.threads.values()].map((t) => t.name)));
} catch (e) {
  console.log("3. fetchArchived FAILED:", e.message);
}

const t = [...active.threads.values()].find((x) => x.name.toLowerCase() === "clankerchat");
console.log("4. name match:", t ? `${t.name} (${t.id})` : "NOT FOUND");

if (t) {
  const msg = await t.send("**debug** direct thread send");
  console.log("5. send ok:", msg.id);
  const got = await client.channels.fetch(t.id);
  console.log("6. refetch thread ok:", got.name, got.id);
}
process.exit(0);
