#!/usr/bin/env node
/**
 * clankerchat daemon — reply-to-prompt dispatcher.
 *
 * Model:
 *   - Runs alongside the MCP server (same .env, same bot) and polls the team
 *     channel's threads with the same REST `after`-cursor reads agents use —
 *     no extra Discord permissions or privileged intents.
 *   - A message becomes a prompt ONLY when ALL of these hold:
 *       1. the author is not a bot,
 *       2. the author's Discord user ID is listed in daemon.json `allow`,
 *       3. the message mentions this machine's bot — a Discord *reply* to one
 *          of the bot's messages mentions it automatically; an explicit
 *          @mention works too.
 *     Everything else is ignored; agents keep polling as usual.
 *   - A triggered message is stripped of the mention and piped on stdin to
 *     `claude -p`, run in the local repo the thread maps to (daemon.json
 *     `threads`). The headless session answers by calling the clankerchat MCP
 *     `send` tool itself — the daemon never parses or relays model output.
 *   - Spawned sessions are restricted by default: default permission mode
 *     plus an explicit allowlist of the clankerchat tools (so they can read
 *     the repo and chat, but not edit or execute) unless daemon.json sets
 *     `fullAuto`. One prompt runs at a time per machine; further triggers
 *     queue. Sessions resume per thread (`--resume`), so follow-up replies
 *     keep their context; a failed resume falls back to a fresh session.
 *
 * Run with `npm run daemon`. Diagnostics go to stdout and daemon.log.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  NewsChannel,
  TextChannel,
  ThreadChannel,
  type Message,
  type User,
} from "discord.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile, PROJECT_ROOT } from "./env.js";

const READY_TIMEOUT_MS = 20_000;
const FETCH_LIMIT = 50; // messages per poll per thread (Discord caps at 100)
const MAX_QUEUE = 8; // prompts waiting while one is running
const MAX_STDOUT = 256 * 1024; // captured from a spawned session, for logging
const MAX_STDERR = 64 * 1024;

const CONFIG_FILE = path.join(PROJECT_ROOT, "daemon.json");
const STATE_FILE = path.join(PROJECT_ROOT, "daemon.state.json");
const LOG_FILE = path.join(PROJECT_ROOT, "daemon.log");

/** Headless sessions may chat (all clankerchat tools) and read the repo —
 *  nothing else, unless daemon.json sets fullAuto. */
const ALLOWED_TOOLS = [
  "mcp__clankerchat__send",
  "mcp__clankerchat__read",
  "mcp__clankerchat__create_thread",
  "mcp__clankerchat__list_threads",
  "mcp__clankerchat__list_channels",
];

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------

interface DaemonConfig {
  /** Discord user IDs allowed to trigger prompts. Bots never qualify. */
  allow: string[];
  /** Poll interval for the thread sweep, ms. */
  pollMs: number;
  /** Kill a spawned session after this long, ms. */
  timeoutMs: number;
  /** Spawn with --dangerously-skip-permissions instead of restricted mode. */
  fullAuto: boolean;
  /** Post a short ack into the thread when a prompt is dispatched. */
  ack: boolean;
  /** Thread name (project slug) -> absolute path of the repo to work in. */
  threads: Record<string, string>;
}

interface DaemonState {
  /** thread id -> last processed message id */
  cursors: Record<string, string>;
  /** thread name -> claude session id for --resume continuity */
  sessions: Record<string, string>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fatal(message: string): never {
  console.error(`clankerchat-daemon: ${message}`);
  process.exit(1);
}

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(LOG_FILE, stamped + "\n");
  } catch {
    // logging is best-effort; never let it kill the daemon
  }
}

