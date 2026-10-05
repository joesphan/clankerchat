import fs from "node:fs";
import path from "node:path";
import { findLeakSignals } from "./leaks.js";

// Phone-originated owner prompts (round 5, 2026-10-04): the enrolled phone can
// APPROVE asks (round 4) and commit key rotations; this file adds the same
// trust class in the other direction — STARTING work from the pocket. The
// phone surface WRITES a prompt record and never delivers it: the gateway
// watcher's 15s sweep claims it (stampPromptEnqueued, exactly-once, the same
// claim-ticket shape as ask decisions) and enqueues an owner-priority run.
// The answer's VENUE is Discord (the owner's app push-notifies); the phone
// polls status, plus a short EXCERPT of the run's post (round 5.1) so the
// pocket view closes without leaving the app. The excerpt is data rendered
// as text — never instructions — same framing law as everything else on
// this surface.

export type PhonePromptStatus = "pending" | "enqueued" | "answered" | "failed" | "expired";

export interface PromptRecord {
  promptId: string;
  /** The owner's text, verbatim (trimmed, hard-capped). Untrusted-echo rules
   *  apply when the watcher renders it into a trigger — same as any Discord
   *  content. Provenance of the CREATOR is the signing key, not the text. */
  text: string;
  /** Creator provenance: the enrolled phone's fingerprint (never a
   *  self-reported name). */
  fp: string;
  /** Multi-machine routing hint (phase 1, docs/context/topics/
   *  multi-machine-prompts.md): "peer" = the PEER machine runs this prompt;
   *  the record stays HERE and the outcome echoes back over the lane.
   *  Absent = this machine runs it (default, back-compat). */
  route?: "peer";
  createdAt: number;
  status: PhonePromptStatus;
  /** Watcher claim stamp — set once, exactly-once. */
  enqueuedAt?: number;
  finishedAt?: number;
  /** Orchestrator run exit code (terminal records only). */
  exit?: number;
  /** Did the run post in Discord before exiting (terminal records only). */
  posted?: boolean;
  /** Whitespace-collapsed, hard-capped tail of the run's last own-post
   *  (terminal records only; convenience preview — Discord is the record). */
  answerExcerpt?: string;
}

/** Pending prompts rot after 15 minutes: the sweep claims within 15s when the
 *  watcher is alive, so anything still pending that long means the delivery
 *  machinery is down — the record says so on the phone instead of hanging. */
export const PROMPT_TTL_MS = 15 * 60 * 1000;
/** Routed prompts (route:"peer") get a wider window — decided 2026-10-04,
 *  owner-delegated (channel post 1556355104607707247): the 15-min local claim
 *  window plus lane round-trip margin (peer queue wait + their 10-min run +
 *  the outcome echo). One budget for the WHOLE lifecycle: pending past it
 *  expires; enqueued past it fails honestly (the peer's emit never came). */
export const ROUTED_PROMPT_TTL_MS = 30 * 60 * 1000;
/** promptIds are filename-derived (`pmt` + 8 lowercase here) but lane echoes
 *  carry caller-chosen ids — anything that could dodge a path component is
 *  refused before it reaches the filesystem. */
export const PROMPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Thumb-mash guard: the phone queue holds a handful of in-flight prompts,
 *  not an unbounded scroll. Finished records never count against this. */
export const MAX_PENDING_PROMPTS = 5;
export const MAX_PROMPT_CHARS = 2000;
/** Phone-side answer preview cap — a chip, not a mirror. */
export const MAX_EXCERPT_CHARS = 800;

export function promptsDir(spoolDir: string): string {
  return path.join(spoolDir, "pending-prompts");
}
function promptFile(spoolDir: string, promptId: string): string {
  return path.join(promptsDir(spoolDir), `${promptId}.json`);
}

function newPromptId(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)];
  return `pmt${s}`;
}

function writePrompt(spoolDir: string, rec: PromptRecord): void {
  const file = promptFile(spoolDir, rec.promptId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 1) + "\n");
  fs.renameSync(tmp, file);
}

