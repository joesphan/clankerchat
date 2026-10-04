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
 *
 * Secrets live in .env (SPARK_MCP_TOKEN, SPARK_MCP_PATH) — values are
 * never logged; the fp provenance string carries only a hash head.
 */

import { createHash, timingSafeEqual } from "node:crypto";
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

/** Excerpt hygiene at the WAN leg: blank anything leak-shaped, cap length. */
export function safeExcerpt(text: string | undefined, max = 800): string {
  const t = String(text ?? "");
  if (!t || findLeakSignals(t).length > 0) return "";
  return t.slice(0, max);
}

export interface SparkDeps {
  spoolDir: string;
  fp: string;
  /** Injectable clock/status for tests. */
  statusFacts?: () => Record<string, unknown>;
}

function registerSparkTools(server: McpServer, deps: SparkDeps): void {
  const { spoolDir, fp } = deps;
  const statusFacts =
    deps.statusFacts ??
    (() => ({
      service: "clankerchat-spark",
      note: "watcher-state.json not read in this build — status via the ask path if needed",
    }));

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
        "Read back a prompt submitted via ask_clanker: status (pending/enqueued/answered/failed) plus the answer excerpt when terminal. Excerpts are leak-scanned before leaving this machine.",
      inputSchema: {
        prompt_id: z.string().regex(PROMPT_ID_RE).describe("The prompt_id returned by ask_clanker."),
      },
    },
    async ({ prompt_id }) => {
      const rec = getPrompt(spoolDir, String(prompt_id));
      if (!rec) return { isError: true, content: [{ type: "text", text: "no such prompt_id" }] };
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
        "The last few prompt records (newest first): id, status, excerpt when answered. Useful to pick up where a previous conversation left off.",
      inputSchema: {
        limit: z.number().int().min(1).max(10).optional().describe("How many (default 5, max 10)."),
      },
    },
    async ({ limit }) => {
      const rows = listPhonePrompts(spoolDir)
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
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
  return (req, res) => {
    try {
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
  const port = Number(process.env.SPARK_MCP_PORT ?? SPARK_DEFAULT_PORT);
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