function loadConfig(): DaemonConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    fatal(
      `daemon.json not found at ${CONFIG_FILE} — copy daemon.example.json to daemon.json and edit it (SETUP.md Step 11).`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    fatal(`daemon.json is not valid JSON: ${errText(err)}`);
  }
  const allow = parsed.allow;
  if (
    !Array.isArray(allow) ||
    allow.length === 0 ||
    !allow.every((id) => typeof id === "string" && /^\d+$/.test(id))
  ) {
    fatal(
      'daemon.json needs an "allow" array with at least one Discord user ID (digits only) — this is who may trigger prompts.',
    );
  }
  const threads = parsed.threads;
  if (
    typeof threads !== "object" ||
    threads === null ||
    Array.isArray(threads) ||
    Object.keys(threads).length === 0 ||
    !Object.values(threads).every((p) => typeof p === "string" && p.length > 0)
  ) {
    fatal(
      'daemon.json needs a "threads" object mapping thread name -> repo path, e.g. {"clankerchat": "C:\\\\repo\\\\clankerchat"}.',
    );
  }
  return {
    allow: allow as string[],
    pollMs: Math.max(1000, typeof parsed.pollMs === "number" ? parsed.pollMs : 5000),
    timeoutMs:
      typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : 15 * 60_000,
    fullAuto: parsed.fullAuto === true,
    ack: parsed.ack !== false,
    threads: threads as Record<string, string>,
  };
}

function loadState(): DaemonState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as DaemonState;
    return {
      cursors: parsed.cursors ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch {
    return { cursors: {}, sessions: {} };
  }
}

function saveState(): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`could not save state: ${errText(err)}`);
  }
}

let config!: DaemonConfig;
let state: DaemonState = { cursors: {}, sessions: {} };

// ---------------------------------------------------------------------------
// Discord client — same pattern as index.ts: gateway connects with the
// Guilds intent only, everything below runs over REST.
// ---------------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let resolveReady!: (c: Client<true>) => void;
const ready = new Promise<Client<true>>((res) => {
  resolveReady = res;
});

client.once(Events.ClientReady, (c) => {
  console.error(`clankerchat-daemon: connected as ${c.user.username} (${c.user.id})`);
  resolveReady(c);
});

client.on(Events.Error, (err) => {
  log(`discord client error: ${err.message}`);
});

function startDiscord(token: string): void {
  client.login(token).catch((err) => {
    fatal(`Discord login failed: ${errText(err)}. Check DISCORD_TOKEN in .env (SETUP.md Step 2).`);
  });
}

async function awaitReady(): Promise<Client<true>> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Discord connection not ready after ${READY_TIMEOUT_MS / 1000}s.`)),
      READY_TIMEOUT_MS,
    ).unref();
  });
  return Promise.race([ready, timeout]);
}

// ---------------------------------------------------------------------------
// Small helpers (kept local — same shape as index.ts)
// ---------------------------------------------------------------------------

function withSender(sender: string | undefined, message: string): string {
  if (!sender) return message;
  const clean = sender.replace(/[*_`~|\\\n\r]/g, "").trim();
  return clean ? `**${clean}**: ${message}` : message;
}

function byIdAscending(a: { id: string }, b: { id: string }): number {
  const cmp = BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  return cmp;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function sendToThread(threadId: string, message: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(threadId, { cache: false });
    if (!(channel instanceof ThreadChannel)) return;
    if (channel.archived) await channel.setArchived(false).catch(() => {});
    await channel.send(withSender(process.env.CLANKER_NAME, message));
  } catch (err) {
    log(`ack send failed in ${threadId}: ${errText(err)}`);
  }
}

/** A message triggers a prompt iff: human author, allowlisted, mentions the bot. */
function isTrigger(m: Message, botUser: User): boolean {
  if (m.author.bot) return false;
  if (!config.allow.includes(m.author.id)) return false;
  return m.mentions.has(botUser);
}

