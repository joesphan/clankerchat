#!/usr/bin/env node
/**
 * clankerchat daemon — reply-to-prompt overseer.
 *
 * Model:
 *   - Runs alongside the MCP server (same .env, same bot) and polls EVERY
 *     thread in the team channel with the same REST `after`-cursor reads
 *     agents use — no extra Discord permissions beyond the MessageContent
 *     intent the MCP server also needs.
 *   - A message becomes a prompt ONLY when ALL of these hold:
 *       1. the author is not a bot,
 *       2. the author's Discord user ID is listed in daemon.json `allow`,
 *       3. the message mentions this machine's bot — a Discord *reply* to one
 *          of the bot's messages mentions it automatically; an explicit
 *          @mention works too.
 *     Everything else is ignored; agents keep polling as usual.
 *   - A triggered message goes to a ROUTING stage: a small headless session
 *     with ListAgents/SendMessage that either wakes a matching live LOCAL
 *     session or picks the repo a worker should run in — the daemon.json
 *     `threads` map first, else inference over the folders under `reposRoot`.
 *     Successful inferences are written back to daemon.json (learned). A wake
 *     is only trusted if an answer lands in the thread within `wakeGraceMs`;
 *     otherwise the daemon spawns a worker fallback — an answer always lands.
 *     Set "wake": false to always spawn.
 *   - A worker is `claude -p` with the message piped on stdin, run in the
 *     routed repo; it answers by calling the clankerchat MCP `send` tool
 *     itself — the daemon never parses or relays model output.
 *   - Workers are restricted by default: default permission mode plus an
 *     explicit allowlist of the clankerchat tools (read the repo + chat,
 *     nothing else) unless daemon.json sets `fullAuto`. One prompt at a time
 *     per machine; further triggers queue. Workers resume per thread
 *     (`--resume`), so follow-up replies keep context; a failed resume falls
 *     back to a fresh session.
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
const START_ISO = new Date().toISOString();
/** Meta tag: a trigger starting with one of these addresses the overseer
 *  itself (status/config/questions), never the task router. */
const META_PREFIX_RE = /^(?:!ov\b|!overseer\b|overseer:)\s*/i;
const FETCH_LIMIT = 50; // messages per poll per thread (Discord caps at 100)
const MAX_QUEUE = 8; // prompts waiting while one is running
const MAX_STDOUT = 256 * 1024; // captured from a spawned session, for logging
const MAX_STDERR = 64 * 1024;
const ROUTER_TIMEOUT_MS = 180_000; // routing must be quick; it is not the work

const CONFIG_FILE = path.join(PROJECT_ROOT, "daemon.json");
const STATE_FILE = path.join(PROJECT_ROOT, "daemon.state.json");
const LOG_FILE = path.join(PROJECT_ROOT, "daemon.log");

/** Workers may chat (all clankerchat tools) and read the repo — nothing else,
 *  unless daemon.json sets fullAuto. */
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
  /** Discord user IDs allowed to trigger prompts. */
  allow: string[];
  /** Let other machines' bots trigger too (agent-to-agent addressing). Our
   *  own bot never triggers itself. */
  allowBots: boolean;
  /** Explicit bot user IDs allowed to trigger. Empty = every bot (only safe
   *  when every bot in the channel is trusted; a compromised peer bot with
   *  this open can drive fullAuto workers on this machine). */
  botAllow: string[];
  /** Poll interval for the thread sweep, ms. */
  pollMs: number;
  /** Kill a worker after this long, ms. */
  timeoutMs: number;
  /** Spawn with --dangerously-skip-permissions instead of restricted mode. */
  fullAuto: boolean;
  /** Post a short ack into the thread when a prompt is dispatched. */
  ack: boolean;
  /** Try to wake a matching live local session before spawning a worker.
   *  The receiving session may ask its human to approve the wake message. */
  wake: boolean;
  /** How long a woken session has to answer in-thread before the daemon
   *  spawns a worker fallback, ms. */
  wakeGraceMs: number;
  /** Folder holding this machine's repos — the inference search space. */
  reposRoot: string;
  /** Neutral cwd for tasks routing can't place (no mapping, session match,
   *  or repo match). Unset → unplaceable tasks are refused, as before. */
  sandbox: string | null;
  /** Thread name (project slug) -> repo path. A HINT map: unmapped threads
   *  are routed by inference, and successful inferences land here. */
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

