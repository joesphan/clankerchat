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
 *
 * Hardening (tyler-hardening branch): an instance runs LOCKED when
 * CLANKER_ROLE=project. In that mode send/read accept only the thread IDs in
 * CLANKER_ALLOWED_THREADS (which must resolve to THREADS — a plain channel
 * ID in the allowlist fails closed), `file_path` attachments must resolve
 * (realpath, symlink-proof) inside CLANKER_FILE_ROOT ("none" disables
 * attachments), and list_channels / list_threads / create_thread are
 * refused. Unset role =
 * upstream behavior, used by the orchestrator/bootstrap instance. Locks are
 * read lazily from the real environment (per-instance `--env` flags), not
 * .env (main() actively undoes any hardening values loadEnvFile injected),
 * so a shared checkout can serve locked and unlocked instances at once.
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
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { botlinkRequest, type BotlinkPeer } from "./botlink.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const MAX_MESSAGE_LENGTH = 2000; // Discord hard limit per message
const READY_TIMEOUT_MS = 20_000;
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// .env — loaded from the project root so the token never has to live in the
// MCP client config. Existing environment variables win over .env values.
// ---------------------------------------------------------------------------

function loadEnvFile(): void {
  const envPath = path.join(PROJECT_ROOT, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env file — env vars may still provide config
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined || process.env[match[1]] === "") {
      process.env[match[1]] = value;
    }
  }
}

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
// Hardening locks — see header comment. Env is read lazily so per-instance
// `--env` overrides apply regardless of when .env loading happens.
// ---------------------------------------------------------------------------

function projectMode(): boolean {
  return process.env.CLANKER_ROLE?.trim().toLowerCase() === "project";
}