/** Drops the bot mention(s) so the remainder is the actual prompt text. */
function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>\\s*`, "g"), "").trim();
}

function killTree(child: { pid?: number; kill: (s?: NodeJS.Signals) => void }): void {
  if (process.platform === "win32" && child.pid) {
    // shell:true spawns cmd.exe, so the real claude process is a child — kill the tree.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Dispatch — pipe the prompt into `claude -p`, let it answer via MCP send
// ---------------------------------------------------------------------------

interface Job {
  threadName: string; // canonical name from Discord
  threadId: string;
  cwd: string; // repo path from daemon.json
  prompt: string; // mention-stripped message text
  from: string; // Discord username of the triggering human
}

const queue: Job[] = [];
let running = false;
let currentChild: ReturnType<typeof spawn> | null = null;

function buildPrompt(job: Job): string {
  const name = process.env.CLANKER_NAME ?? "clankerchat";
  return [
    `You are the ${name} dispatcher session, spawned because a human replied to this machine's bot in the "${job.threadName}" Discord thread.`,
    `Work in this repo: ${job.cwd}`,
    `When done — or if you cannot or should not do the task — reply in that thread by calling the MCP tool mcp__clankerchat__send with sender "${name}" and thread_name "${job.threadName}". Keep the reply under 2000 chars; never paste secrets.`,
    `Your ONLY output channel is that thread: do not message, ping, or otherwise contact other sessions or processes on this machine — the human's interactive sessions must never be prompted because of you.`,
    ``,
    `--- task from Discord user ${job.from} ---`,
    job.prompt,
  ].join("\n");
}

async function dispatch(job: Job): Promise<void> {
  running = true;
  log(`spawn: claude -p for "${job.threadName}" (prompt from ${job.from})`);
  try {
    if (config.ack) {
      await sendToThread(
        job.threadId,
        "dispatcher: prompt received — spawning a session; its reply lands in this thread.",
      );
    }

    const args = ["-p", "--output-format", "json", "--allowed-tools", ...ALLOWED_TOOLS];
    if (config.fullAuto) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "default");
    }
    const sessionId = state.sessions[job.threadName];
    if (sessionId) args.push("--resume", sessionId);

    const child = spawn("claude", args, { cwd: job.cwd, shell: true });
    currentChild = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString();
    });
    child.on("error", (err) => {
      log(`spawn error: ${errText(err)} — is claude on PATH for this daemon?`);
    });

    const timedOut = setTimeout(() => {
      log(`session for "${job.threadName}" exceeded ${config.timeoutMs}ms — killing it`);
      killTree(child);
    }, config.timeoutMs);

    try {
      child.stdin?.write(buildPrompt(job) + "\n");
      child.stdin?.end();
    } catch {
      // claude died before accepting stdin — the close handler reports it
    }

    const code = await new Promise<number | null>((res) => child.on("close", res));
    clearTimeout(timedOut);
    currentChild = null;

    // -p --output-format json prints one result object; keep the session id
    // so the next prompt in this thread resumes with context.
    const trimmed = stdout.trim();
    let sessionIdOut: string | undefined;
    let resultText = "";
    try {
      const parsed = JSON.parse(trimmed) as { session_id?: string; result?: string };
      sessionIdOut = parsed.session_id;
      resultText = parsed.result ?? "";
    } catch {
      const m = /"session_id"\s*:\s*"([0-9a-f-]+)"/.exec(trimmed);
      if (m) sessionIdOut = m[1];
    }
    if (sessionIdOut) {
      state.sessions[job.threadName] = sessionIdOut;
      saveState();
    }
    log(
      `done: "${job.threadName}" exit ${code}${resultText ? ` — ${resultText.slice(0, 200)}` : stderr ? ` — stderr: ${stderr.slice(0, 200)}` : ""}`,
    );

    if (code !== 0) {
      // Most often a stale --resume id; drop it so the next trigger starts fresh.
      delete state.sessions[job.threadName];
      saveState();
      await sendToThread(
        job.threadId,
        `dispatcher: the spawned session exited with code ${code} before replying — see daemon.log on this machine. (Session context dropped; next reply starts fresh.)`,
      );
    }
  } finally {
    running = false;
  }
}