/** One log line per event — result excerpts must not splinter across lines
 *  (splinters would false-positive error greps). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function loadConfig(): DaemonConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    fatal(
      `daemon.json not found at ${CONFIG_FILE} — copy daemon.example.json to daemon.json and edit it (see SETUP.md Step 11).`,
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
  const threads = (parsed.threads ?? {}) as Record<string, unknown>;
  if (
    typeof threads !== "object" ||
    threads === null ||
    Array.isArray(threads) ||
    !Object.values(threads).every((p) => typeof p === "string" && p.length > 0)
  ) {
    fatal(
      'daemon.json "threads" must map thread name -> repo path, e.g. {"clankerchat": "C:\\\\repo\\\\clankerchat"} (may be empty {}).',
    );
  }
  return {
    allow: allow as string[],
    allowBots: parsed.allowBots === true,
    botAllow: Array.isArray(parsed.botAllow)
      ? (parsed.botAllow as unknown[]).filter(
          (id): id is string => typeof id === "string" && /^\d+$/.test(id),
        )
      : [],
    pollMs: Math.max(1000, typeof parsed.pollMs === "number" ? parsed.pollMs : 5000),
    timeoutMs:
      typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : 15 * 60_000,
    fullAuto: parsed.fullAuto === true,
    ack: parsed.ack !== false,
    wake: parsed.wake !== false,
    wakeGraceMs:
      typeof parsed.wakeGraceMs === "number" ? Math.max(60_000, parsed.wakeGraceMs) : 4 * 60_000,
    reposRoot:
      typeof parsed.reposRoot === "string"
        ? path.resolve(parsed.reposRoot)
        : path.dirname(PROJECT_ROOT), // repo sits in the repos folder by default
    sandbox:
      typeof parsed.sandbox === "string" && fs.existsSync(parsed.sandbox)
        ? path.resolve(parsed.sandbox)
        : null,
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
// Guilds + MessageContent intents (MessageContent is required to read other
// participants' messages — see the note in index.ts), REST below.
// ---------------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });

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

// ---------------------------------------------------------------------------
// Typing indicator — Discord's lasts ~10s, so re-trigger every 8s while work
// runs. Refcounted per thread (router + worker on the same thread stack).
// ---------------------------------------------------------------------------

const typing = new Map<string, { timer: NodeJS.Timeout; refs: number }>();

async function typingTick(threadId: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(threadId, { cache: false });
    if (channel instanceof ThreadChannel) await channel.sendTyping();
  } catch {
    // thread gone/unreachable — stop() clears us; nothing to log per tick
  }
}

function startTyping(threadId: string): () => void {
  const existing = typing.get(threadId);
  if (existing) {
    existing.refs++;
    return () => stopTypingRef(threadId);
  }
  void typingTick(threadId);
  const timer = setInterval(() => void typingTick(threadId), 8_000);
  typing.set(threadId, { timer, refs: 1 });
  return () => stopTypingRef(threadId);
}

function stopTypingRef(threadId: string): void {
  const t = typing.get(threadId);
  if (!t) return;
  if (--t.refs > 0) return;
  clearInterval(t.timer);
  typing.delete(threadId);
}

/** Message ids the daemon itself posted (acks, notices). A wake counts as
 *  answered only when a SESSION replies — never the daemon's own messages. */
const daemonMessageIds = new Set<string>();

async function sendToThread(threadId: string, message: string): Promise<string | null> {
  try {
    const channel = await client.channels.fetch(threadId, { cache: false });
    if (!(channel instanceof ThreadChannel)) return null;
    if (channel.archived) await channel.setArchived(false).catch(() => {});
    const sent = await channel.send(withSender(process.env.CLANKER_NAME, message));
    daemonMessageIds.add(sent.id);
    return sent.id;
  } catch (err) {
    log(`ack send failed in ${threadId}: ${errText(err)}`);
    return null;
  }
}

/** A message triggers a prompt iff it mentions the bot AND the author counts:
 *  humans must be allowlisted; other bots count when allowBots is on. Our own
 *  bot never triggers itself (self-loop). */
