/**
 * spark-mcp.ts — Gemini Spark custom-app gateway (owner 2026-10-04).
 *
 * Tyler talks to Gemini on his phone; Gemini (via Spark's Connected Apps →
 * Custom apps) calls THIS server's tools to drive the machine. The
 * connection direction is Google → us, so nothing here ever needs a Google
 * API key — the AI plan unlocks Spark on Google's side; our side only needs
 * its own gate.
 *
 * Transport: MCP streamable HTTP (stateless — one transport per request),
 * what Spark's custom-app connector speaks.
 *
 * EXPOSURE MODEL (the owner's "no IP, no WAN injection" ask):
 *   - Binds 127.0.0.1 ONLY. The public side is a NAMED Cloudflare Tunnel on
 *     the owner's domain (outbound-only cloudflared — no open ports, no IP
 *     disclosure). Never an ephemeral tunnel.
 *   - Auth is a 128-bit unguessable capability path (+ optional bearer
 *     token). EVERYTHING that is not the exact path with valid auth gets
 *     the same dead-host 404 — no oracle distinguishes this host from an
 *     empty port to a scanner.
 *   - Rate gate: small global sliding window; a leaked capability gets
 *     throttled, not amplified.
 *   - Blast radius = the phone app's: tools can ASK (prompt records ride
 *     the same proven owner-priority path the companion app uses, with
 *     spark-prefixed fp provenance) and READ machine facts. No Discord
 *     send, no files, no secrets. Prompt text arriving here is untrusted
 *     data exactly like a phone prompt — the run-side framing owns that.
 *   - Everything returned to Gemini passes the leak-shape scan: no secret-
 *     shaped content ever rides the WAN leg.
 *   - EGRESS LAW (owner 2026-10-04): no other users' Discord data — and no
 *     email/PII of any kind — ever rides the WAN leg. Three layers: tools
 *     surface spark-originated records ONLY (phone-surface and peer records
 *     are indistinguishable misses); every human-shaped string is scrubbed
 *     (emails, mention tokens, 7+ digit runs) at the egress point; machine
 *     telemetry is projected numbers/timestamps-first, names dropped before
 *     a payload exists.
 *
 * Secrets live in .env (SPARK_MCP_TOKEN, SPARK_MCP_PATH) — values are
 * never logged; the fp provenance string carries only a hash head.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadEnvFile } from "./env.js";
import {
  createPhonePrompt,
  getPrompt,
  listPhonePrompts,
  PROMPT_ID_RE,
  MAX_PROMPT_CHARS,
  type PromptRecord,
} from "./prompts.js";
import { findLeakSignals, findMassMentions, massMentionRefusal } from "./leaks.js";

export const SPARK_DEFAULT_PORT = 8791;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60; // conversational tool use is a handful of calls/min, not a scrape

/** Timing-safe string equality via sha256 (no length leak, constant compare). */
export function secretMatch(got: string | undefined, want: string): boolean {
  if (!got) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** The capability path, normalized: exactly `/<SPARK_MCP_PATH>` (single slash). */
export function capabilityMatch(pathname: string, capPath: string): boolean {
  const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");
  return norm(pathname) === norm(capPath);
}

/** Bearer check: `Authorization: Bearer <token>` when a token is configured. */
export function bearerOk(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true; // path-only mode: the capability IS the auth
  const m = String(header ?? "").match(/^Bearer\s+(.+)$/);
  return secretMatch(m?.[1], token);
}

/**
 * Provenance for prompt records created here: a HASH head of the capability
 * secret — same law as every other sha-head: ties records to this surface,
 * never exposes the value.
 */
export function sparkFp(token: string | undefined, path: string): string {
  const material = token && token.length > 0 ? token : `path:${path}`;
  return `spark:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

/** Global sliding-window rate gate — a shared mutable box, one per process. */
export interface RateGate {
  hits: number[];
}
export function rateAllow(gate: RateGate, now = Date.now()): boolean {
  while (gate.hits.length > 0 && now - gate.hits[0] > RATE_WINDOW_MS) gate.hits.shift();
  if (gate.hits.length >= RATE_MAX) return false;
  gate.hits.push(now);
  return true;
}

/**
 * EGRESS LAW (owner 2026-10-04): no other users' Discord data — and no
 * email/PII of any kind — may ride the WAN leg to the owner's Gemini
 * surface. Mechanical backstop applied to every human-shaped string that
 * leaves through a tool response: emails, Discord mention/channel/role
 * tokens, and 7+ digit runs (snowflakes, phone-shaped numbers) are blanked
 * before the leak-shape scan and length cap.
 */
const EGRESS_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [/<@!?&?\d+>|<#\d+>/g, "[redacted-mention]"],
  [/\d{7,}/g, "[redacted-digits]"],
];

export function scrubForEgress(text: string): string {
  let t = String(text ?? "");
  for (const [re, sub] of EGRESS_PATTERNS) t = t.replace(re, sub);
  return t;
}

/** Excerpt hygiene at the WAN leg: leak-scan, egress scrub, cap length. */
export function safeExcerpt(text: string | undefined, max = 800): string {
  const t = String(text ?? "");
  if (!t || findLeakSignals(t).length > 0) return "";
  return scrubForEgress(t).slice(0, max);
}

/**
 * Spark tools may only surface THIS surface's records: an fp prefixed
 * "spark:" proves the record entered through this gateway. Phone-surface
 * records (and anything else) are indistinguishable misses — other
 * surfaces' content never rides out to Gemini, and miss vs foreign looks
 * identical so existence isn't leaked either.
 */
export function isSparkRecord(rec: PromptRecord | null): rec is PromptRecord {
  return Boolean(rec && typeof rec.fp === "string" && rec.fp.startsWith("spark:"));
}

export interface SparkDeps {
  spoolDir: string;
  fp: string;
  /** Injectable clock/status for tests. */
  statusFacts?: () => Record<string, unknown>;
}

/**
 * EGRESS LAW projection of watcher-state.json: machine telemetry ONLY —
 * counts, concurrency, timestamps, lane ok/pending. Names (bot usernames,
 * peer identities) and anything human-shaped are dropped before the fact
 * ever exists as a response payload.
 */
export function projectWatcherFacts(raw: unknown): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lane = (r.lane ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const iso = (v: unknown): string | null =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : null;
  return {
    service: "clankerchat-spark",
    activeRuns: num(r.active),
    queuedHuman: num(r.queued_human),
    queuedBot: num(r.queued_bot),
    maxConcurrent: num(r.max_concurrent),
    lastRunAt: iso(r.last_run_at),
    laneUp: lane.ok === true,
    lanePending: num(lane.pending),
    watcherStateAt: iso(r.updated),
    stale: iso(r.updated) === null, // no/bad snapshot → caller notes staleness
  };
}

function registerSparkTools(server: McpServer, deps: SparkDeps): void {
  const { spoolDir, fp } = deps;
  const statusFacts =
    deps.statusFacts ??
    (() => {
      // Machine-local snapshot from the watcher (atomic tmp+rename writer);
      // fresh for 180s, same window the dispatching peer serves it for.
      try {
        const raw = JSON.parse(readFileSync(`${spoolDir}/watcher-state.json`, "utf8"));
        const age = Date.now() - (statSync(`${spoolDir}/watcher-state.json`).mtimeMs ?? 0);
        return { ...projectWatcherFacts(raw), snapshotAgeSec: Math.max(0, Math.round(age / 1000)) };
      } catch {
        return { service: "clankerchat-spark", stale: true, note: "no watcher snapshot — status via ask_clanker if needed" };
      }
    });

  server.registerTool(
    "machine_status",
    {
      title: "Machine status",
      description:
        "This machine's gateway facts: run pool, queues, lane health, last run. Read-only machine data — nothing here is secret.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(statusFacts(), null, 1) }] }),
  );

  server.registerTool(
    "ask_clanker",
    {
      title: "Ask this machine's Claude gateway",
      description: [
        "Submit a prompt for the machine's Claude gateway. It runs as an owner-priority task;",
        "the answer posts in the machine's Discord channel and a short excerpt lands on the",
        "prompt record — poll `prompt_result` for it. Same channel the owner's phone app uses;",
        "the owner's terminal-confirmation laws are never waived by anything submitted here.",
        `Text max ${MAX_PROMPT_CHARS} chars. Secret-shaped or mass-mention text is refused at the door.`,
      ].join(" "),
      inputSchema: {
        text: z.string().min(1).max(MAX_PROMPT_CHARS).describe("The prompt, in the owner's voice."),
      },
    },
    async ({ text }) => {
      const t = String(text ?? "").trim();
      const leaks = findLeakSignals(t);
      if (leaks.length > 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `REFUSED: prompt looks secret-shaped (${leaks.join(", ")}) — rephrase without the secret.` }],
        };
      }
      if (findMassMentions(t).length > 0) {
        return {
          isError: true,
          content: [{ type: "text", text: massMentionRefusal() }],
        };
      }
      try {
        const rec = createPhonePrompt(spoolDir, { text: t, fp });
        return {
          content: [
            {
              type: "text",
              text: `submitted — prompt_id ${rec.promptId}. The run starts within ~15s; poll prompt_result with this id. The full answer also posts in the machine's #clankerchat Discord channel.`,
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `refused: ${(e as Error).message}` }],
        };
      }
    },
  );

  server.registerTool(
    "prompt_result",
    {
      title: "Poll a prompt's result",
      description:
        "Read back a prompt submitted via ask_clanker: status (pending/enqueued/answered/failed) plus the answer excerpt when terminal. Only prompts submitted through this surface exist here; excerpts are leak-scanned and PII-scrubbed before leaving this machine.",
      inputSchema: {
        prompt_id: z.string().regex(PROMPT_ID_RE).describe("The prompt_id returned by ask_clanker."),
      },
    },
    async ({ prompt_id }) => {
      const rec = getPrompt(spoolDir, String(prompt_id));
      // EGRESS LAW: only THIS surface's records are ever visible here. A
      // foreign record (phone surface, peer echo, anything else) answers
      // exactly like a miss — other surfaces' content never rides to Gemini,
      // and miss vs foreign is indistinguishable.
      if (!isSparkRecord(rec)) return { isError: true, content: [{ type: "text", text: "no such prompt_id" }] };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                promptId: rec.promptId,
                status: rec.status,
                exit: rec.exit ?? null,
                answerExcerpt: safeExcerpt(rec.answerExcerpt),
              },
              null,
              1,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_recent_prompts",
    {
      title: "Recent prompts on this surface",
      description:
        "The last few prompts submitted through this surface (newest first): id, status, excerpt when answered. Useful to pick up where a previous conversation left off. Other surfaces' prompts are not visible here.",
      inputSchema: {
        limit: z.number().int().min(1).max(10).optional().describe("How many (default 5, max 10)."),
      },
    },
    async ({ limit }) => {
      const rows = listPhonePrompts(spoolDir)
        .filter(isSparkRecord) // egress law: this surface's records only
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, Math.min(10, Number(limit ?? 5)))
        .map((r) => ({
          promptId: r.promptId,
          status: r.status,
          createdAt: new Date(r.createdAt).toISOString(),
          answerExcerpt: safeExcerpt(r.answerExcerpt),
        }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 1) }] };
    },
  );
}

