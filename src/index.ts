#!/usr/bin/env node
/**
 * clankerchat — Discord MCP server for agent-to-agent chat in a shared thread.
 *
 * Model:
 *   - One Discord bot per machine; every machine runs this same server with its
 *     own token, and all bots post into the same private channel/thread. That
 *     gives per-machine attribution in the Discord UI; per-agent attribution is
 *     layered on top with the `sender` parameter ("**name**: message").
 *   - Agents poll, Discord doesn't push. `read` accepts an `after` message-ID
 *     cursor so each agent only ever sees messages newer than its bookmark.
 *   - Only the non-privileged Guilds gateway intent is used; everything else
 *     (send / fetch messages, list threads) is plain REST, so no privileged
 *     intent toggles are needed in the developer portal.
 *
 * stdout is reserved for MCP JSON-RPC. All diagnostics go to stderr.
 */

import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  NewsChannel,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
  type Message,
} from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadEnvFile } from "./env.js";

const MAX_MESSAGE_LENGTH = 2000; // Discord hard limit per message
const READY_TIMEOUT_MS = 20_000;
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Discord client — gateway connects with Guilds intent only; the tools below
// do everything else over REST.
// ---------------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let resolveReady!: (c: Client<true>) => void;
let rejectReady!: (err: Error) => void;
const ready = new Promise<Client<true>>((res, rej) => {
  resolveReady = res;
  rejectReady = rej;
});

client.once(Events.ClientReady, (c) => {
  console.error(`clankerchat: connected as ${c.user.username} (${c.user.id})`);
  resolveReady(c);
});

client.on(Events.Error, (err) => {
  console.error(`clankerchat: discord client error: ${err.message}`);
});

async function startDiscord(token: string): Promise<void> {
  try {
    await client.login(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`clankerchat: Discord login failed: ${message}`);
    rejectReady(
      new Error(
        `Discord login failed: ${message}. Check DISCORD_TOKEN in .env (see SETUP.md).`,
      ),
    );
  }
}

async function awaitReady(): Promise<Client<true>> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `Discord connection not ready after ${READY_TIMEOUT_MS / 1000}s (still connecting or login failed — check stderr).`,
          ),
        ),
      READY_TIMEOUT_MS,
    ).unref();
  });
  return Promise.race([ready, timeout]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ChatChannel = TextChannel | ThreadChannel | NewsChannel;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Runs a tool body and turns thrown errors into structured tool errors. */
async function guard(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await body());
  } catch (err) {
    return textResult({ error: errText(err) }, true);
  }
}

async function getChatChannel(channelId: string): Promise<ChatChannel> {
  await awaitReady();
  const channel = await client.channels.fetch(channelId);
  if (
    channel instanceof TextChannel ||
    channel instanceof ThreadChannel ||
    channel instanceof NewsChannel
  ) {
    return channel;
  }
  throw new Error(
    `Channel ${channelId} is not a text channel or thread${channel ? ` (type: ${channel.type})` : " (not found or no access)"}.`,
  );
}

/**
 * Resolves the target channel for send/read/list_threads: the explicit
 * parameter wins, otherwise fall back to the .env defaults, otherwise fail
 * with a hint.
 */
function resolveChannelId(
  explicit: string | undefined,
  envVar: "CLANKER_THREAD_ID" | "CLANKER_CHANNEL_ID",
  what: string,
): string {
  const id = explicit || process.env[envVar];
  if (!id) {
    throw new Error(
      `No ${what} given. Pass an ID, or set ${envVar} in .env so it can be defaulted (see SETUP.md).`,
    );
  }
  return id;
}

/** Lists active + archived threads of a text channel (archived included so
 *  auto-archived project threads stay addressable). */
async function allThreads(channel: Exclude<ChatChannel, ThreadChannel>) {
  const [active, archived] = await Promise.all([
    channel.threads.fetchActive(),
    channel.threads.fetchArchived(),
  ]);
  return [...active.threads.values(), ...archived.threads.values()];
}

/** Finds a project thread by name in the .env channel — the human-friendly
 *  handle for the one-thread-per-project convention. */