function isTrigger(m: Message, botUser: User): boolean {
  if (m.author.id === botUser.id) return false;
  if (!m.mentions.has(botUser)) return false;
  if (m.author.bot) {
    return config.allowBots && (config.botAllow.length === 0 || config.botAllow.includes(m.author.id));
  }
  return config.allow.includes(m.author.id);
}

/** Drops the bot mention(s) so the remainder is the actual prompt text. */
function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>\\s*`, "g"), "").trim();
}

/** Returns the meta payload if the prompt is tagged for the overseer itself. */
function splitMeta(prompt: string): string | null {
  const m = META_PREFIX_RE.exec(prompt);
  return m ? prompt.slice(m[0].length).trim() : null;
}

function mappedCwdFor(threadName: string): string | null {
  const hit = Object.entries(config.threads).find(
    ([n]) => n.toLowerCase() === threadName.toLowerCase(),
  );
  return hit ? hit[1] : null;
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
// Headless claude plumbing — one spawn helper for router and workers
// ---------------------------------------------------------------------------

interface ClaudeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runClaude(
  args: string[],
  cwd: string,
  stdinText: string,
  timeoutMs: number,
): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, shell: true });
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
      log(`claude run in ${cwd} exceeded ${timeoutMs}ms — killing it`);
      killTree(child);
    }, timeoutMs);
    try {
      child.stdin?.write(stdinText + "\n");
      child.stdin?.end();
    } catch {
      // claude died before accepting stdin — the close handler reports it
    }
    child.on("close", (code) => {
      clearTimeout(timedOut);
      if (currentChild === child) currentChild = null;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parses `claude -p --output-format json` output. */
function parseSessionResult(stdout: string): { sessionId?: string; result: string } {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as { session_id?: string; result?: string };
    return { sessionId: parsed.session_id, result: parsed.result ?? "" };
  } catch {
    const m = /"session_id"\s*:\s*"([0-9a-f-]+)"/.exec(trimmed);
    return { sessionId: m?.[1], result: "" };
  }
}

// ---------------------------------------------------------------------------
// Routing stage — wake a live local session, or infer the repo for a worker
// ---------------------------------------------------------------------------

interface Job {
  threadName: string; // canonical name from Discord
  threadId: string;
  cwd: string | null; // repo path from daemon.json, if the thread is mapped
  prompt: string; // mention-stripped message text
  from: string; // Discord username of the triggering human
  fromId: string; // Discord user/bot id of the asker — replies tag this
  fromBot: boolean; // triggered by a peer bot rather than an allowlisted human
  triggerId: string; // id of the Discord message that triggered this job
  skipWake?: boolean; // fallback run: route cwd only, never wake
}

interface RouteDecision {
  woke: string | null; // name of the live session that was messaged
  cwd: string | null; // inferred repo for a worker
  confidence: "high" | "low"; // high = the task itself names the project
  reason: string;
}

function repoFolderNames(reposRoot: string): string[] {
  try {
    return fs
      .readdirSync(reposRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function buildRouterPrompt(job: Job, mappedCwd: string | null): string {
  const name = process.env.CLANKER_NAME ?? "clankerchat";
  const repoNames = repoFolderNames(config.reposRoot);
  return [
    `You are the routing stage of the ${name} overseer on this machine. Route ONE incoming question; be decisive and fast — do NOT do the task yourself.`,
    ``,
    `Question (Discord user ${job.from}) in thread "${job.threadName}":`,
    `"""`,
    job.prompt,
    `"""`,
    ``,
    `Known thread→repo map: ${JSON.stringify(config.threads)}`,
    mappedCwd ? `This thread is mapped to: ${mappedCwd}` : `This thread is NOT mapped.`,
    `Repo folders under ${config.reposRoot}: ${repoNames.join(", ") || "(none found)"}`,
    ``,
    `Steps:`,
    `1. Call ListAgents once. If a LOCAL session (skip cloud/remote-control ones) clearly works on this exact project/thread AND is idle, wake it via SendMessage: "Overseer relay — answer in Discord thread '${job.threadName}' via mcp__clankerchat__send (sender '${name}'), starting the reply with the tag <@${job.fromId}> , commands/paths in fenced or inline code blocks (Discord mangles bare code), then continue your work: ${job.prompt.slice(0, 500)}". Then set "woke" to that session's name.`,
    `2. Otherwise pick "cwd" for a worker — match where the TASK wants to run, not what the thread is about: the mapped path if given; else a repo folder ONLY when the task itself clearly targets that project (names it, or its files/paths clearly live in it). A task referencing paths outside every repo, or a generic disk/web/misc task, gets null — do NOT guess from the thread's topic. "confidence" is "high" only when the task explicitly names the project, "low" for weaker signals.`,
    ``,
    `Reply with ONLY one line of JSON, no prose:`,
    `{"woke": <session name or null>, "cwd": <absolute path or null>, "confidence": "high"|"low", "reason": "<=10 words"}`,
  ].join("\n");
}

