// promptmeter — measures Claude-code plan PROMPT usage on this machine.
//
// Tyler's plan bills by PROMPT COUNT (z.ai legacy v1 max: ~1600 prompts per
// 5-hour window, no weekly cap), not tokens. Every user turn in every session
// — interactive, headless (-p), hook-spawned, or another session's relayed
// message — draws from that one pool. This module is the meter: it streams
// ~/.claude/projects/**\/*.jsonl transcripts (mtime-filtered) and counts REAL
// user turns in a sliding window, separates sidechain (subagent) messages,
// and flags the headless-spawn pattern (many tiny sessions in one project)
// that caused the 2026-10-05 remember-plugin storm (422 of 570 prompts, 74%
// of a window, from ~105 four-turn summarizer sessions firing every ~2 min).
//
// Laws baked in:
// - ZERO PROMPT COST: pure filesystem scan, no LLM anywhere. The watcher
//   sweeps it on a timer and publishes to watcher-state.json + the phone
//   notice registry — surfaces that cost nothing.
// - A "turn" = a user-type transcript entry that is NOT a tool_result and
//   NOT a sidechain message (subagent chatter is counted separately: whether
//   the provider bills sidechains is unknown, so report both, gate on turns).
// - STREAM + MTIME FILTER: transcripts here reach 600MB+; readFileSync dies
//   (ERR_STRING_TOO_LONG >512MB) and idle files are skipped without opening.
// - FAIL-QUIET: any per-file error degrades to "that file contributes 0" —
//   a meter must never take the watcher down.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface PromptProjectRow {
  project: string;
  turns: number;
  sidechain: number;
  sessions: number;
}

export interface PromptWindowStats {
  now: number;
  windowMs: number;
  cap: number;
  /** Primary user turns in window (all projects). */
  turns: number;
  /** Sidechain (subagent) messages in window, reported separately. */
  sidechain: number;
  /** Compaction summaries in window (type:user + isCompactSummary — the
   *  summarization is a model call, so it LIKELY bills; reported separately
   *  so dashboard reconciliation can attribute it. Not gated: unknown till
   *  Experiment A lands. */
  compact: number;
  burnPerHour: number;
  pctOfCap: number;
  /** True when pctOfCap >= softPct — the watcher's bot-class spawn gate arms. */
  hot: boolean;
  /** True inside the CLAIMED provider peak window (06:00–10:00 UTC, flag-only:
   *  the 3x/2x multiplier is unverified until owner dashboard reconciliation —
   *  do NOT change cap math on this flag alone). */
  peak: boolean;
  /** Ms until the oldest counted TURN ages out of the window (the next
   *  capacity return on the gating counter), or null when turns === 0. */
  replenishInMs: number | null;
  byProject: PromptProjectRow[];
  /** Projects showing the headless-spawn pattern (>=5 sessions, avg <=6 turns). */
  spamSuspects: string[];
  /** Distinct session files that contributed turns (storm-size indicator). */
  activeSessions: number;
}

export interface PromptMeterOptions {
  /** Transcript root (default ~/.claude/projects). */
  projectsRoot?: string;
  /** Sliding window length (default 5h). */
  windowMs?: number;
  /** Plan cap per window (default 1600). */
  cap?: number;
  /** Gate threshold fraction (default 0.85). */
  softPct?: number;
  /** Max project rows kept (default 8). */
  topN?: number;
  /** Override clock for tests. */
  now?: number;
}

/** Human-readable one-liner for status cards: "prompts 87/1600 (5%) · 17/hr · +1@02:15Z". */
export function promptsLine(s: PromptWindowStats): string {
  const pct = (100 * s.turns / Math.max(1, s.cap)).toFixed(1);
  const burn = s.burnPerHour >= 10 ? Math.round(s.burnPerHour) : s.burnPerHour.toFixed(1);
  const repl =
    s.replenishInMs !== null ? ` · +1@${new Date(s.now + s.replenishInMs).toISOString().slice(11, 16)}Z` : "";
  const peak = s.peak ? " · peak" : "";
  const hot = s.hot ? " · HOT (bot spawns gated)" : "";
  return `prompts ${s.turns}/${s.cap} (${pct}%) · ${burn}/hr${repl}${peak}${hot}`;
}