/** Create a pending prompt from the signed phone surface. Text is trimmed and
 *  hard-capped (not rejected — a thumb that overruns still means something).
 *  `route:"peer"` marks the PEER machine as the runner (phase 1) — anything
 *  else in that field is refused, not silently ignored (the phone must never
 *  believe a prompt routed somewhere it didn't). Throws when the pending
 *  queue is full (the route maps that to 429). */
export function createPhonePrompt(
  spoolDir: string,
  input: { text: string; fp: string; route?: "peer" },
): PromptRecord {
  const text = String(input.text ?? "").trim().slice(0, MAX_PROMPT_CHARS);
  if (!text) throw new Error("empty prompt");
  if (typeof input.fp !== "string" || !input.fp) throw new Error("missing phone fingerprint");
  if (input.route !== undefined && input.route !== "peer") {
    throw new Error(`unknown route "${String(input.route).slice(0, 16)}" — only "peer" is routable`);
  }
  const pending = listPhonePrompts(spoolDir).filter((r) => r.status === "pending" || r.status === "enqueued");
  if (pending.length >= MAX_PENDING_PROMPTS) {
    throw new Error(`prompt queue full (${MAX_PENDING_PROMPTS} in flight) — wait for one to finish`);
  }
  const rec: PromptRecord = {
    promptId: newPromptId(),
    text,
    fp: input.fp,
    ...(input.route === "peer" ? { route: "peer" as const } : {}),
    createdAt: Date.now(),
    status: "pending",
  };
  fs.mkdirSync(promptsDir(spoolDir), { recursive: true });
  writePrompt(spoolDir, rec);
  return rec;
}

export function getPrompt(spoolDir: string, promptId: string): PromptRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(promptFile(spoolDir, promptId), "utf8"));
    return typeof raw?.promptId === "string" ? (raw as PromptRecord) : null;
  } catch {
    return null;
  }
}