async function runRouter(job: Job, mappedCwd: string | null): Promise<RouteDecision | null> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--allowed-tools",
    "ListAgents",
    "SendMessage",
    "--permission-mode",
    "default",
  ];
  const run = await runClaude(args, config.reposRoot, buildRouterPrompt(job, mappedCwd), ROUTER_TIMEOUT_MS);
  if (run.code !== 0) {
    log(`router failed (exit ${run.code}): ${run.stderr.slice(0, 200)}`);
    return null;
  }
  const { result } = parseSessionResult(run.stdout);
  const m = /\{[\s\S]*\}/.exec(result); // the decision is one JSON line; tolerate prose around it
  if (!m) {
    log(`router returned no decision: ${result.slice(0, 200)}`);
    return null;
  }
  try {
    const d = JSON.parse(m[0]) as Partial<RouteDecision>;
    return {
      woke: typeof d.woke === "string" && d.woke ? d.woke : null,
      cwd:
        typeof d.cwd === "string" && d.cwd && fs.existsSync(d.cwd)
          ? path.resolve(d.cwd)
          : null,
      confidence: d.confidence === "high" ? "high" : "low",
      reason: typeof d.reason === "string" ? d.reason : "",
    };
  } catch {
    log(`router decision unparseable: ${result.slice(0, 200)}`);
    return null;
  }
}

