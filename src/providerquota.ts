// providerquota — reads the VENDOR's own 5h-window quota meter (z.ai monitor
// API): the near-real-time ground truth beside the local prompt proxy.
//
// Round 24.2 shipped the card's quotaLine slot; this module is the
// machine-local PRODUCER (the peer runs his own poller — same split as
// promptmeter, round 23). Endpoint map + raw-type law come from the vendor's
// glm-plan-usage plugin, audited 2026-10-05 before first run (provenance:
// vendor/glm-plan-usage-0.0.1/, sha256 361ba928ff9d…e590).
//
// Laws baked in:
// - RAW TYPES ONLY: the wire sends limits[].type = "TOKENS_LIMIT" /
//   "TIME_LIMIT" — the plugin's "Token usage(5 Hour)" is its DISPLAY rename.
//   Match the raw string or you parse null (first-try mistake on both sides).
// - quota/limit % is the only near-real-time signal; model-usage totals lag
//   ~10 min and bucket hourly (the vendor dashboard says so itself) — they
//   ride along as context, never as alarm fuel.
// - nextResetTime (ms epoch) rides the SAME limit entry; published as
//   reset_at. Whether it slides forward as usage continues (rolling TTL vs
//   fixed window) is the open calibration question — answered passively by
//   the row series in watcher-state.json, not by polling harder.
// - CREDENTIALS: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN from env, falling
//   back to the ~/.claude/settings.json env block (this box's single auth
//   source). The token goes ONLY into the Authorization header of GETs to
//   the allowlisted vendor origin (api.z.ai / open.bigmodel.cn /
//   dev.bigmodel.cn) — never logged, never written, never sent elsewhere.
// - FAIL-QUIET: null on any miss. A meter must never take the watcher down,
//   and absent-pre-poll renders no card line, never a fake zero.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProviderQuota {
  now: number;
  /** TOKENS_LIMIT percentage — the shared plan's 5h window, both machines. */
  pct5h: number;
  /** nextResetTime as ISO, or null when the vendor omits it. */
  resetAt: string | null;
  /** TIME_LIMIT percentage (MCP monthly pool), or null. */
  mcpPct: number | null;
  /** model-usage window totals (lag ~10 min) — context only, or nulls. */
  calls24h: number | null;
  tokens24h: number | null;
}

/** Card one-liner: "5h quota 24% (15770 calls/24h · 2373M tok · reset 09:10Z)". */
export function quotaLine(q: ProviderQuota): string {
  const ctx: string[] = [];
  if (q.calls24h !== null && q.tokens24h !== null) {
    ctx.push(`${q.calls24h} calls/24h · ${Math.round(q.tokens24h / 1_000_000)}M tok`);
  }
  if (q.resetAt !== null) {
    ctx.push(`reset ${new Date(q.resetAt).toISOString().slice(11, 16)}Z`);
  }
  return `5h quota ${Math.round(q.pct5h)}%${ctx.length ? ` (${ctx.join(" · ")})` : ""}`;
}

/** Parse the two vendor payloads into stats. Returns null when the 5h limit
 *  entry is missing (the one field that makes the poll worth making). */
export function parseQuota(
  now: number,
  quotaJson: { limits?: Array<{ type?: string; percentage?: number; nextResetTime?: number }> },
  modelJson?: { totalUsage?: { totalModelCallCount?: number; totalTokensUsage?: number } },
): ProviderQuota | null {
  const limits = Array.isArray(quotaJson?.limits) ? quotaJson.limits : [];
  const tokens = limits.find((l) => l?.type === "TOKENS_LIMIT");
  if (!tokens || typeof tokens.percentage !== "number") return null;
  const mcp = limits.find((l) => l?.type === "TIME_LIMIT");
  return {
    now,
    pct5h: tokens.percentage,
    resetAt:
      typeof tokens.nextResetTime === "number" && tokens.nextResetTime > 0
        ? new Date(tokens.nextResetTime).toISOString()
        : null,
    mcpPct: typeof mcp?.percentage === "number" ? mcp.percentage : null,
    calls24h: modelJson?.totalUsage?.totalModelCallCount ?? null,
    tokens24h: modelJson?.totalUsage?.totalTokensUsage ?? null,
  };
}

const ALLOWED_HOSTS = ["api.z.ai", "open.bigmodel.cn", "dev.bigmodel.cn"];

// Round 27d: a reset_at discontinuity between consecutive polls is a natural
// experiment the quota fit consumes — how much of the 5h window actually
// drains when the vendor's anchor fires. Classification is repo-side (both
// machines want the same verdict); journal/notice glue is host-local.

export interface QuotaSnapshot {
  pct5h: number | null;
  resetAt: string | null;
}

