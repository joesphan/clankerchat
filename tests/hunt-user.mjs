// Hunt for a user id without privileged intents: member search (REST),
// reaction authors, thread member lists, then deeper message history.
// Usage: node tests/hunt-user.mjs <name>
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import fs from "node:fs";

const needle = (process.argv[2] || "").toLowerCase();
if (!needle) {
  console.error("usage: node tests/hunt-user.mjs <username>");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(env.DISCORD_TOKEN);
console.log(`hunting "${needle}" as ${client.user.username}`);

const seen = new Map(); // id -> { username, globalName, how }
function match(user, how) {
  if (!user || seen.has(user.id)) return false;
  const uname = (user.username || "").toLowerCase();
  const gname = (user.globalName || "").toLowerCase();
  if (uname.includes(needle) || gname.includes(needle)) {
    seen.set(user.id, { username: user.username, globalName: user.globalName, how });
    console.log(`MATCH: ${user.username} (${user.globalName ?? "-"}) id=${user.id} — via ${how}`);
    return true;
  }
  return false;
}

const guilds = [...client.guilds.cache.values()];

// 1 — REST member search (no privileged intent needed over REST)
for (const guild of guilds) {
  try {
    const res = await guild.members.search({ query: needle, limit: 25 });
    let hit = false;
    for (const m of res.values()) hit = match(m.user, `member search in ${guild.name}`) || hit;
    if (!hit && res.size) console.log(`member search in ${guild.name}: ${res.size} results, no match`);
    if (!res.size) console.log(`member search in ${guild.name}: no results`);
  } catch (e) {
    console.log(`member search failed in ${guild.name}: ${e.message}`);
  }
}
if (seen.size) process.exit(0);

// 2 — reaction authors on recent messages
console.log("--- scanning reactions");
outer: for (const guild of guilds) {
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    try {
      const messages = await channel.messages.fetch({ limit: 50, cache: false });
      for (const m of messages.values()) {
        for (const reaction of m.reactions.cache.values()) {
          try {
            const users = await reaction.users.fetch({ limit: 100 });
            for (const u of users.values()) {
              if (match(u, `reaction in #${channel.name}`)) break outer;
            }
          } catch {}
        }
      }
    } catch {}
  }
}
if (seen.size) process.exit(0);

// 3 — thread member lists
console.log("--- scanning thread members");
outer3: for (const guild of guilds) {
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    try {
      const active = await channel.threads.fetchActive();
      for (const thread of active.threads.values()) {
        try {
          const members = await thread.members.fetch();
          for (const tm of members.values()) {
            try {
              const u = await client.users.fetch(tm.id, { cache: true });
              if (match(u, `thread member of "${thread.name}"`)) break outer3;
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }
}
if (seen.size) process.exit(0);

// 4 — deep message history (10 x 100 per channel, oldest channels first)
console.log("--- deep message scan");
outer4: for (const guild of guilds) {
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    let before;
    try {
      for (let page = 0; page < 10; page++) {
        const messages = await channel.messages.fetch({
          limit: 100,
          cache: false,
          ...(before ? { before } : {}),
        });
        if (!messages.size) break;
        before = messages.last().id;
        for (const m of messages.values()) {
          if (match(m.author, `message in #${channel.name}`)) break outer4;
        }
      }
    } catch {}
  }
}

if (!seen.size) {
  console.log(`STILL NO MATCH — "${needle}" has left no readable trace in anything this bot can see`);
  console.log("(Discord hides non-posting members from bots without the Server Members privileged intent)");
}
process.exit(0);