/** Persist an inferred thread→repo mapping so the next trigger is instant. */
function rememberMapping(threadName: string, cwd: string): void {
  if (config.threads[threadName] === cwd) return;
  config.threads[threadName] = cwd;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
    parsed.threads = config.threads;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2) + "\n");
    log(`learned mapping: "${threadName}" -> ${cwd}`);
  } catch (err) {
    log(`could not persist learned mapping: ${errText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch — route, then spawn the worker; the worker answers via MCP send
// ---------------------------------------------------------------------------

const queue: Job[] = [];
let running = false;
let currentChild: ReturnType<typeof spawn> | null = null;

// ---------------------------------------------------------------------------
// Wake watchdog — a routed wake only counts if an answer lands in the thread
// ---------------------------------------------------------------------------

interface FollowUp {
  job: Job;
  ackId: string; // ack (or trigger) id; any bot message newer than this = answered
  deadline: number;
  routedCwd: string | null; // repo the router picked, reused by the fallback
  stopTyping: () => void; // keep the indicator lit until the answer or deadline
}

const pendingFollowups: FollowUp[] = [];

async function checkFollowups(): Promise<void> {
  for (let i = pendingFollowups.length - 1; i >= 0; i--) {
    const f = pendingFollowups[i];
    try {
      const channel = await client.channels.fetch(f.job.threadId, { cache: false });
      if (channel instanceof ThreadChannel) {
        const fetched = await channel.messages.fetch({ limit: 25, after: f.ackId, cache: false });
        const answered = [...fetched.values()].some(
          (m) =>
            m.author.id === client.user?.id &&
            !daemonMessageIds.has(m.id) &&
            BigInt(m.id) > BigInt(f.ackId),
        );
        if (answered) {
          pendingFollowups.splice(i, 1);
          f.stopTyping();
          log(`wake follow-up: live session answered in "${f.job.threadName}"`);
          continue;
        }
      }
    } catch (err) {
      log(`wake follow-up check failed in "${f.job.threadName}": ${errText(err)}`);
    }
    if (Date.now() >= f.deadline) {
      pendingFollowups.splice(i, 1);
      f.stopTyping();
      log(`wake follow-up: no answer in "${f.job.threadName}" after ${config.wakeGraceMs}ms — spawning worker fallback`);
      enqueue({ ...f.job, cwd: f.routedCwd ?? f.job.cwd, skipWake: true });
    }
  }
}

function buildWorkerPrompt(job: Job, cwd: string, sandboxed: boolean): string {
  const name = process.env.CLANKER_NAME ?? "clankerchat";
  return [
    `You are the ${name} overseer worker, spawned because ${job.fromBot ? `another machine's agent (${job.from}) mentioned` : "a human replied to"} this machine's bot in the "${job.threadName}" Discord thread.`,
    `Start your reply by tagging the asker — the first characters of the message must be <@${job.fromId}> followed by a space.`,
    job.fromBot
      ? `Post your reply as a NEW message in the thread, not a Discord reply to their message (new-message tags reach the peer's humans; reply-chains can trip peer daemons that wake on mentions).`
      : ``,
    sandboxed
      ? `Routing could not tell which project this task belongs to, so you are running in a neutral sandbox: ${cwd}. Do the task with general tools; touch other repos only if the task explicitly requires it.`
      : `Work in this repo: ${cwd}`,
    `When done — or if you cannot or should not do the task — reply in that thread by calling the MCP tool mcp__clankerchat__send with sender "${name}" and thread_name "${job.threadName}". Keep the reply under 2000 chars; never paste secrets.`,
    `Format for Discord: every command, path, snippet, or log excerpt goes in a fenced code block (triple backticks, language tag when known) or \`inline code\` — bare code gets mangled into goofy formatting by Discord markdown.`,
    `Your ONLY output channel is that thread: do not message, ping, or otherwise contact other sessions or processes on this machine — the human's interactive sessions must never be prompted because of you.`,
    ``,
    `--- task from Discord user ${job.from} ---`,
    job.prompt,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Meta channel — "!ov ..." addresses the overseer itself, never the router
// ---------------------------------------------------------------------------

async function handleMeta(job: Job, rest: string): Promise<void> {
  const [cmd, ...args] = rest.split(/\s+/);
  const arg = args.join(" ").trim();
  switch ((cmd ?? "").toLowerCase()) {
    case "":
    case "help":
      await sendToThread(
        job.threadId,
        "overseer meta — tag a reply with `!ov` to talk to me directly:\n" +
          "• `!ov status` — what I'm watching, queue, wake settings, saved worker sessions\n" +
          "• `!ov forget` — drop this thread's saved worker context (next task starts fresh)\n" +
          "• `!ov map [path]` — show (or set) this thread's repo mapping\n" +
          "• `!ov reload` — re-read daemon.json without a restart\n" +
          "• `!ov <anything else>` — ask me; I answer from my own state + log\n" +
          "Anything untagged is routed as a task, as before.",
      );
      return;
    case "status": {
      const mapped =
        Object.entries(config.threads)
          .map(([n, p]) => `${n} → ${p}`)
          .join("; ") || "(none)";
      await sendToThread(
        job.threadId,
        `overseer status — ${client.user?.username ?? "?"}, up since ${START_ISO}\n` +
          `watching every team thread; mapped: ${mapped}\n` +
          `wake=${config.wake} (grace ${config.wakeGraceMs / 1000}s), fullAuto=${config.fullAuto}, poll=${config.pollMs}ms, reposRoot=${config.reposRoot}\n` +
          `queue=${queue.length}, busy=${running}, wake-checks pending=${pendingFollowups.length}\n` +
          `worker sessions: ${Object.entries(state.sessions).map(([n, id]) => `${n}: ${id.slice(0, 8)}`).join(", ") || "(none yet)"}`,
      );
      return;
    }
    case "forget":
      delete state.sessions[job.threadName];
      saveState();
      await sendToThread(
        job.threadId,
        `overseer: dropped the saved worker context for "${job.threadName}" — the next task in this thread starts fresh.`,
      );
      return;
    case "map": {
      if (!arg) {
        await sendToThread(
          job.threadId,
          `overseer: "${job.threadName}" → ${mappedCwdFor(job.threadName) ?? "(unmapped — inference decides)"}`,
        );
        return;
      }
      const abs = path.resolve(arg);
      if (!fs.existsSync(abs)) {
        await sendToThread(job.threadId, `overseer: \`${abs}\` does not exist — mapping unchanged.`);
        return;
      }
      rememberMapping(job.threadName, abs);
      await sendToThread(job.threadId, `overseer: mapped "${job.threadName}" → ${abs}`);
      return;
    }
    case "reload":
      try {
        config = loadConfig();
        await sendToThread(
          job.threadId,
          `overseer: reloaded daemon.json — mapped=[${Object.keys(config.threads).join(", ")}], wake=${config.wake}, grace=${config.wakeGraceMs / 1000}s`,
        );
      } catch (err) {
        await sendToThread(job.threadId, `overseer: reload refused — ${errText(err)} (config unchanged).`);
      }
      return;
    default:
      await metaSession(job, rest);
      return;
  }
}

/** Free-form meta question → a small session that IS the overseer, answering
 *  from its own config, queue state, and recent daemon.log. */
async function metaSession(job: Job, question: string): Promise<void> {
  await sendToThread(job.threadId, "overseer meta: on it — answering from my own state.");
  let logTail = "";
  try {
    logTail = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).slice(-60).join("\n");
  } catch {
    // no log yet — fine
  }
  const { allow: _allow, ...configSansIds } = config;
  const facts = [
    `config: ${JSON.stringify(configSansIds)}`,
    `queue=${queue.length}, busy=${running}, wake-checks pending=${pendingFollowups.length}`,
    `worker sessions: ${JSON.stringify(state.sessions)}`,
    `recent daemon.log tail:\n${logTail}`,
  ].join("\n");
  const name = process.env.CLANKER_NAME ?? "clankerchat";
  const prompt = [
    `You ARE the overseer itself on machine ${name} — the daemon behind clankerchat's reply-to-prompt system (repo: ${PROJECT_ROOT}). A human tagged you directly with a meta question about you/your machinery. This is NOT a project task — do not route it, do not work on any repo; answer about yourself. Answer ONLY from the facts provided below — do not explore the filesystem, repos, or processes; if the facts don't cover it, say so plainly.`,
    ``,
    facts,
    ``,
    `--- meta question from ${job.from} ---`,
    question,
    ``,
    `Answer in the "${job.threadName}" thread by calling mcp__clankerchat__send with sender "${name}" and thread_name "${job.threadName}", under 2000 chars, starting with the tag <@${job.fromId}> then "overseer meta:". Never paste secrets. Format for Discord: commands/paths/snippets in fenced or inline code blocks — bare code gets mangled by Discord markdown.`,
  ].join("\n");
  const args = ["-p", "--output-format", "json", "--allowed-tools", ...ALLOWED_TOOLS, "--permission-mode", "default"];
  const stopTyping = startTyping(job.threadId);
  const run = await runClaude(args, PROJECT_ROOT, prompt, config.timeoutMs);
  stopTyping();
  const { result } = parseSessionResult(run.stdout);
  log(
    `meta done: exit ${run.code}${result ? ` — ${oneLine(result).slice(0, 200)}` : run.stderr ? ` — stderr: ${oneLine(run.stderr).slice(0, 200)}` : ""}`,
  );
  if (run.code !== 0) {
    await sendToThread(job.threadId, `overseer meta: session exited ${run.code} before replying — see daemon.log.`);
  }
}

async function dispatch(job: Job): Promise<void> {
  running = true;
  log(`dispatch: "${job.threadName}" (prompt from ${job.from})`);
  let stopTyping: (() => void) | null = null;
  try {
    const metaRest = splitMeta(job.prompt);
    if (metaRest !== null) {
      log(`meta: ${metaRest.slice(0, 80)}`);
      await handleMeta(job, metaRest);
      return;
    }

    // "Thinking…" in the thread from routing until the answer lands.
    stopTyping = startTyping(job.threadId);
    const ackId = config.ack
      ? await sendToThread(
          job.threadId,
          "overseer: prompt received — routing it; the answer lands in this thread.",
        )
      : null;

    // Route: wake a live local session if one fits, else decide the worker's repo.
    let cwd = job.cwd;
    let woke: string | null = null;
    let routeConfidence: "high" | "low" = "high"; // explicit mapping is always trusted
    if (!job.skipWake && (!cwd || config.wake)) {
      const decision = await runRouter(job, cwd);
      if (decision) {
        woke = decision.woke;
        if (!cwd && decision.cwd) cwd = decision.cwd;
        routeConfidence = decision.confidence;
        log(`router: woke=${woke ?? "-"} cwd=${cwd ?? "-"} conf=${routeConfidence} (${decision.reason})`);
      }
    }

    if (woke) {
      pendingFollowups.push({
        job,
        ackId: ackId ?? job.triggerId,
        deadline: Date.now() + config.wakeGraceMs,
        routedCwd: cwd,
        stopTyping: stopTyping ?? (() => {}),
      });
      stopTyping = null; // ownership moves to the follow-up (lit until answer/deadline)
      log(`done: "${job.threadName}" routed to live session "${woke}" (watchdog ${config.wakeGraceMs / 1000}s)`);
      return; // the watchdog spawns a worker if no answer lands in time
    }
    let sandboxed = false;
    if (!cwd) {
      // Unplaceable (no mapping, session match, or repo match): run in the
      // sandbox rather than refusing — but never learn a sandbox "mapping".
      if (config.sandbox) {
        cwd = config.sandbox;
        sandboxed = true;
        log(`routing could not place "${job.threadName}" — worker runs in sandbox ${cwd}`);
      } else {
        await sendToThread(
          job.threadId,
          "overseer: could not tell which repo this thread is about, and no sandbox is configured — add it to daemon.json (SETUP.md Step 11) and reply again.",
        );
        return;
      }
    }
    if (!fs.existsSync(cwd)) {
      log(`routed path does not exist: ${cwd} (thread "${job.threadName}")`);
      await sendToThread(
        job.threadId,
        `overseer: this thread routes to \`${cwd}\`, which does not exist on this machine — fix daemon.json (SETUP.md Step 11).`,
      );
      return;
    }
    if (!job.cwd && !sandboxed && routeConfidence === "high") rememberMapping(job.threadName, cwd);

    const args = ["-p", "--output-format", "json", "--allowed-tools", ...ALLOWED_TOOLS];
    if (config.fullAuto) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "default");
    }
    const sessionId = state.sessions[job.threadName];
    if (sessionId) args.push("--resume", sessionId);

    const run = await runClaude(args, cwd, buildWorkerPrompt(job, cwd, sandboxed), config.timeoutMs);
    const { sessionId: sessionIdOut, result } = parseSessionResult(run.stdout);
    if (sessionIdOut) {
      state.sessions[job.threadName] = sessionIdOut;
      saveState();
    }
    log(
      `done: "${job.threadName}" exit ${run.code}${result ? ` — ${oneLine(result).slice(0, 200)}` : run.stderr ? ` — stderr: ${oneLine(run.stderr).slice(0, 200)}` : ""}`,
    );

    if (run.code !== 0) {
      // Most often a stale --resume id; drop it so the next trigger starts fresh.
      delete state.sessions[job.threadName];
      saveState();
      await sendToThread(
        job.threadId,
        `overseer: the worker session exited with code ${run.code} before replying — see daemon.log on this machine. (Session context dropped; next reply starts fresh.)`,
      );
    }
  } finally {
    stopTyping?.();
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
    await dispatch(job);
  }
}