export interface ResetEvent {
  oldPct: number;
  newPct: number;
  /** Points of quota drained across the reset (old − new). */
  drainPts: number;
  oldResetAt: string;
  newResetAt: string;
  /** How far the anchor moved. ~5h jump after a frozen stretch = fixed
   *  cadence; continuous sliding = rolling. Negative = vendor quirk, recorded. */
  jumpMs: number;
  /** emptied = window drained to near-zero (fixed-anchor behavior);
   *  partial = only the aged-out share left (rolling behavior). A machine
   *  burning THROUGH the reset refills instantly — the label is the
   *  observation, the jumpMs is the discriminator. */
  verdict: "emptied" | "partial";
}

/** Null when nothing changed or either side lacks the fields — a missing
 *  prev (boot, first poll) is never a false event. */
export function describeResetEvent(prev: QuotaSnapshot | null, next: QuotaSnapshot | null): ResetEvent | null {
  if (!prev || !next) return null;
  if (typeof prev.pct5h !== "number" || typeof next.pct5h !== "number") return null;
  if (!prev.resetAt || !next.resetAt || prev.resetAt === next.resetAt) return null;
  const jumpMs = Date.parse(next.resetAt) - Date.parse(prev.resetAt);
  // An unparseable resetAt string (vendor shape drift) is a non-event, not a
  // NaN jump that reaches the journal as "+NaNh" (r28 L6).
  if (!Number.isFinite(jumpMs)) return null;
  // Real fires are +5h jumps. A vendor anchor SLIDE (minutes per poll — the
  // dead rolling hypothesis) must not turn every 10-min poll into a journal +
  // phone event flood (r28 L7); under sliding, q_pct simply never empties,
  // which is the honest signal.
  if (Math.abs(jumpMs) < 3_600_000) return null;
  return {
    oldPct: prev.pct5h,
    newPct: next.pct5h,
    drainPts: prev.pct5h - next.pct5h,
    oldResetAt: prev.resetAt,
    newResetAt: next.resetAt,
    jumpMs,
    verdict: next.pct5h <= 5 ? "emptied" : "partial",
  };
}

/** One line for the journal + phone notice — facts first, quick read second,
 *  so the watcher and daemon flavors never drift in interpretation. */
export function resetEventLine(e: ResetEvent): string {
  const h = (iso: string) => `${iso.slice(11, 16)}Z`;
  return (
    `5h window reset ${h(e.oldResetAt)}→${h(e.newResetAt)} (${e.jumpMs >= 0 ? "+" : ""}${(e.jumpMs / 3_600_000).toFixed(1)}h): ` +
    `q_pct ${Math.round(e.oldPct)}→${Math.round(e.newPct)} — ` +
    (e.verdict === "emptied" ? "window emptied (fixed-anchor behavior)" : "partial drain (rolling behavior)")
  );
}

export interface ProviderQuotaOptions {
  /** Override clock for tests. */
  now?: number;
  /** Override credential sourcing (tests / non-standard deploy). */
  baseUrl?: string;
  token?: string;
}

/** Env first, then the settings.json env block — names only ever in logs. */
function resolveCreds(
  opts: ProviderQuotaOptions,
): { origin: string; token: string } | null {
  let baseUrl = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "";
  let token = opts.token ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
  if (!baseUrl || !token) {
    try {
      const settings = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"),
      );
      baseUrl = baseUrl || settings?.env?.ANTHROPIC_BASE_URL || "";
      token = token || settings?.env?.ANTHROPIC_AUTH_TOKEN || "";
    } catch {
      /* no settings file — env was the only chance */
    }
  }
  if (!baseUrl || !token) return null;
  let origin: string;
  try {
    const u = new URL(baseUrl);
    if (!ALLOWED_HOSTS.some((h) => u.host === h)) return null;
    origin = u.origin;
  } catch {
    return null;
  }
  return { origin, token };
}

/** Poll both vendor endpoints once. Never throws — null on any miss. */
export async function pollProviderQuota(opts: ProviderQuotaOptions = {}): Promise<ProviderQuota | null> {
  const creds = resolveCreds(opts);
  if (!creds) return null;
  const get = async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
      headers: { Authorization: creds.token, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    // model-usage wants a startTime/endTime window ("yyyy-MM-dd HH:mm:ss",
    // local-shape like the vendor script): yesterday@HH → today@HH.
    const now = opts.now ?? Date.now();
    const d = new Date(now);
    const fmt = (x: Date) =>
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")} ` +
      `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}:${String(x.getSeconds()).padStart(2, "0")}`;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, d.getHours(), 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 59, 59, 999);
    const q = `startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`;
    const [quotaJson, modelJson] = await Promise.all([
      get(`${creds.origin}/api/monitor/usage/quota/limit`),
      get(`${creds.origin}/api/monitor/usage/model-usage?${q}`).catch(() => null), // context only
    ]);
    return parseQuota(now, quotaJson as never, (modelJson ?? undefined) as never);
  } catch {
    return null; // fail-quiet — absent reads as "not measured", never fake
  }
}
