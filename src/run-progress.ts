/**
 * run-progress.ts — long-run visibility helpers (owner request 2026-10-04,
 * Joe: "better status updates when working for a long time").
 *
 * Two signals, deliberately zero-noise:
 *   1. TYPING heartbeat — the run machinery calls channel.sendTyping() every
 *      TYPING_BEAT_MS while a run is alive; Discord renders its native
 *      "is typing…" line, no message is ever posted.
 *   2. STATUS LINE — one editable message that exists only past
 *      STATUS_AFTER_MS of elapsed run time. It is EDITED in place on each
 *      STATUS_EDIT_MS boundary (never re-posted) and deleted by the run's
 *      finish path, so the answer post supersedes it. A run that finishes
 *      fast never produces one.
 *
 * Pure functions only — the posting/editing/typing I/O is per-machine run
 * wiring (watcher our side, daemon theirs); both import these so the
 * thresholds and line shape stay identical across machines.
 */

/** Typing indicator TTL is 10s; 8s keeps it continuous without spam. */
export const TYPING_BEAT_MS = 8_000;

/** Runs under 4 minutes are "normal" — no status line at all. */
export const STATUS_AFTER_MS = 4 * 60_000;

/** Once the status line exists, refresh it every 5 minutes. */
export const STATUS_EDIT_MS = 5 * 60_000;

/** True when a status line should exist for a run this old. */
export function shouldHaveStatusLine(elapsedMs: number): boolean {
  return elapsedMs >= STATUS_AFTER_MS;
}

/**
 * The status line's text at a given elapsed time. Minutes, rounded down,
 * floor 1 so the first edit never reads "0m".
 */
export function statusLine(label: string, elapsedMs: number): string {
  const mins = Math.max(1, Math.floor(elapsedMs / 60_000));
  const who = label ? `${label}: ` : "";
  return `⏳ ${who}still working — ${mins}m elapsed (answer lands here when the run finishes)`;
}

/**
 * Delay (ms) until the next lifecycle action for the status line, given the
 * run's age — the run loop sleeps this long between checks:
 *   - before STATUS_AFTER_MS: time until the line should appear
 *   - after: time until the next in-place edit
 * Always >= 1s so a caller can never spin.
 */
export function nextStatusDelayMs(elapsedMs: number): number {
  if (elapsedMs < STATUS_AFTER_MS) return STATUS_AFTER_MS - elapsedMs;
  const intoCycle = (elapsedMs - STATUS_AFTER_MS) % STATUS_EDIT_MS;
  return Math.max(1_000, STATUS_EDIT_MS - intoCycle);
}