function enqueue(job: Job): void {
  if (queue.length >= MAX_QUEUE) {
    log(`queue full — dropping prompt from ${job.from} in "${job.threadName}"`);
    return;
  }
  queue.push(job);
  log(`queued: "${job.threadName}" from ${job.from} (queue=${queue.length})`);
}

async function drain(): Promise<void> {
  if (running) return;
  while (queue.length > 0) {
    const job = queue.shift()!;
    if (!fs.existsSync(job.cwd)) {
      log(`mapped path does not exist: ${job.cwd} (thread "${job.threadName}")`);
      await sendToThread(
        job.threadId,
        `dispatcher: daemon.json maps this thread to \`${job.cwd}\`, which does not exist on this machine — fix the mapping (SETUP.md Step 11).`,
      );
      continue;
    }
    await dispatch(job);
  }
}

// ---------------------------------------------------------------------------
// Poll loop — same REST reads the agents use
// ---------------------------------------------------------------------------

const warnedMissingThreads = new Set<string>();

async function pollOnce(parent: TextChannel | NewsChannel, botUser: User): Promise<void> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(),
    parent.threads.fetchArchived(),
  ]);
  const threads = [...active.threads.values(), ...archived.threads.values()];

  for (const [name, cwd] of Object.entries(config.threads)) {
    const thread = threads.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!thread) {
      if (!warnedMissingThreads.has(name)) {
        warnedMissingThreads.add(name);
        log(`thread "${name}" not found in the team channel — waiting for it to exist`);
      }
      continue;
    }
    warnedMissingThreads.delete(name);

    const latest = thread.lastMessageId;
    let cursor = state.cursors[thread.id];
    if (cursor === undefined) {
      // First sight of the thread: skip the backlog, prompt on new replies only.
      if (latest) {
        state.cursors[thread.id] = latest;
        saveState();
      }
      continue;
    }
    if (!latest || BigInt(cursor) >= BigInt(latest)) continue;

    const fetched = await thread.messages.fetch({
      limit: FETCH_LIMIT,
      after: cursor,
      cache: false,
    });
    const messages = [...fetched.values()].sort(byIdAscending);
    for (const m of messages) {
      cursor = m.id;
      if (!isTrigger(m, botUser)) continue;
      const prompt = stripMention(m.content, botUser.id);
      if (!prompt) {
        log(`skip: trigger from ${m.author.username} in "${name}" had no text`);
        continue;
      }
      enqueue({ threadName: thread.name, threadId: thread.id, cwd, prompt, from: m.author.username });
    }
    if (messages.length > 0) {
      state.cursors[thread.id] = cursor;
      saveState();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvFile();
  config = loadConfig();
  state = loadState();

  const token = process.env.DISCORD_TOKEN;
  if (!token) fatal("DISCORD_TOKEN is not set in .env (SETUP.md Step 4).");
  const channelId = process.env.CLANKER_CHANNEL_ID;
  if (!channelId) fatal("CLANKER_CHANNEL_ID is not set in .env (SETUP.md Step 6).");

  startDiscord(token);
  const me = await awaitReady();
  const parent = await client.channels.fetch(channelId, { cache: false });
  if (!(parent instanceof TextChannel) && !(parent instanceof NewsChannel)) {
    fatal(`CLANKER_CHANNEL_ID ${channelId} is not a text channel.`);
  }

  log(
    `watching [${Object.keys(config.threads).join(", ")}] as ${me.user.username}; ` +
      `allow=${config.allow.join(",")}; fullAuto=${config.fullAuto}; poll=${config.pollMs}ms`,
  );

  for (;;) {
    try {
      await pollOnce(parent, me.user);
    } catch (err) {
      log(`poll error: ${errText(err)}`);
    }
    try {
      await drain();
    } catch (err) {
      log(`dispatch error: ${errText(err)}`);
    }
    await sleep(config.pollMs);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("shutting down");
    if (currentChild) killTree(currentChild);
    void client.destroy();
    process.exit(0);
  });
}

process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${errText(reason)}`);
});

main().catch((err) => {
  fatal(errText(err));
});
