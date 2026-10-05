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
 *
 * Separately and independently of role: CLANKER_BLOCKED_IDS (comma list)
 * and/or CLANKER_BLOCKLIST_FILE (one snowflake per line, # comments, mtime-
 * cached re-read so the list extends without a restart) define an ABSOLUTE
 * quarantine — those channel/thread IDs fail closed on every tool (send,
 * read, create_thread, list_threads, and bot_inject/bot_file thread hints),
 * taking precedence over the project-mode allowlist. Both unset = upstream
 * behavior.
 */

import { REST, Routes, ChannelType } from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadEnvFile, PROJECT_ROOT } from "./env.js";
import { botlinkRequest, buildFileTransfer, resolveBotlinkPeerFromEnv, type BotlinkPeer } from "./botlink.js";
import { findLeakSignals, leakRefusal, findMassMentions, massMentionRefusal } from "./leaks.js";
import {
  newAskId,
  buildAskV2Components,
  askClockLine,
  ASK_V2_FLAG,
  createPendingAsk,
  lazyConsensusRefused,
  LAZY_CONSENSUS_REFUSAL,
} from "./asks.js";
import { listContext, readContext, searchContext } from "./context.js";

const MAX_MESSAGE_LENGTH = 2000; // Discord hard limit per message
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Discord access — REST ONLY, no gateway session (CLANKER SPEC A1): the
// daemon holds the machine's single gateway connection. Every MCP instance
// that logged a gateway session with the same token EVICTED the daemon's
// session, silently killing its triggers. Reading message text still needs
// the MESSAGE CONTENT INTENT portal toggle (SETUP.md Step 2) — REST honors
// it too.
// ---------------------------------------------------------------------------

const rest = new REST({ version: "10" });
let restTokenSet = false;

function api(): REST {
  if (!restTokenSet) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN is not set in .env (SETUP.md Step 2).");
    rest.setToken(token);
    restTokenSet = true;
  }
  return rest;
}

// Raw REST payloads, only the fields the tools use.
interface RAttachment { id?: string; filename?: string; name?: string; url?: string }
interface RMessage {
  id: string;
  timestamp: string;
  content: string;
  author: { username: string; id: string; bot?: boolean };
  attachments?: RAttachment[] | Map<string, RAttachment>;
}
interface RThread {
  id: string;
  name: string;
  type: number;
  parent_id?: string;
  thread_metadata?: { archived: boolean; auto_archive_duration?: number };
  archived?: boolean;
  last_message_id?: string | null;
}

function errTextOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sendMessage(channelId: string, payload: SendPayload): Promise<{ id: string }> {
  // ONE shared type (SendPayload) end-to-end: this seam used to duplicate the
  // payload shape inline, and every duplicated field is a place a new key
  // silently drops (allowed_mentions → their f624258; components → caught
  // before the first live ask 2026-10-04 — the ask would have posted with NO
  // buttons). The input side now can't drift; runtime forwarding below must
  // still name each field explicitly — that's the part live checks cover.
  const body = typeof payload === "string" ? { content: payload } : payload.content === undefined ? {} : { content: payload.content };
  const files = typeof payload === "string" || !payload.files
    ? undefined
    : payload.files.map((f) => ({ data: fs.readFileSync(f.attachment), name: f.name }));
  const ref = typeof payload === "string" || !payload.reply ? undefined : { message_id: payload.reply.messageReference };
  const components = typeof payload === "string" ? undefined : payload.components;
  const flags = typeof payload === "string" ? undefined : payload.flags;
  // allowed_mentions, if PRESENT without parse/users/roles, suppresses
  // EVERY mention in the message — Discord treats the object as the whole
  // allowlist. Replying must silence only the replied-to user (anti
  // ping-pong) while `<@id>` tags in the body still ping.
  // parse stays users-ONLY, stated on every path (2026-10-04 law: bot posts
  // never ping everyone-class or roles — a big role is functionally an
  // everyone-tag). Parsing suppresses the PING — but clients still RENDER
  // the raw text as a live tag, so the leaks.ts mass-mention tripwire at
  // the send/create_thread surfaces is the second, mandatory layer.
  const allowedMentions = ref
    ? { parse: ["users"], replied_user: false }
    : { parse: ["users"] };
  try {
    return (await api().post(Routes.channelMessages(channelId), {
      body: { ...body, message_reference: ref, allowed_mentions: allowedMentions, components, flags },
      files,
    })) as { id: string };
  } catch (err) {
    // failIfNotExists parity: a deleted reply target degrades to a plain send.
    // The fallback keeps the same explicit allowed_mentions AND components —
    // a degraded reply must not silently drop the ask's button row either.
    if (ref && /10008|Unknown Message/i.test(errTextOf(err))) {
      return (await api().post(Routes.channelMessages(channelId), {
        body: { ...body, allowed_mentions: allowedMentions, components, flags },
        files,
      })) as { id: string };
    }
    throw err;
  }
}