interface FileAcc {
  turns: number;
  sidechain: number;
  compact: number;
  /** Earliest counted TURN timestamp in this file (replenish projection). */
  oldestTurnTs: number | null;
}

async function scanFile(p: string, since: number): Promise<FileAcc> {
  const acc: FileAcc = { turns: 0, sidechain: 0, compact: 0, oldestTurnTs: null };
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(p, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line: string) => {
      if (!line.includes('"type":"user"')) return;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (o?.type !== "user") return;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (Number.isNaN(ts) || ts < since) return;
      const c = o.message?.content;
      if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return;
      if (o.isCompactSummary) acc.compact++;
      else if (o.isSidechain) acc.sidechain++;
      else {
        acc.turns++;
        if (acc.oldestTurnTs === null || ts < acc.oldestTurnTs) acc.oldestTurnTs = ts;
      }
    });
    await new Promise<void>((resolve) => {
      rl.on("close", () => resolve());
      rl.on("error", () => resolve()); // torn tail mid-write — keep what we counted
    });
  } catch {
    /* unreadable file contributes nothing */
  }
  return acc;
}

/** Scan transcripts and return window stats. Never throws. */
export async function scanPromptUsage(opts: PromptMeterOptions = {}): Promise<PromptWindowStats> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 5 * 3600 * 1000;
  const cap = opts.cap ?? 1600;
  const softPct = opts.softPct ?? 0.85;
  const topN = opts.topN ?? 8;
  const root = opts.projectsRoot ?? path.join(process.env.HOME ?? "/home/tyler", ".claude", "projects");
  const since = now - windowMs;

  const byProject = new Map<string, PromptProjectRow>();
  let turns = 0;
  let sidechain = 0;
  let compact = 0;
  let oldestTurnTs: number | null = null;
  let activeSessions = 0;

  try {
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of names) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(dir, f);
        try {
          if (fs.statSync(p).mtimeMs < since) continue; // idle in the window — never open it
        } catch {
          continue;
        }
        const acc = await scanFile(p, since);
        if (acc.turns === 0 && acc.sidechain === 0 && acc.compact === 0) continue;
        turns += acc.turns;
        sidechain += acc.sidechain;
        compact += acc.compact;
        if (acc.oldestTurnTs !== null && (oldestTurnTs === null || acc.oldestTurnTs < oldestTurnTs)) {
          oldestTurnTs = acc.oldestTurnTs;
        }
        activeSessions++;
        const row = byProject.get(proj) ?? { project: proj, turns: 0, sidechain: 0, sessions: 0 };
        row.turns += acc.turns;
        row.sidechain += acc.sidechain;
        row.sessions++;
        byProject.set(proj, row);
      }
    }
  } catch {
    /* projects root unreadable — report the zeros we have */
  }

  const rows = [...byProject.values()].sort((a, b) => b.turns + b.sidechain - a.turns - a.sidechain);
  const spamSuspects = rows
    .filter((r) => r.sessions >= 5 && (r.turns + r.sidechain) / r.sessions <= 6)
    .map((r) => `${r.project} (${r.sessions} sessions, ${r.turns} turns)`);
  const pctOfCap = turns / Math.max(1, cap);
  const hourUtc = new Date(now).getUTCHours();
  return {
    now,
    windowMs,
    cap,
    turns,
    sidechain,
    compact,
    burnPerHour: turns / (windowMs / 3600_000),
    pctOfCap,
    hot: pctOfCap >= softPct,
    peak: hourUtc >= 6 && hourUtc < 10,
    replenishInMs: oldestTurnTs !== null ? oldestTurnTs + windowMs - now : null,
    byProject: rows.slice(0, topN),
    spamSuspects,
    activeSessions,
  };
}