function allowedThreadIds(): string[] {
  return (process.env.CLANKER_ALLOWED_THREADS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Project mode: only the pinned thread(s) may be sent to / read from. */
function assertThreadAllowed(channelId: string): void {
  if (!projectMode()) return;
  const allowed = allowedThreadIds();
  if (allowed.length === 0) {
    throw new Error(
      "clankerchat is locked (CLANKER_ROLE=project) but CLANKER_ALLOWED_THREADS is empty — refusing every target.",
    );
  }
  if (!allowed.includes(channelId)) {
    throw new Error(
      `clankerchat is locked to thread(s) ${allowed.join(", ")} — channel ${channelId} is not permitted on this instance.`,
    );
  }
}

/** Project mode: refuse the discovery/creation tools outright. */
function assertNotProjectMode(tool: string): void {
  if (projectMode()) {
    throw new Error(`${tool} is disabled on this clankerchat instance (CLANKER_ROLE=project).`);
  }
}

/**
 * Project mode: attachments must realpath inside CLANKER_FILE_ROOT ("none" =
 * attachments disabled). Returns the realpath to attach. Unlocked instances
 * keep the upstream behavior (any readable file).
 */
function resolveAttachment(file_path: string): { attachment: string; name: string } {
  if (!projectMode()) {
    const abs = path.resolve(file_path);
    if (!fs.existsSync(abs)) {
      throw new Error(`File not found: ${abs}`);
    }
    return { attachment: abs, name: path.basename(abs) };
  }
  const root = (process.env.CLANKER_FILE_ROOT ?? "").trim();
  if (!root || root.toLowerCase() === "none") {
    throw new Error("Attachments are disabled on this clankerchat instance.");
  }
  const rootReal = fs.realpathSync(root); // throws if the root itself is bogus
  const abs = path.resolve(file_path);
  let real: string;
  try {
    real = fs.realpathSync(abs); // follows symlinks — closes ../ and link escapes
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(
      `Attachments must live inside ${rootReal} on this instance (resolved: ${real}).`,
    );
  }
  return { attachment: real, name: path.basename(real) };
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
 * CLANKER_THREAD_ID default. Locked instances (CLANKER_ROLE=project) are
 * checked here — the single funnel — and explicit channel IDs are rejected
 * before any Discord call is made.
 */
async function resolveTargetChannel(
  channelId: string | undefined,
  threadName: string | undefined,
): Promise<ChatChannel> {
  if (channelId) {
    assertThreadAllowed(channelId); // fail fast, before any Discord fetch
    return getFetchedThreadAllowed(channelId);
  }
  if (threadName) {
    const thread = await findThreadByName(threadName);
    assertThreadAllowed(thread.id);
    return thread;
  }
  const id = resolveChannelId(undefined, "CLANKER_THREAD_ID", "channel_id or thread_name");
  assertThreadAllowed(id);
  return getFetchedThreadAllowed(id);
}

/**
 * Allowlist membership alone is not enough: the allowlist promises
 * thread-only access, but getChatChannel() also accepts plain channels.
 * If a non-thread channel ID lands in CLANKER_ALLOWED_THREADS, fail
 * closed instead of enabling channel-level send/read.
 */
async function getFetchedThreadAllowed(channelId: string): Promise<ChatChannel> {
  const channel = await getChatChannel(channelId);
  if (projectMode() && !(channel instanceof ThreadChannel)) {
    throw new Error(
      `clankerchat project mode permits threads only, but ${channelId} resolved to a ` +
        `non-thread channel (${ChannelType[channel.type] ?? String(channel.type)}) — refusing. ` +
        "Remove it from CLANKER_ALLOWED_THREADS.",
    );
  }
  return channel;
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
          attachment = resolveAttachment(file_path);
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
        assertNotProjectMode("create_thread");
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
        assertNotProjectMode("list_channels");
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
        assertNotProjectMode("list_threads");
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

  // -------------------------------------------------------------------------
  // botlink — the SSH machine lane (peer bot's daemon, NOT Discord).
  // Configured only when CLANKER_BOTLINK_PEER is set; unconfigured instances
  // get a clear error instead of a silent capability. Works in project mode
  // too: an inject is a PROMPT (same trust level as a Discord tag), and the
  // receiving machine applies its own untrusted-input scrutiny.
  // -------------------------------------------------------------------------

  const botlinkPeer = (() => {
    const peer = process.env.CLANKER_BOTLINK_PEER; // host[:port]
    const keyPath = process.env.CLANKER_BOTLINK_KEY; // this bot's private key
    const hostKey = process.env.CLANKER_BOTLINK_PEER_HOSTKEY; // pinned fingerprint/line
    if (!peer || !keyPath || !hostKey) return null;
    const [host, portStr] = peer.split(":");
    return {
      host,
      port: portStr ? Number(portStr) : undefined,
      username: process.env.CLANKER_BOTLINK_USER,
      privateKeyPem: fs.readFileSync(path.resolve(keyPath), "utf8"),
      expectedHostKey: hostKey,
    } satisfies BotlinkPeer;
  })();
  const botlinkDisabled = (): string | null => {
    if (!botlinkPeer) {
      return (
        "botlink is not configured on this instance. Set CLANKER_BOTLINK_PEER, " +
        "CLANKER_BOTLINK_KEY and CLANKER_BOTLINK_PEER_HOSTKEY (see BOTLINK.md)."
      );
    }
    return null;
  };

  server.registerTool(
    "bot_status",
    {
      title: "Check peer machine's bot status over botlink",
      description: [
        "Ask the peer machine's botlink daemon for a health snapshot (uptime,",
        "inject count, spool depth). Private SSH lane — nothing goes to Discord.",
        "Use this before injecting, and for keepalive/cross-machine health checks.",
      ].join(" "),
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const disabled = botlinkDisabled();
        if (disabled) throw new Error(disabled);
        const out = await botlinkRequest(botlinkPeer!, "status");
        try {
          return JSON.parse(out);
        } catch {
          return { raw: out };
        }
      }),
  );

  server.registerTool(
    "bot_inject",
    {
      title: "Inject a prompt into the peer machine over botlink",
      description: [
        "Deliver a prompt to the peer machine's trigger layer over the private",
        "SSH lane (NOT Discord — Discord stays the human-readable log). The peer",
        "treats your text as UNTRUSTED INPUT with elevated scrutiny, exactly like",
        "a bot-authored Discord tag. `target` routes it (e.g. 'orchestrator', or a",
        "session/thread name the peer recognizes); `thread` optionally names the",
        "Discord thread the peer should answer in for human visibility.",
      ].join(" "),
      inputSchema: {
        target: z.string().min(1).max(64).describe("Routing hint on the peer, e.g. 'orchestrator' or 'shim'."),
        text: z.string().min(1).max(4000).describe("The prompt text (untrusted input on the peer — keep it self-contained)."),
        thread: z.string().max(64).optional().describe("Discord thread name/id the peer should answer in (human visibility)."),
        task_kind: z.enum(["implement", "review", "question", "status"]).optional().describe("Structured task: what the receiver should do."),
        task_repo: z.string().max(200).optional().describe("Structured task: repo name on the receiving side (hint)."),
        task_branch: z.string().max(200).optional().describe("Structured task: branch to build/review."),
        task_base: z.string().max(200).optional().describe("Structured task: base ref for diffs."),
        task_commit: z.string().max(40).optional().describe("Structured task: specific commit under review."),
        task_diff_ref: z.string().max(400).optional().describe("Structured task: PR/commit ref (TEXT hint — nothing fetches it)."),
        task_acceptance: z.array(z.string().min(1).max(400)).max(10).optional().describe("Structured task: pass criteria."),
        task_reply_to: z.string().max(64).optional().describe("Structured task: inject/message id to thread replies to."),
        task_correlation: z.string().max(64).optional().describe("Structured task: grouping id shared by related injects of one task round."),
        task_deadline_soft: z.string().max(40).optional().describe("Structured task: soft deadline (duration or timestamp hint)."),
        supersedes: z.string().max(64).optional().describe("Lineage: inject id this one replaces (same logical prompt, refined)."),
      },
    },
    ({ target, text, thread, task_kind, task_repo, task_branch, task_base, task_commit, task_diff_ref, task_acceptance, task_reply_to, task_correlation, task_deadline_soft, supersedes }) =>
      guard(async () => {
        const disabled = botlinkDisabled();
        if (disabled) throw new Error(disabled);
        const source = process.env.CLANKER_BOTLINK_NAME ?? process.env.CLANKER_NAME ?? "clankerchat";
        const task = task_kind
          ? {
              kind: task_kind,
              ...(task_repo ? { repo: task_repo } : {}),
              ...(task_branch ? { branch: task_branch } : {}),
              ...(task_base ? { base: task_base } : {}),
              ...(task_commit ? { commit: task_commit } : {}),
              ...(task_diff_ref ? { diff_ref: task_diff_ref } : {}),
              ...(task_acceptance ? { acceptance: task_acceptance } : {}),
              ...(task_reply_to ? { reply_to: task_reply_to } : {}),
              ...(task_correlation ? { correlation: task_correlation } : {}),
              ...(task_deadline_soft ? { deadline_soft: task_deadline_soft } : {}),
            }
          : undefined;
        const out = await botlinkRequest(botlinkPeer!, "inject", {
          source,
          target,
          text,
          ...(thread ? { thread } : {}),
          ...(supersedes ? { supersedes } : {}),
          ...(task ? { task } : {}),
        });
        try {
          return JSON.parse(out);
        } catch {
          return { raw: out };
        }
      }),
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Hardening keys must come from the LAUNCH environment (per-instance
  // `--env`), never the shared .env: loadEnvFile() fills undefined/empty
  // vars from .env, so a shared CLANKER_ROLE=project would silently lock
  // every instance on the machine — including the orchestrator. Snapshot
  // which keys the launch env actually defined, load .env, then undo any
  // hardening values the loader injected.
  const HARDENING_KEYS = ["CLANKER_ROLE", "CLANKER_ALLOWED_THREADS", "CLANKER_FILE_ROOT"];
  const launchDefined = new Set(
    HARDENING_KEYS.filter((k) => process.env[k] !== undefined && process.env[k] !== ""),
  );
  loadEnvFile();
  for (const k of HARDENING_KEYS) {
    if (!launchDefined.has(k)) delete process.env[k];
  }
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