async function fetchMessages(channelId: string, o: { limit: number; after?: string }): Promise<RMessage[]> {
  // API returns newest-first; callers sort ascending.
  return (await api().get(Routes.channelMessages(channelId), {
    query: new URLSearchParams({ limit: String(o.limit), ...(o.after ? { after: o.after } : {}) }),
  })) as RMessage[];
}

function toThreadShim(raw: RThread): ThreadShim {
  return {
    ...raw,
    kind: "thread",
    archived: raw.thread_metadata?.archived ?? raw.archived ?? false,
    autoArchiveDuration: raw.thread_metadata?.auto_archive_duration,
    parentId: raw.parent_id,
    lastMessageId: raw.last_message_id,
    setArchived: (v: boolean) => api().patch(Routes.channel(raw.id), { body: { archived: v } }) as unknown as Promise<void>,
    send: (payload) => sendMessage(raw.id, payload),
    messages: { fetch: (o) => fetchMessages(raw.id, o) },
  };
}

/** Sendable payload across the channel/thread shims — one shape so every
 *  tool shares it. `components` carries the ask tool's button row; `flags`
 *  carries IS_COMPONENTS_V2 for the ask card, where content is DISABLED by
 *  the API — so content is optional and omitted, never sent empty. */
type SendPayload = string | {
  content?: string;
  files?: { attachment: string; name: string }[];
  reply?: { messageReference: string };
  components?: unknown[];
  flags?: number;
};

/** Minimal channel/thread interfaces the tool bodies rely on (shims for the
 *  old discord.js class instances — instanceof checks became kind checks). */
interface ThreadShim extends RThread {
  kind: "thread";
  parentId?: string;
  autoArchiveDuration?: number;
  archived: boolean;
  lastMessageId?: string | null;
  setArchived(v: boolean): Promise<void>;
  send(payload: SendPayload): Promise<{ id: string }>;
  messages: { fetch(o: { limit: number; after?: string }): Promise<RMessage[]> };
}
type ChatChannel = ThreadShim | ({
  kind: "channel";
  id: string;
  name?: string;
  type: number;
  send(payload: SendPayload): Promise<{ id: string }>;
  messages: { fetch(o: { limit: number; after?: string }): Promise<RMessage[]> };
  threads: {
    fetchActive(): Promise<{ threads: ThreadShim[] }>;
    fetchArchived(): Promise<{ threads: ThreadShim[] }>;
    create(o: { name: string; autoArchiveDuration?: number }): Promise<ThreadShim>;
  };
});

const THREAD_TYPES = [ChannelType.GuildPublicThread, ChannelType.GuildPrivateThread];
const isThread = (c: ChatChannel): c is ThreadShim => c.kind === "thread";

async function fetchChannelShim(channelId: string): Promise<ChatChannel> {
  const raw = (await api().get(Routes.channel(channelId))) as RThread & { position?: number };
  if (THREAD_TYPES.includes(raw.type as ChannelType)) return toThreadShim(raw);
  const ch: ChatChannel = {
    kind: "channel",
    id: raw.id,
    name: raw.name,
    type: raw.type,
    send: (payload) => sendMessage(channelId, payload),
    messages: { fetch: (o) => fetchMessages(channelId, o) },
    threads: {
      fetchActive: async () => {
        // Channel-level /threads/active was removed by Discord (404 for all) —
        // the live route is guild-level; filter to this channel's threads.
        const raw = (await api().get(Routes.channel(channelId))) as { guild_id?: string };
        const gid = raw.guild_id;
        if (!gid) throw new Error(`Channel ${channelId} has no guild (DM or deleted).`);
        const r = (await api().get(`/guilds/${gid}/threads/active`)) as { threads: RThread[] };
        return { threads: r.threads.filter((t) => t.parent_id === channelId).map(toThreadShim) };
      },
      fetchArchived: async () => {
        const r = (await api().get(`/channels/${channelId}/threads/archived/public`)) as { threads: RThread[] };
        return { threads: r.threads.map(toThreadShim) };
      },
      create: async (o) =>
        toThreadShim(
          (await api().post(`/channels/${channelId}/threads`, {
            body: {
              name: o.name,
              auto_archive_duration: o.autoArchiveDuration ?? 10080, // 7 days, the longest offered
              type: ChannelType.GuildPublicThread,
            },
          })) as RThread,
        ),
    },
  };
  return ch;
}