/** Build the tool server (no network) — shared by main() and tests. */
export function buildSparkServer(deps: SparkDeps): McpServer {
  const server = new McpServer({ name: "clankerchat-spark", version: "0.1.0" });
  registerSparkTools(server, deps);
  return server;
}

export interface SparkGateConfig {
  capPath: string;
  token?: string;
}

/**
 * The HTTP listener: uniform dead-host 404 for everything that is not the
 * exact capability path with valid auth; stateless streamable-HTTP MCP for
 * what is. One transport+server per request (stateless pattern from the SDK
 * docs) — no session state to steal or pin.
 */
export function createSparkListener(
  gate: SparkGateConfig,
  deps: SparkDeps,
  rateGate: RateGate = { hits: [] },
  now: () => number = Date.now,
): http.RequestListener {
  const notFound: http.RequestListener = (req, res) => {
    res.writeHead(404, { "content-type": "text/plain", "x-robots-tag": "noindex, nofollow, noarchive" });
    res.end("not found");
  };
  return (req, res) => {
    try {
      // Request audit (diagnostics for client-connect debugging): one line
      // per request — method, whether the path matched, auth presence,
      // resulting status, UA class. NEVER the path or token values.
      const onPath = capabilityMatch(new URL(req.url ?? "/", "http://localhost").pathname, gate.capPath);
      const hadAuth = Boolean(req.headers.authorization);
      const ua = String(req.headers["user-agent"] ?? "?").slice(0, 48);
      res.on("finish", () => {
        console.log(
          `req: ${req.method} path=${onPath ? "cap" : "other"} auth=${hadAuth ? "y" : "n"} → ${res.statusCode} ua="${ua}"`,
        );
      });
      // Crawl posture (owner ask): every response — 404s and MCP alike —
      // carries noindex; headers set before the SDK writes merge into its
      // response. Real invisibility is the uniform 404; this is belt.
      res.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!capabilityMatch(url.pathname, gate.capPath)) return void notFound(req, res);
      if (!bearerOk(req.headers.authorization, gate.token)) return void notFound(req, res);
      if (!rateAllow(rateGate, now())) {
        res.writeHead(429, { "content-type": "text/plain" });
        res.end("slow down");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        // The SDK treats a provided parsedBody as ALREADY-PARSED (no JSON.parse
        // re-run) — hand it the object, never the raw Buffer.
        let parsed: unknown;
        try {
          parsed = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
          return;
        }
        void (async () => {
          // Stateless: fresh transport per request; sessionIdGenerator undefined
          // means the client must not rely on session ids (each POST standalone).
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const server = buildSparkServer(deps);
          res.on("close", () => void server.close().catch(() => {}));
          await server.connect(transport);
          await transport.handleRequest(req, res, parsed);
        })().catch(() => {
          if (!res.headersSent) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("bad request");
          } else res.end();
        });
      });
    } catch {
      return void notFound(req, res);
    }
  };
}