// ---------------------------------------------------------------------------
// Poll loop — same REST reads the agents use, over EVERY thread
// ---------------------------------------------------------------------------

async function pollOnce(parent: TextChannel | NewsChannel, botUser: User): Promise<void> {
  const [active, archived] = await Promise.all([
    parent.threads.fetchActive(),
    parent.threads.fetchArchived(),
  ]);
  const threads = [...active.threads.values(), ...archived.threads.values()];

  for (const thread of threads) {
    const mapped = mappedCwdFor(thread.name);

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
        log(`skip: trigger from ${m.author.username} in "${thread.name}" had no text`);
        continue;
      }
      enqueue({
        threadName: thread.name,
        threadId: thread.id,
        cwd: mapped,
        prompt,
        from: m.author.username,
        fromId: m.author.id,
        fromBot: m.author.bot,
        triggerId: m.id,
      });
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
    `overseer: watching every thread in the team channel as ${me.user.username}; ` +
      `mapped=[${Object.keys(config.threads).join(", ")}]; reposRoot=${config.reposRoot}; ` +
      `wake=${config.wake}; allow=${config.allow.join(",")}; fullAuto=${config.fullAuto}; poll=${config.pollMs}ms`,
  );

  for (;;) {
    try {
      await pollOnce(parent, me.user);
    } catch (err) {
      log(`poll error: ${errText(err)}`);
    }
    try {
      await checkFollowups();
    } catch (err) {
      log(`follow-up error: ${errText(err)}`);
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