/** REST replacement for the old ClientReady identity lookup. */
async function getBotMe(): Promise<{ username: string; id: string }> {
  return (await api().get(Routes.user())) as { username: string; id: string };
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

// ---------------------------------------------------------------------------
// Blocked-ID quarantine — see header comment. Mode-independent absolute deny:
// unlike the project-mode locks above, this applies to EVERY instance
// (orchestrator included) and is checked before the allowlist, so a blocked
// ID never reaches Discord through any tool. The blocklist file mirrors the
// tag-watcher's forbiddenId(): mtime-cached, # comments, snowflakes only.
// ---------------------------------------------------------------------------

let blockedFileCache: { mtimeMs: number; ids: Set<string> } | null = null;

function blockedIds(): Set<string> {
  const ids = new Set(
    (process.env.CLANKER_BLOCKED_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const file = process.env.CLANKER_BLOCKLIST_FILE?.trim();
  if (file) {
    let cached = blockedFileCache;
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!cached || cached.mtimeMs !== mtimeMs) {
        cached = {
          mtimeMs,
          ids: new Set(
            fs
              .readFileSync(file, "utf8")
              .split("\n")
              .map((l) => l.replace(/#.*$/, "").trim())
              .filter((l) => /^\d{15,25}$/.test(l)),
          ),
        };
        blockedFileCache = cached;
      }
    } catch {
      /* unreadable/missing file → keep the last-known cache */
    }
    if (cached) for (const id of cached.ids) ids.add(id);
  }
  return ids;
}

/** Absolute quarantine: this channel/thread ID is never a valid target. */
function assertNotBlocked(channelId: string): void {
  if (blockedIds().has(channelId)) {
    throw new Error(
      `clankerchat: channel ${channelId} is blocked on this instance (CLANKER_BLOCKED_IDS / CLANKER_BLOCKLIST_FILE).`,
    );
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
  try {
    return await fetchChannelShim(channelId);
  } catch (err) {
    throw new Error(`Channel ${channelId} not accessible: ${errTextOf(err)}.`);
  }
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
async function allThreads(channel: Exclude<ChatChannel, ThreadShim>) {
  const [active, archived] = await Promise.all([
    channel.threads.fetchActive(),
    channel.threads.fetchArchived(),
  ]);
  return [...active.threads.values(), ...archived.threads.values()];
}

/** Finds a project thread by name in the .env channel — the human-friendly
 *  handle for the one-thread-per-project convention. */
async function findThreadByName(name: string): Promise<ThreadShim> {
  const channelId = process.env.CLANKER_CHANNEL_ID;
  if (!channelId) {
    throw new Error(
      "thread_name lookup needs CLANKER_CHANNEL_ID set in .env (SETUP.md Step 6).",
    );
  }
  const parent = await getChatChannel(channelId);
  if (isThread(parent)) {
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
    assertNotBlocked(channelId); // absolute quarantine, before any lock
    assertThreadAllowed(channelId); // fail fast, before any Discord fetch
    return getFetchedThreadAllowed(channelId);
  }
  if (threadName) {
    const thread = await findThreadByName(threadName);
    assertNotBlocked(thread.id);
    assertThreadAllowed(thread.id);
    return thread;
  }
  const id = resolveChannelId(undefined, "CLANKER_THREAD_ID", "channel_id or thread_name");
  assertNotBlocked(id);
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
  if (projectMode() && !isThread(channel)) {
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
  const composed = clean ? `**${clean}**: ${message}` : message;
  // Composed length (audit finding 10): the tool's raw-message check runs
  // BEFORE this prefix lands — a ~1995-char body with a long sender crossed
  // Discord's cap only after composition and died as a raw 400 instead of
  // the friendly split-it error. Single chokepoint: every send path composes
  // through here.
  if (composed.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Composed message is ${composed.length} chars (sender prefix included); Discord allows ${MAX_MESSAGE_LENGTH}. Shorten the message.`,
    );
  }
  return composed;
}

function serializeMessage(m: RMessage) {
  const match = SENDER_PREFIX.exec(m.content);
  return {
    id: m.id,
    timestamp: new Date(m.timestamp).toISOString(),
    author: { username: m.author.username, id: m.author.id, bot: m.author.bot },
    // sender = the identity the agent declared when sending (null for plain messages)
    sender: match ? match[1] : null,
    content: match ? m.content.slice(match[0].length) : m.content,
    attachments: (Array.isArray(m.attachments) ? m.attachments : [...(m.attachments as Map<string, RAttachment>).values()]).map((a) => ({
      filename: a.filename ?? a.name,
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
        reply_to: z
          .string()
          .regex(/^\d{16,20}$/, "Discord message ID (snowflake)")
          .optional()
          .describe(
            "Optional message ID in the SAME channel/thread to reply to — posts as a native Discord reply, keeping the answer visually attached to the question. Get the ID from `read` output.",
          ),
      },
    },
    ({ channel_id, thread_name, message, sender, file_path, reply_to }) =>
      guard(async () => {
        if (message.length > MAX_MESSAGE_LENGTH) {
          throw new Error(
            `Message is ${message.length} chars; Discord allows ${MAX_MESSAGE_LENGTH}. Split it into parts.`,
          );
        }
        // Outbound exfil tripwire (OWASP output monitoring): secret SHAPES
        // never leave through the post channel, no matter what the sending
        // session was talked into. Applies to the caption and the attachment.
        // The caption scan runs on the COMPOSED wire string (withSender'd,
        // below) — scanning raw `message` here would miss a shape smuggled in
        // the sender param. Composition order: attachments are scanned first
        // (cheap early exit), the composed scan runs after withSender.
        const captionLeaks = findLeakSignals(withSender(sender ?? process.env.CLANKER_NAME, message));
        if (captionLeaks.length > 0) throw new Error(leakRefusal(captionLeaks));
        let attachment: { attachment: string; name: string } | undefined;
        if (file_path) {
          attachment = resolveAttachment(file_path);
          try {
            // Scan the head of the attachment too — attaching IS sending.
            const fh = fs.openSync(attachment.attachment, "r");
            try {
              const buf = Buffer.alloc(64 * 1024);
              const n = fs.readSync(fh, buf, 0, buf.length, 0);
              const fileLeaks = findLeakSignals(buf.subarray(0, n).toString("utf8"));
              if (fileLeaks.length > 0) {
                throw new Error(leakRefusal(fileLeaks.map((k) => `${k} (in attachment)`)));
              }
            } finally {
              fs.closeSync(fh);
            }
          } catch (err) {
            if ((err as Error).message?.startsWith("REFUSED")) throw err;
            /* unreadable content (non-file? special file?) — the path jail already ran */
          }
        }
        const channel = await resolveTargetChannel(channel_id, thread_name);
        const id = channel.id;
        let note: string | undefined;
        if (isThread(channel) && channel.archived) {
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
        // Mass-mention law (owner 2026-10-04): @everyone/@here/role mentions
        // never ride out in bot posts — refusal, not neutralization, so the
        // composer rephrases instead of us shipping a mangled message.
        const massMentions = findMassMentions(content);
        if (massMentions.length > 0) throw new Error(massMentionRefusal());
        // Native reply (same channel only): keeps an answer attached to the
        // message it answers — the watcher also treats replies-to-our-messages
        // as explicit addressing, so threaded answers route cleanly.
        // failIfNotExists:false — a deleted/unknown target degrades to a
        // normal send instead of erroring the whole tool call.
        const reply = reply_to ? { messageReference: reply_to, failIfNotExists: false } : undefined;
        // Users-only mention parsing is enforced INSIDE sendMessage on every
        // path (the 2026-10-04 "tags aren't tagging" fix) — callers can't
        // widen or drop it, so no allowedMentions plumbing here.
        const sent = attachment
          ? await channel.send({ content, files: [attachment], ...(reply ? { reply } : {}) })
          : reply
            ? await channel.send({ content, reply })
            : await channel.send({ content });
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
        });
        const messages = [...fetched].sort(byIdAscending).map(serializeMessage);
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
        // Both outbound tripwires on the opening message BEFORE any API work
        // (2026-10-04 audit: this path had only the mass-mention scan — a
        // secret shape could ride out as a thread's opening message; and a
        // late refusal would have already paid for channel fetches or minted
        // an empty thread). Scan composed.
        const opening = message ? withSender(process.env.CLANKER_NAME, message) : null;
        if (opening !== null) {
          const threadLeaks = findLeakSignals(opening);
          if (threadLeaks.length > 0) throw new Error(leakRefusal(threadLeaks));
          const massMentions = findMassMentions(opening);
          if (massMentions.length > 0) throw new Error(massMentionRefusal());
        }
        const parentId = resolveChannelId(channel_id, "CLANKER_CHANNEL_ID", "channel_id");
        assertNotBlocked(parentId);
        const parent = await getChatChannel(parentId);
        if (isThread(parent)) {
          throw new Error(`${parentId} is a thread, not a text channel.`);
        }
        const existing = (await allThreads(parent)).find(
          (t) => t.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing) {
          assertNotBlocked(existing.id); // a quarantined thread is never "found"
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
            autoArchiveDuration: 10080, // 7 days — the longest Discord offers
          });
        } catch (err) {
          throw new Error(
            `Could not create thread "${name}": ${errText(err)}. ` +
              "The bot likely lacks the Create Public Threads permission — see SETUP.md Step 3 (re-invite with the full permissions URL).",
          );
        }
        if (opening !== null) {
          // sendMessage pins users-only parsing itself — nothing to pass here.
          await created.send({ content: opening });
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
        const me = await getBotMe();
        const guilds = (await api().get("/users/@me/guilds")) as { id: string; name: string }[];
        return {
          bot: me,
          guilds: await Promise.all(
            guilds.map(async (g) => {
              const channels = (await api().get(Routes.guildChannels(g.id))) as { id: string; name: string; type: number; position?: number }[];
              return {
                id: g.id,
                name: g.name,
                channels: channels
                  .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
                  .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                  .map((c) => ({ id: c.id, name: c.name, type: "text" })),
              };
            }),
          ),
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
        assertNotBlocked(id);
        const channel = await getChatChannel(id);
        if (isThread(channel)) {
          throw new Error(
            `${id} is itself a thread (parent: ${channel.parentId}). Pass the parent text channel ID instead.`,
          );
        }
        const active = await channel.threads.fetchActive();
        const archived = await channel.threads.fetchArchived();
        const toThread = (t: ThreadShim) => ({
          id: t.id,
          name: t.name,
          archived: t.archived,
          auto_archive_minutes: t.autoArchiveDuration,
          last_message_id: t.lastMessageId,
          parent_id: t.parentId,
        });
        const threads = [...active.threads.map(toThread), ...archived.threads.map(toThread)];
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

  // Rotation-ready client resolution (owner 2026-10-04: "confirm and it
  // keeps going" — a phone-confirmed rotation must reach RUNNING MCP
  // servers without a session restart). The pin + private key are read
  // from disk PER VERB, never cached at process start; pin precedence is
  // ceremony-file-over-env (see resolveBotlinkPeerFromEnv in botlink.ts).
  const resolveBotlinkPeer = (): BotlinkPeer | null =>
    resolveBotlinkPeerFromEnv(process.env, PROJECT_ROOT);
  const botlinkDisabled = (): { msg: string; peer: BotlinkPeer | null } => {
    const peer = resolveBotlinkPeer();
    if (!peer) {
      return {
        msg:
          "botlink is not configured on this instance. Set CLANKER_BOTLINK_PEER, " +
          "CLANKER_BOTLINK_KEY and CLANKER_BOTLINK_PEER_HOSTKEY (see BOTLINK.md).",
        peer: null,
      };
    }
    return { msg: "", peer };
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
        const { msg, peer } = botlinkDisabled();
        if (!peer) throw new Error(msg);
        const out = await botlinkRequest(peer, "status");
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
        const { msg: injectDisabled, peer } = botlinkDisabled();
        if (!peer) throw new Error(injectDisabled);
        // Quarantine applies to lane traffic too: never name a blocked venue,
        // even as a reply-thread hint for the peer.
        if (thread) assertNotBlocked(thread);
        // Outbound exfil tripwire, lane edition: injects are the machine-to-
        // machine channel — same rule as send, secret shapes never ride it.
        const injectLeaks = findLeakSignals(text);
        if (injectLeaks.length > 0) throw new Error(leakRefusal(injectLeaks));
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
        const out = await botlinkRequest(peer, "inject", {
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

  server.registerTool(
    "bot_file",
    {
      title: "Send a file to the peer machine over botlink",
      description: [
        "Transfer one file (≤2 MB) to the peer machine over the private SSH",
        "lane — files cross machines HERE, never as Discord attachments.",
        "The file lands in the peer's spool under a receiver-controlled path",
        "with size+sha256 verification, and is surfaced to their trigger layer",
        "as untrusted input with its hash. Leak-shape scanned on both ends.",
        "Same trust level as bot_inject; use it when a peer genuinely needs a",
        "file that git doesn't already carry.",
      ].join(" "),
      inputSchema: {
        file_path: z.string().min(1).describe("Path of the local file to send (jailed to CLANKER_FILE_ROOT in project mode)."),
        target: z.string().min(1).max(64).describe("Routing hint on the peer, e.g. 'orchestrator'."),
        note: z.string().max(400).optional().describe("One line: what this file is / why the peer needs it."),
        thread: z.string().max(64).optional().describe("Discord thread name/id hint for the peer's human log."),
      },
    },
    ({ file_path, target, note, thread }) =>
      guard(async () => {
        const { msg: fileDisabled, peer } = botlinkDisabled();
        if (!peer) throw new Error(fileDisabled);
        if (thread) assertNotBlocked(thread); // quarantined venues, lane edition
        // Same jail as send attachments: project-mode instances can only
        // ship files from inside their own root ("none" disables entirely).
        const { attachment } = resolveAttachment(file_path);
        const bytes = fs.readFileSync(attachment);
        const source = process.env.CLANKER_BOTLINK_NAME ?? process.env.CLANKER_NAME ?? "clankerchat";
        const built = buildFileTransfer({
          source,
          target,
          name: path.basename(attachment),
          bytes,
          ...(note ? { note } : {}),
          ...(thread ? { thread } : {}),
        });
        if ("error" in built) throw new Error(built.error);
        const out = await botlinkRequest(peer, "inject", built.payload);
        try {
          return JSON.parse(out);
        } catch {
          return { raw: out };
        }
      }),
  );

  // -------------------------------------------------------------------------
  // ask — interactive approve/deny (owner 2026-10-04)
  // -------------------------------------------------------------------------
  const ASK_SPOOL = process.env.CLANKER_BOTLINK_SPOOL ?? path.join(PROJECT_ROOT, "botlink-spool");

  server.registerTool(
    "ask",
    {
      title: "Post an approve/deny ask with buttons",
      description: [
        "Post a question to the team channel/thread with Approve/Deny buttons under it.",
        "Only the listed approver user IDs can click (validated by the gateway at click",
        "time against the API identity — never by anything written in the message).",
        "The decision is recorded and delivered to the machine's trigger layer as a",
        "human-priority run; the ask expires after 1h with buttons disabled. Use this",
        "whenever a human go/no-go gates the next step.",
      ].join(" "),
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(1500)
          .describe("The ask, self-contained: what exactly is being approved/denied and what happens on each answer."),
        approvers: z
          .array(z.string().regex(/^\d{15,25}$/, "Discord user ID (snowflake)"))
          .min(1)
          .max(10)
          .optional()
          .describe(
            "User IDs allowed to click. Defaults to CLANKER_ASK_APPROVERS from the launch env (comma-separated).",
          ),
        expires_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe(
            "Ask lifetime in minutes (default 60). At expiry the ask resolves: buttons disable, and per on_expiry it either expires (no decision) or auto-approves.",
          ),
        on_expiry: z
          .enum(["expire", "approve"])
          .optional()
          .describe(
            "expire (DEFAULT, fail-closed): unanswered = expired, never approval. approve (lazy consensus): unanswered = approved — the message says so up front and any Deny before expiry still wins. Use approve ONLY for asks where silence genuinely means yes; gates and secret-class asks never. Some machines revoke approve entirely (the refusal says so) — on refusal, re-ask without it (fail-closed).",
          ),
        channel_id: z.string().optional().describe("Channel or thread ID (snowflake). Defaults like `send`."),
        thread_name: z.string().min(1).optional().describe("Thread name to resolve, like `send`."),
        sender: z.string().min(1).optional().describe("Signing identity, like `send`."),
      },
    },
    ({ message, approvers, expires_minutes, on_expiry, channel_id, thread_name, sender }) =>
      guard(async () => {
        const approverList = (
          approvers ??
          (process.env.CLANKER_ASK_APPROVERS ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        ).slice(0, 10);
        if (approverList.length === 0) {
          throw new Error(
            "ask: no approvers — pass `approvers` or set CLANKER_ASK_APPROVERS. An ask nobody may click is not an ask.",
          );
        }
        const ttlMin = expires_minutes ?? 60;
        const lazy = on_expiry === "approve";
        // Owner law 2026-10-04: refuse BEFORE any side effect — the card must
        // never post if its registry entry cannot be minted (chokepoint also
        // refuses, for every non-MCP minting surface).
        if (lazyConsensusRefused(on_expiry)) throw new Error(LAZY_CONSENSUS_REFUSAL);
        // Lazy consensus must be legible ON the ask itself: a human skimming
        // the thread has to know silence consents without reading any docs.
        const askText = lazy
          ? `${message}\n\n⏱ auto-approves in ${ttlMin}m unless denied — silence counts as yes.`
          : message;
        // Same outbound tripwires as send: secret shapes never ride out, and
        // the mass-mention law is absolute regardless of surface.
        const content = withSender(sender ?? process.env.CLANKER_NAME, askText);
        const askLeaks = findLeakSignals(content);
        if (askLeaks.length > 0) throw new Error(leakRefusal(askLeaks));
        if (findMassMentions(content).length > 0) throw new Error(massMentionRefusal());
        const channel = await resolveTargetChannel(channel_id, thread_name);
        const askId = newAskId();
        // Components V2 card (content is DISABLED under this flag): question +
        // sender prefix + lazy note ride as the id-1 TextDisplay (the composed
        // `content` string verbatim — same tripwires already ran on it), the
        // fuse as the id-2 clock slot, buttons as the id-3 row. custom_ids are
        // the same contract as the legacy row, so clicks never know the shape.
        const clockLine = askClockLine({ status: "pending", expiresAt: Date.now() + ttlMin * 60_000 });
        const sent = await channel.send({
          flags: ASK_V2_FLAG,
          components: buildAskV2Components(askId, content, { clockLine: clockLine ?? `${ttlMin}m` }),
        });
        const rec = createPendingAsk(ASK_SPOOL, {
          askId, // the id baked into the buttons' custom_ids — one mint, or
          // every click misses the registry ("ask not found"). Live probe
          // caught the two-mint version 2026-10-04; tests saw only halves.
          question: message,
          channelId: channel.id,
          messageId: sent.id,
          approvers: approverList,
          ttlMs: ttlMin * 60_000,
          ...(lazy ? { onExpiry: "approve" as const } : {}),
        });
        return {
          asked: true,
          ask_id: rec.askId,
          channel_id: channel.id,
          message_id: sent.id,
          approvers: approverList.length,
          on_expiry: lazy ? "approve" : "expire",
          expires_at: new Date(rec.expiresAt).toISOString(),
        };
      }),
  );

  // -------------------------------------------------------------------------
  // edit / react / delete — quiet-posture surface tools (owner 2026-10-04:
  // "make the discord mcp part of you so it works even better"). All three
  // operate on THIS BOT'S OWN posts only (enforced by fetch-then-act, not by
  // caller claims) and ride the same locks as send.
  // -------------------------------------------------------------------------

  /** Fetch one message, refusing unless it is this bot's own post. */
  async function getOwnMessage(channelId: string, messageId: string, verb: string) {
    const me = await getBotMe();
    const msg = (await api().get(Routes.channelMessage(channelId, messageId))) as {
      id: string;
      author?: { id?: string };
    };
    if (msg?.author?.id !== me.id) {
      throw new Error(`${verb}: message ${messageId} is not this bot's own post — refusing (own posts only).`);
    }
    return msg;
  }

  server.registerTool(
    "edit",
    {
      title: "Edit one of this bot's own messages",
      description: [
        "Edit a message THIS bot previously sent (own posts only, enforced server-side).",
        "Content-only PATCH: buttons/components on the message are left untouched, and the",
        "same outbound tripwires as send apply to the new text. Prefer editing a progress",
        "post over sending a new one — one post, updated in place, is the noise law.",
      ].join(" "),
      inputSchema: {
        message_id: z.string().regex(/^\d{16,20}$/, "Discord message ID (snowflake)").describe("The bot's own message to edit (from send/read/ask results)."),
        message: z.string().min(1).max(2000).describe("The new content (replaces the old text; Discord markdown allowed)."),
        channel_id: z.string().optional().describe("Channel or thread ID. Defaults like `send`."),
        thread_name: z.string().min(1).optional().describe("Thread name to resolve, like `send`."),
        sender: z.string().min(1).optional().describe("Re-sign the edit with this sender identity, like `send`."),
      },
    },
    ({ message_id, message, channel_id, thread_name, sender }) =>
      guard(async () => {
        const channel = await resolveTargetChannel(channel_id, thread_name);
        await getOwnMessage(channel.id, message_id, "edit");
        const content = withSender(sender ?? process.env.CLANKER_NAME, message);
        const editLeaks = findLeakSignals(content);
        if (editLeaks.length > 0) throw new Error(leakRefusal(editLeaks));
        if (findMassMentions(content).length > 0) throw new Error(massMentionRefusal());
        // components deliberately omitted — PATCH leaves existing buttons in
        // place, so an ask's buttons survive a content edit.
        await api().patch(Routes.channelMessage(channel.id, message_id), {
          body: { content, allowed_mentions: { parse: ["users"] } },
        });
        return { edited: true, message_id };
      }),
  );

  const REACT_EMOJI = ["✅", "👀", "👍", "❌", "⚠️", "🔥", "🛑", "🧠", "⏳", "🎯"] as const;

  server.registerTool(
    "react",
    {
      title: "React to a message (emoji receipt)",
      description: [
        "Add this bot's reaction to a message — a zero-ping, one-emoji receipt. Use ✅ to",
        "mark a trigger handled or a task done INSTEAD of posting an ack (typing indicator",
        "is liveness; the checkmark is the outcome). Emoji is limited to a fixed set so a",
        "compromised session can't use reactions as a covert channel.",
      ].join(" "),
      inputSchema: {
        message_id: z.string().regex(/^\d{16,20}$/, "Discord message ID (snowflake)").describe("The message to react to (any author — reacting is public, not a write to it)."),
        emoji: z.enum(REACT_EMOJI).describe(`Receipt emoji, one of: ${REACT_EMOJI.join(" ")}`),
        channel_id: z.string().optional().describe("Channel or thread ID. Defaults like `send`."),
        thread_name: z.string().min(1).optional().describe("Thread name to resolve, like `send`."),
      },
    },
    ({ message_id, emoji, channel_id, thread_name }) =>
      guard(async () => {
        const channel = await resolveTargetChannel(channel_id, thread_name);
        // Unicode emoji must ride the URL percent-encoded; the route builder
        // interpolates raw, so encode here (Unknown Emoji otherwise).
        // channelMessageOwnReaction = the /@me form (add MY reaction).
        await api().put(
          Routes.channelMessageOwnReaction(channel.id, message_id, encodeURIComponent(emoji)),
        );
        return { reacted: true, emoji, message_id };
      }),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete one of this bot's own messages",
      description: [
        "Delete a message THIS bot previously sent (own posts only, enforced server-side;",
        "bots may always delete their own). Cleanup tool: retire a mistaken or stale post",
        "instead of leaving wrong text standing. The thread still shows a tombstone.",
      ].join(" "),
      inputSchema: {
        message_id: z.string().regex(/^\d{16,20}$/, "Discord message ID (snowflake)").describe("The bot's own message to delete."),
        channel_id: z.string().optional().describe("Channel or thread ID. Defaults like `send`."),
        thread_name: z.string().min(1).optional().describe("Thread name to resolve, like `send`."),
      },
    },
    ({ message_id, channel_id, thread_name }) =>
      guard(async () => {
        const channel = await resolveTargetChannel(channel_id, thread_name);
        await getOwnMessage(channel.id, message_id, "delete");
        await api().delete(Routes.channelMessage(channel.id, message_id));
        return { deleted: true, message_id };
      }),
  );

  // -------------------------------------------------------------------------
  // openwolf — shared portable context store (owner-asked 2026-10-04; gate
  // APPROVED by Joe same day). Read-only by design: files change by reviewed
  // commits, so executing sessions cannot poison shared memory. Safety LAWS
  // never live here (always-loaded in CLAUDE.md); this is routing tables and
  // reference detail. See docs/context/ and openwolf-context-server-design.md.
  // -------------------------------------------------------------------------
  const CONTEXT_BASE = process.env.CLANKER_CONTEXT_DIR ?? PROJECT_ROOT;

  server.registerTool(
    "context_list",
    {
      title: "List shared context topics",
      description: [
        "List the shared cross-machine context topics (docs/context/ in the repo,",
        "git-synced). Returns slug + title + tags + updated — a few hundred bytes.",
        "Fetch the one you need with context_read. Safety laws are NOT here;",
        "they stay in CLAUDE.md.",
      ].join(" "),
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const entries = listContext(CONTEXT_BASE);
        return {
          count: entries.length,
          topics: entries,
          hint: "context_read <topic> for one file; context_search <query> for line hits.",
        };
      }),
  );

  server.registerTool(
    "context_read",
    {
      title: "Read one shared context topic",
      description: [
        "Return exactly one topic file from docs/context/ (front-matter parsed,",
        "body verbatim). Topic = the slug from context_list. This is shared",
        "reference detail both machines keep identical — not a place for",
        "machine-local state.",
      ].join(" "),
      inputSchema: {
        topic: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "topic slug")
          .describe("Topic slug from context_list (e.g. 'mention-mechanics')."),
      },
    },
    ({ topic }) =>
      guard(async () => {
        const doc = readContext(CONTEXT_BASE, topic);
        if (!doc) {
          const have = listContext(CONTEXT_BASE).map((e) => e.topic).join(", ") || "(none)";
          throw new Error(`context: no topic "${topic}". Available: ${have}.`);
        }
        return doc;
      }),
  );

  server.registerTool(
    "context_search",
    {
      title: "Search shared context topics",
      description: [
        "Case-insensitive line search across docs/context/ — filename + line",
        "number + matched line, capped at 20 hits. Grep, not a search engine:",
        "if you need semantic recall, list and read instead.",
      ].join(" "),
      inputSchema: {
        query: z.string().min(2).max(200).describe("Substring to find (2+ chars)."),
      },
    },
    ({ query }) =>
      guard(async () => {
        const hits = searchContext(CONTEXT_BASE, query);
        return { query, count: hits.length, hits, ...(hits.length === 0 ? { hint: "No hits — context_list to browse titles/tags." } : {}) };
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
  const HARDENING_KEYS = [
    "CLANKER_ROLE",
    "CLANKER_ALLOWED_THREADS",
    "CLANKER_FILE_ROOT",
    "CLANKER_BLOCKED_IDS",
    "CLANKER_BLOCKLIST_FILE",
  ];
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

  // REST-only: no gateway, no login handshake. The MCP server always comes
  // up (health checks and tools/list work); tools surface configuration and
  // connection problems as clear errors pointing at SETUP.md.
  if (!token) {
    console.error(
      "clankerchat: DISCORD_TOKEN is not set. Copy .env.example to .env in the project root " +
        "and paste a bot token (see SETUP.md Step 2). Tools will return this error until then.",
    );
  }

  await server.connect(new StdioServerTransport());
  console.error("clankerchat: MCP server ready on stdio (REST-only, no gateway)");
}

process.on("unhandledRejection", (reason) => {
  console.error(`clankerchat: unhandled rejection: ${errText(reason)}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

main().catch((err) => {
  console.error(`clankerchat: fatal: ${errText(err)}`);
  process.exit(1);
});