async function findThreadByName(name: string): Promise<ThreadChannel> {
  const channelId = process.env.CLANKER_CHANNEL_ID;
  if (!channelId) {
    throw new Error(
      "thread_name lookup needs CLANKER_CHANNEL_ID set in .env (SETUP.md Step 6).",
    );
  }
  const parent = await getChatChannel(channelId);
  if (parent instanceof ThreadChannel) {
    throw new Error(`CLANKER_CHANNEL_ID ${channelId} is a thread, not a text channel.`);
  }
  const wanted = name.toLowerCase().replace(/^#/, "").trim();
  const found = (await allThreads(parent)).find(
    (t) => t.name.toLowerCase() === wanted,
  );
  if (!found) {
    const names = (await allThreads(parent)).map((t) => t.name).join(", ") || "(none)";
    throw new Error(
      `No thread named "${name}" in the team channel. Existing: ${names}. ` +
        "Create it with create_thread if it should exist.",
    );
  }
  return found;
}

/**
 * Target resolution for send/read: explicit channel_id > thread_name lookup >
 * CLANKER_THREAD_ID default.
 */
async function resolveTargetChannel(
  channelId: string | undefined,
  threadName: string | undefined,
): Promise<ChatChannel> {
  if (channelId) return getChatChannel(channelId);
  if (threadName) return findThreadByName(threadName);
  return getChatChannel(resolveChannelId(undefined, "CLANKER_THREAD_ID", "channel_id or thread_name"));
}

const SENDER_PREFIX = /^\*\*(.+?)\*\*: ?/;

/** Signs a message with the sending agent's name, e.g. `**joes-desktop**: ...` */
function withSender(sender: string | undefined, message: string): string {
  if (!sender) return message;
  const clean = sender.replace(/[*_`~|\\\n\r]/g, "").trim();
  return clean ? `**${clean}**: ${message}` : message;
}

function serializeMessage(m: Message) {
  const match = SENDER_PREFIX.exec(m.content);
  return {
    id: m.id,
    timestamp: m.createdAt.toISOString(),
    author: { username: m.author.username, id: m.author.id, bot: m.author.bot },
    // sender = the identity the agent declared when sending (null for plain messages)
    sender: match ? match[1] : null,
    content: match ? m.content.slice(match[0].length) : m.content,
    attachments: [...m.attachments.values()].map((a) => ({
      filename: a.name,
      url: a.url,
    })),
  };
}

function byIdAscending(a: { id: string }, b: { id: string }): number {
  const cmp = BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  return cmp;
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

function registerTools(server: McpServer): void {
  server.registerTool(
    "send",
    {
      title: "Send clankerchat message",
      description: [
        "Send a message to the team's Discord channel or thread (agent-to-agent chat).",
        "Other agents poll `read` to see it — there is no push, so if you expect a reply,",
        "say so and check back with `read` later (using the `after` cursor).",
        "Use `sender` so other agents and humans know which agent is talking.",
      ].join(" "),
      inputSchema: {
        channel_id: z
          .string()
          .optional()
          .describe(
            "Channel or thread ID (snowflake). Defaults to CLANKER_THREAD_ID from .env.",
          ),
        thread_name: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Project thread name to send to (e.g. 'clankerchat'), resolved in the .env team channel — the usual way with one thread per project.",
          ),
        message: z
          .string()
          .min(1)
          .describe("Message text; Discord markdown allowed; max 2000 chars."),
        sender: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Identity of the sending agent (e.g. 'joes-desktop'). Defaults to CLANKER_NAME from .env.",
          ),
        file_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional local file to attach (path). Requires the bot to have Attach Files. `message` becomes the caption.",
          ),
      },
    },
    ({ channel_id, thread_name, message, sender, file_path }) =>
      guard(async () => {
        if (message.length > MAX_MESSAGE_LENGTH) {
          throw new Error(
            `Message is ${message.length} chars; Discord allows ${MAX_MESSAGE_LENGTH}. Split it into parts.`,
          );
        }
        let attachment: { attachment: string; name: string } | undefined;
        if (file_path) {
          const abs = path.resolve(file_path);
          if (!fs.existsSync(abs)) {
            throw new Error(`File not found: ${abs}`);
          }
          attachment = { attachment: abs, name: path.basename(abs) };
        }
        const channel = await resolveTargetChannel(channel_id, thread_name);
        const id = channel.id;
        let note: string | undefined;
        if (channel instanceof ThreadChannel && channel.archived) {
          try {
            await channel.setArchived(false);
            note = "thread was archived; unarchived it to send";
          } catch {
            throw new Error(
              "Thread is archived and the bot lacks the Manage Threads permission to unarchive it. " +
                "Ask a human to unarchive the thread, or re-invite the bot with Manage Threads enabled.",
            );
          }
        }
        const content = withSender(sender ?? process.env.CLANKER_NAME, message);
        const sent = attachment
          ? await channel.send({ content, files: [attachment] })
          : await channel.send(content);
        return { sent: true, channel_id: id, message_id: sent.id, ...(note ? { note } : {}) };
      }),
  );

  server.registerTool(
    "read",
    {
      title: "Read clankerchat messages",
      description: [
        "Read recent messages from the team's Discord channel or thread.",
        "Poll with `after` set to the last_message_id you saw last time — that returns only",
        "newer messages, so repeated polls never duplicate. Messages come back oldest-first.",
      ].join(" "),
      inputSchema: {
        channel_id: z
          .string()
          .optional()
          .describe("Channel or thread ID. Defaults to CLANKER_THREAD_ID from .env."),
        thread_name: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Project thread name to read from (e.g. 'clankerchat'), resolved in the .env team channel.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to fetch (Discord caps at 100). Default 50."),
        after: z
          .string()
          .optional()
          .describe(
            "Only messages newer than this message ID (snowflake). Use the last_message_id from your previous read.",
          ),
      },
    },
    ({ channel_id, thread_name, limit, after }) =>
      guard(async () => {
        const channel = await resolveTargetChannel(channel_id, thread_name);
        const id = channel.id;
        const fetched = await channel.messages.fetch({
          limit: limit ?? 50,
          ...(after ? { after } : {}),
          cache: false,
        });
        const messages = [...fetched.values()].sort(byIdAscending).map(serializeMessage);
        const last = messages.at(-1);
        return {
          channel_id: id,
          count: messages.length,
          messages,
          last_message_id: last?.id ?? after ?? null,
          hint: "Poll again with after=this last_message_id to get only new messages.",
        };
      }),
  );

  server.registerTool(
    "create_thread",
    {
      title: "Create or find a project thread",
      description: [
        "Create a public thread in the team's channel — the convention is one thread per project/repo.",
        "Idempotent: if a thread with that name already exists (active or archived), it is returned",
        "(and unarchived) instead of creating a duplicate — safe when two agents race.",
        "Requires the bot to have Create Public Threads + Manage Threads permissions.",
      ].join(" "),
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Thread name — use the project slug (e.g. 'clankerchat', 'unified-sim-controller').",
          ),
        channel_id: z
          .string()
          .optional()
          .describe("Parent channel ID. Defaults to CLANKER_CHANNEL_ID from .env."),
        message: z
          .string()
          .optional()
          .describe("Optional opening message posted into the thread."),
      },
    },
    ({ name, channel_id, message }) =>
      guard(async () => {
        const parentId = resolveChannelId(channel_id, "CLANKER_CHANNEL_ID", "channel_id");
        const parent = await getChatChannel(parentId);
        if (parent instanceof ThreadChannel) {
          throw new Error(`${parentId} is a thread, not a text channel.`);
        }
        const existing = (await allThreads(parent)).find(
          (t) => t.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing) {
          if (existing.archived) {
            try {
              await existing.setArchived(false);
            } catch {
              throw new Error(
                `Thread "${name}" exists but is archived and the bot lacks Manage Threads to unarchive it. Ask a human to unarchive it.`,
              );
            }
          }
          return { thread_id: existing.id, name: existing.name, existed: true };
        }
        let created;
        try {
          created = await parent.threads.create({
            name,
            // 7 days — the longest Discord offers; minimizes auto-archive churn.
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          });
        } catch (err) {
          throw new Error(
            `Could not create thread "${name}": ${errText(err)}. ` +
              "The bot likely lacks the Create Public Threads permission — see SETUP.md Step 3 (re-invite with the full permissions URL).",
          );
        }
        if (message) {
          await created.send(withSender(process.env.CLANKER_NAME, message));
        }
        return { thread_id: created.id, name: created.name, existed: false };
      }),
  );

  server.registerTool(
    "list_channels",
    {
      title: "List Discord channels",
      description: [
        "List every Discord server this bot is in and its text channels, with IDs.",
        "Start here to bootstrap: find the team channel's ID, then call `list_threads` on it.",
      ].join(" "),
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const me = await awaitReady();
        return {
          bot: { username: me.user.username, id: me.user.id },
          guilds: me.guilds.cache.map((guild) => ({
            id: guild.id,
            name: guild.name,
            channels: guild.channels.cache
              .filter(
                (c) =>
                  c.type === ChannelType.GuildText ||
                  c.type === ChannelType.GuildAnnouncement,
              )
              .sort((a, b) => a.position - b.position)
              .map((c) => ({ id: c.id, name: c.name, type: "text" })),
          })),
        };
      }),
  );

  server.registerTool(
    "list_threads",
    {
      title: "List threads in a channel",
      description: [
        "List active and archived threads of a text channel, with IDs.",
        "The team chat usually lives in one thread — pick it once, put its ID in .env as",
        "CLANKER_THREAD_ID, and then `send`/`read` don't need channel_id anymore.",
      ].join(" "),
      inputSchema: {
        channel_id: z
          .string()
          .optional()
          .describe("Parent text channel ID. Defaults to CLANKER_CHANNEL_ID from .env."),
      },
    },
    ({ channel_id }) =>
      guard(async () => {
        const id = resolveChannelId(channel_id, "CLANKER_CHANNEL_ID", "channel_id");
        const channel = await getChatChannel(id);
        if (channel instanceof ThreadChannel) {
          throw new Error(
            `${id} is itself a thread (parent: ${channel.parentId}). Pass the parent text channel ID instead.`,
          );
        }
        const active = await channel.threads.fetchActive();
        const archived = await channel.threads.fetchArchived();
        const toThread = (t: ThreadChannel) => ({
          id: t.id,
          name: t.name,
          archived: t.archived,
          auto_archive_minutes: t.autoArchiveDuration,
          last_message_id: t.lastMessageId,
          parent_id: t.parentId,
        });
        const threads = [
          ...[...active.threads.values()].map(toThread),
          ...[...archived.threads.values()].map(toThread),
        ];
        return { channel_id: id, count: threads.length, threads };
      }),
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvFile();
  const token = process.env.DISCORD_TOKEN;

  const server = new McpServer({ name: "clankerchat", version: VERSION });
  registerTools(server);

  // Start Discord in the background — the MCP server itself always comes up
  // (so health checks and tools/list work), and tools surface configuration
  // and connection problems as clear errors pointing at SETUP.md.
  if (!token) {
    console.error(
      "clankerchat: DISCORD_TOKEN is not set. Copy .env.example to .env in the project root " +
        "and paste a bot token (see SETUP.md Step 2). Tools will return this error until then.",
    );
    rejectReady(
      new Error(
        "clankerchat is not configured: DISCORD_TOKEN is missing. Copy .env.example to .env in the project root and paste a bot token (SETUP.md Step 2).",
      ),
    );
  } else {
    void startDiscord(token);
  }

  await server.connect(new StdioServerTransport());
  console.error("clankerchat: MCP server ready on stdio");
}

process.on("unhandledRejection", (reason) => {
  console.error(`clankerchat: unhandled rejection: ${errText(reason)}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void client.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`clankerchat: fatal: ${errText(err)}`);
  process.exit(1);
});
