// Resolve a Discord user id from a username by scanning recent messages in
// visible channels. Usage: node tests/find-user.mjs <name>
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import fs from "node:fs";

const needle = (process.argv[2] || "").toLowerCase();
if (!needle) {
  console.error("usage: node tests/find-user.mjs <username>");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(env.DISCORD_TOKEN);

const hits = new Map();
const PAGES = 3; // 3 x 100 messages per channel
outer: for (const guild of client.guilds.cache.values()) {
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    let before = undefined;
    for (let page = 0; page < PAGES; page++) {
      try {
        const messages = await channel.messages.fetch({
          limit: 100,
          cache: false,
          ...(before ? { before } : {}),
        });
        if (!messages.size) break;
        before = messages.last().id;
        for (const m of messages.values()) {
          const u = m.author;
          const uname = (u.username || "").toLowerCase();
          const gname = (u.globalName || "").toLowerCase();
          if (uname.includes(needle) || gname.includes(needle)) {
            if (!hits.has(u.id)) {
              hits.set(u.id, {
                username: u.username,
                globalName: u.globalName,
                seenIn: channel.name,
              });
            }
            if (hits.size) break outer; // got a clean match — stop scanning
          }
        }
      } catch {
        break; // no access in this channel — next channel
      }
    }
  }
}

if (!hits.size) {
  console.log(`NO MATCH for "${needle}" in recent messages of visible channels`);
} else {
  for (const [id, h] of hits) {
    console.log(`${h.username} (${h.globalName ?? "no display name"}) = <@${id}> id:${id} — seen in #${h.seenIn}`);
  }
}
process.exit(0);