export async function main(): Promise<void> {
  loadEnvFile();
  const capPath = process.env.SPARK_MCP_PATH?.trim();
  const token = process.env.SPARK_MCP_TOKEN?.trim() || undefined;
  // Same empty-string law as botlink parsePort (audit round 3, finding 3):
  // Number("") === 0 would silently bind an ephemeral port; whitespace-only
  // or non-numeric falls back to the default instead of NaN at listen().
  const portSpec = process.env.SPARK_MCP_PORT?.trim();
  const portNum = portSpec === undefined ? SPARK_DEFAULT_PORT : Number(portSpec);
  const port = Number.isFinite(portNum) && portNum >= 0 && portNum < 65536 ? portNum : SPARK_DEFAULT_PORT;
  const spoolDir = process.env.CLANKER_SPOOL_DIR ?? `${process.cwd()}/botlink-spool`;
  if (!capPath || capPath.length < 16) {
    throw new Error("SPARK_MCP_PATH missing/too short in .env — generate 16+ bytes of hex; refusing to start open");
  }
  const fp = sparkFp(token, capPath);
  const listener = createSparkListener({ capPath, token }, { spoolDir, fp });
  const srv = http.createServer(listener);
  // 127.0.0.1 ONLY: the public leg is the owner's named Cloudflare Tunnel,
  // which proxies from localhost. Nothing on this socket answers the LAN/WAN.
  await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));
  console.log(`spark-mcp: listening on 127.0.0.1:${port} (capability path configured, ${token ? "bearer on" : "path-only"}) — fp ${fp}`);
  const shutdown = () => void srv.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1]?.endsWith("spark-mcp.js")) {
  void main().catch((e) => {
    console.error("spark-mcp fatal:", (e as Error).message);
    process.exit(1);
  });
}