export function listPhonePrompts(spoolDir: string): PromptRecord[] {
  try {
    return fs
      .readdirSync(promptsDir(spoolDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => getPrompt(spoolDir, f.replace(/\.json$/, "")))
      .filter((r): r is PromptRecord => r !== null)
      .sort((a, b) => a.createdAt - b.createdAt || (a.promptId < b.promptId ? -1 : 1));
  } catch {
    return [];
  }
}

/** History window for the phone's "load older" (round 7): the newest
 *  `limit` records older than the cursor, plus whether anything older still
 *  exists — the caller renders the button or the end-of-history line. List
 *  must be the registry order (asc, promptId tiebreak — the same order the
 *  cursor compares by).
 *
 *  Composite cursor since audit round 4 (finding B6): a createdAt-only
 *  strict `<` made a same-millisecond twin at a page boundary permanently
 *  unreachable — the cursor equals the shared createdAt and every later
 *  page excluded the cut twin. With beforeId the cursor tie-breaks on
 *  promptId exactly like the sort, so paging always makes progress; without
 *  it (older bundles) the comparison stays the legacy strict `<`. */
export function historyWindow(
  list: PromptRecord[],
  before: number,
  limit = 20,
  beforeId?: string,
): { records: PromptRecord[]; more: boolean } {
  const older = list.filter(
    (r) =>
      r.createdAt < before ||
      (beforeId !== undefined && r.createdAt === before && r.promptId < beforeId),
  );
  const clamped = Math.max(1, Math.min(50, limit));
  const records = older.slice(-clamped);
  return { records, more: older.length > records.length };
}

/** A record's rot deadline: routed prompts carry the 30-min lane round-trip
 *  budget, local ones the 15-min claim window. */
function rotDeadline(rec: PromptRecord): number {
  return rec.createdAt + (rec.route === "peer" ? ROUTED_PROMPT_TTL_MS : PROMPT_TTL_MS);
}

/** Records the watcher has not yet claimed: pending and not past TTL. */
export function listClaimablePrompts(spoolDir: string, now = Date.now()): PromptRecord[] {
  return listPhonePrompts(spoolDir).filter((r) => r.status === "pending" && rotDeadline(r) > now);
}

/** The watcher's claim ticket: pending → enqueued, exactly once. Null when
 *  the record is missing OR already claimed — only one caller ever proceeds
 *  per prompt, however many sweeps race (same shape as stampAskEnqueued). */
export function stampPromptEnqueued(spoolDir: string, promptId: string): PromptRecord | null {
  const rec = getPrompt(spoolDir, promptId);
  if (!rec || rec.status !== "pending") return null;
  const next: PromptRecord = { ...rec, status: "enqueued", enqueuedAt: Date.now() };
  writePrompt(spoolDir, next);
  return next;
}

/** Terminal stamp from the run-exit hook: enqueued → answered/failed. Exit 0
 *  without a post is legitimate protocol silence ("reply nothing and exit"),
 *  so the code decides the status; `posted` rides along for the record.
 *  `excerpt` (optional) is the run's last own-post, whitespace-collapsed and
 *  capped here — the writer's shape is not trusted for display hygiene.
 *
 *  Late-finish overwrite (2026-10-04 audit): a record the stuck sweep already
 *  failed (failed + exit −1 — that stamp is unique to sweepStuckEnqueued; a
 *  real spawn-error exit ALSO writes −1 but through THIS function, which is
 *  once-per-run) is OVERWRITTEN by the real outcome if the run lands after
 *  the 20-min boundary. The run finishing is a fact; the record should say
 *  what actually happened, not what the timeout guessed. Genuinely failed
 *  records with a real exit code are final — null, no overwrite. */
export function finishPrompt(
  spoolDir: string,
  promptId: string,
  outcome: { exit: number; posted: boolean; excerpt?: string },
): PromptRecord | null {
  const rec = getPrompt(spoolDir, promptId);
  if (!rec) return null;
  const stuckSweepGuessed =
    rec.status === "failed" && rec.exit === -1 && !rec.answerExcerpt;
  if (rec.status !== "enqueued" && !stuckSweepGuessed) return null;
  const excerpt = String(outcome.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
  const next: PromptRecord = {
    ...rec,
    status: outcome.exit === 0 ? "answered" : "failed",
    finishedAt: Date.now(),
    exit: outcome.exit,
    posted: outcome.posted,
    ...(excerpt ? { answerExcerpt: excerpt } : {}),
  };
  writePrompt(spoolDir, next);
  return next;
}

/** Receive-side outcome echo (phase 1): the PEER machine ran a routed prompt
 *  and reported {promptId, exit, posted, excerpt} over the lane. The daemon
 *  verified shape at the door and landed it as a file; THIS function is the
 *  watcher's apply step. Guards, in order: the id is shape-safe (never a
 *  path component), the record exists, and it is a ROUTED record still in
 *  flight (or a stuck-sweep guess — a late real outcome wins, same law as
 *  local runs). A LOCAL record is untouchable from the lane: its outcome
 *  only ever comes from this machine's own run-exit hook. Registry miss or
 *  wrong class → null, caller drops + journals — the echo only ever touches
 *  a record WE created for routing. The excerpt is phone DISPLAY data and
 *  leak-shape-checked here (defense in depth past the daemon's door check);
 *  on trip the phone gets no preview, not the secret. */
export function applyPeerPromptOutcome(
  spoolDir: string,
  outcome: { promptId: string; exit: number; posted: boolean; excerpt?: string },
): PromptRecord | null {
  if (typeof outcome.promptId !== "string" || !PROMPT_ID_RE.test(outcome.promptId)) return null;
  const rec = getPrompt(spoolDir, outcome.promptId);
  if (!rec || rec.route !== "peer") return null;
  const rawExcerpt = String(outcome.excerpt ?? "");
  const excerpt = rawExcerpt && findLeakSignals(rawExcerpt).length === 0 ? rawExcerpt : "";
  return finishPrompt(spoolDir, outcome.promptId, {
    exit: Number.isInteger(outcome.exit) ? outcome.exit : -1,
    posted: outcome.posted === true,
    excerpt,
  });
}

/** Rot overdue pending prompts to expired (delivery machinery down — say so
 *  on the phone instead of hanging a spinner forever). */
export function sweepExpiredPrompts(spoolDir: string, now = Date.now()): PromptRecord[] {
  const swept: PromptRecord[] = [];
  for (const rec of listPhonePrompts(spoolDir)) {
    if (rec.status === "pending" && rotDeadline(rec) <= now) {
      const next: PromptRecord = { ...rec, status: "expired", finishedAt: now };
      try {
        writePrompt(spoolDir, next);
        swept.push(next);
      } catch {
        /* unreadable — next sweep retries */
      }
    }
  }
  return swept;
}

/** An ENQUEUED record whose run never fired its exit hook (queue-overflow
 *  drop, watcher crash between claim and exit, spawn failure) would hang the
 *  phone's chip on "running" forever — every other sweep only touches
 *  PENDING records, so "enqueued" is a one-way door whose only key is a live
 *  run. RUN_TIMEOUT is 10min; 20min covers queue wait on top. ROUTED records
 *  instead rot on the whole-lifecycle budget (their "run" is a lane
 *  round-trip: peer queue + their 10-min run + the outcome echo — 20 min
 *  would cut off a healthy peer behind one queued job). A late echo can
 *  still overwrite the guess (finishPrompt's late-finish path). Rotates to
 *  failed so the phone says "ask again" instead of spinning. */
export const STUCK_ENQUEUED_MS = 20 * 60 * 1000;
export function sweepStuckEnqueued(spoolDir: string, now = Date.now()): PromptRecord[] {
  const swept: PromptRecord[] = [];
  for (const rec of listPhonePrompts(spoolDir)) {
    const deadline =
      rec.route === "peer" ? rotDeadline(rec) : (rec.enqueuedAt ?? rec.createdAt) + STUCK_ENQUEUED_MS;
    if (rec.status === "enqueued" && deadline <= now) {
      const next: PromptRecord = { ...rec, status: "failed", finishedAt: now, exit: -1 };
      try {
        writePrompt(spoolDir, next);
        swept.push(next);
      } catch {
        /* unreadable — next sweep retries */
      }
    }
  }
  return swept;
}

/** Hygiene sweep (2026-10-04 audit): delete TERMINAL prompt records older
 *  than keepMs (default 7 days). Same class as sweepTerminalAsks — the
 *  registry is file-per-prompt and a terminal record's only remaining reader
 *  is the phone's history/search view; the Discord post is the permanent
 *  record (the run's answer venue), so the registry is a convenience index,
 *  not an archive. Bounded registry also bounds the poll path: every phone
 *  poll and every ?q= search parses every JSON in the dir. Never touches
 *  pending (still owed a claim) or enqueued (still owed an exit stamp).
 *  Returns the ids removed. */
export function sweepTerminalPrompts(
  spoolDir: string,
  now = Date.now(),
  keepMs = 7 * 24 * 60 * 60 * 1000,
): string[] {
  const removed: string[] = [];
  const weekAgo = now - keepMs;
  for (const rec of listPhonePrompts(spoolDir)) {
    if (rec.status === "pending" || rec.status === "enqueued") continue;
    const ageFrom = rec.finishedAt ?? rec.createdAt;
    if (ageFrom >= weekAgo) continue;
    try {
      fs.rmSync(promptFile(spoolDir, rec.promptId), { force: true });
      removed.push(rec.promptId);
    } catch {
      /* unreadable/locked — next sweep retries */
    }
  }
  return removed;
}

/** The phone-facing rendering: the text, the status, the clock, and the
 *  answer preview when there is one. No channel ids, no fingerprints-as-keys
 *  — minimum surface, same law as asks. */
export function renderPromptForApp(rec: PromptRecord): Record<string, unknown> {
  return {
    promptId: rec.promptId,
    text: rec.text,
    status: rec.status,
    route: rec.route ?? null, // "peer" chips render where the answer will come from
    createdAt: rec.createdAt,
    finishedAt: rec.finishedAt ?? null,
    answerExcerpt: rec.answerExcerpt ?? null,
  };
}
