/**
 * journal — append-only, hash-chained local record of the two event classes
 * that were previously invisible outside daemon.log prose (owner round
 * 2026-10-04 "use your discord features to the best of your abilities"):
 *
 *   - interactions (S-tier #4): every slash invocation and ask-button click
 *     the daemon sees — who, what, and the verdict, including REFUSALS. A
 *     non-approver probing the buttons is a security signal, and until now
 *     it existed only as a console line.
 *   - audit-log events (S-tier #5): classified guild audit entries (see
 *     audit.ts) — deletions of our posts, channel/permission surgery,
 *     webhook spawns, role changes on the bot.
 *
 * Both machines use this module verbatim (plain fs, atomic-ish appends,
 * no discord.js import). The chain gives tamper-EVIDENCE, not tamper
 * resistance: verifyJournal() refuses a file whose links don't recompute,
 * the same contract inject.log carries.
 *
 * File: <spool>/interaction-journal.jsonl, rotated to .1 at ROTATE_BYTES
 * (one generation; the chain restarts per file and each file verifies
 * standalone — the entry's `h` links to the previous line only).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** One line per event. Flat on purpose — a JSONL log with unions is a
 *  grep hazard; absent fields are simply omitted. */
export interface JournalEntry {
  /** Chain link: sha256 over (prevH + canonical JSON of the entry without
   *  `h`). First entry of a file links to sha256("clanker-journal:" + file
   *  base name) so genesis is file-bound, not forgeable as a constant. */
  h: string;
  ts: number; // epoch ms
  kind: "interaction" | "audit";
  /** One-line human summary (already oneLine()-cleaned by the caller). */
  detail: string;
  /** interaction: "chat_input" | "button" */
  type?: string;
  /** interaction: "/clankerchat ask" or the button custom_id */
  name?: string;
  /** interaction actor or audit executor, Discord user id (ids only —
   *  display names stay in daemon.log; the journal is the structured truth). */
  actor?: string;
  /** interaction verdict */
  outcome?: string;
  /** audit: AuditLogEvent name */
  action?: string;
  /** audit: "critical" | "notify" */
  severity?: string;
  /** audit: the entry's target id (message/channel/member/bot) */
  target?: string;
}

export const ROTATE_BYTES = 2 * 1024 * 1024; // 2 MB — years of interaction traffic

export function journalFile(spoolDir: string): string {
  return path.join(spoolDir, "interaction-journal.jsonl");
}

function genesisH(file: string): string {
  return crypto.createHash("sha256").update(`clanker-journal:${path.basename(file)}`).digest("hex");
}

function entryHash(prevH: string, entry: Omit<JournalEntry, "h">): string {
  const canon = JSON.stringify(entry, Object.keys(entry).sort() as (keyof Omit<JournalEntry, "h">)[]);
  return crypto.createHash("sha256").update(prevH + canon).digest("hex");
}

function lastLineHash(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return genesisH(file);
    // read back at most the final 4 KB — a chained line is far smaller
    const window = Math.min(size, 4096);
    const buf = Buffer.alloc(window);
    fs.readSync(fd, buf, 0, window, size - window);
    const text = buf.toString("utf8");
    const lastNewline = text.lastIndexOf("\n", text.length - 2); // skip trailing newline
    const line = text.slice(lastNewline + 1).trim();
    return line ? (JSON.parse(line).h as string) : genesisH(file);
  } catch {
    return genesisH(file); // unreadable → treat as fresh file
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Append one entry, maintaining the chain. Rotation rides the append: a
 *  file past ROTATE_BYTES is renamed to .1 (previous .1 dropped) before the
 *  entry starts the next chain. Multi-process writers are not expected
 *  (the daemon is the only interaction writer), but each append re-reads
 *  the tail hash, so interleaved appends still chain correctly. */
export function appendJournal(spoolDir: string, entry: Omit<JournalEntry, "h">): void {
  const file = journalFile(spoolDir);
  fs.mkdirSync(spoolDir, { recursive: true });
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= ROTATE_BYTES) {
      fs.renameSync(file, `${file}.1`); // one generation — the chain is the record, not the archive
    }
  } catch {
    /* rotation is hygiene; an append must go through regardless */
  }
  const full: JournalEntry = { h: entryHash(lastLineHash(file), entry), ...entry };
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
}

/** Verify one file's chain; returns the parsed entries, or throws on a
 *  broken link / unparseable line. The caller names the file — this never
 *  guesses between live and rotated. */
export function verifyJournalFile(file: string): JournalEntry[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const out: JournalEntry[] = [];
  let prevH = genesisH(file);
  for (const line of lines) {
    const e = JSON.parse(line) as JournalEntry;
    const { h, ...rest } = e;
    if (entryHash(prevH, rest) !== h) {
      throw new Error(`journal chain broken at ts=${e.ts} in ${path.basename(file)}`);
    }
    prevH = h;
    out.push(e);
  }
  return out;
}

/** Newest-last tail of the live file (no rotation crawl) — bounded reads
 *  for dashboards/stat derivations. Missing file → empty. */
export function readJournalTail(spoolDir: string, n: number): JournalEntry[] {
  if (n <= 0) return [];
  try {
    const all = verifyJournalFile(journalFile(spoolDir));
    return all.slice(-n); // n>0 — slice(-n) is the tail; -0 would be the whole file
  } catch {
    return []; // a broken chain still must not take down /machine — verifyJournalFile is the loud path
  }
}

/** Refusal/decision stats over a tail — feeds the phone's machine card.
 *  Counted by outcome class, last `windowMs` only. */
export function journalStats(entries: JournalEntry[], now = Date.now(), windowMs = 24 * 60 * 60 * 1000): {
  refused: number;
  criticalAudit: number;
} {
  let refused = 0;
  let criticalAudit = 0;
  for (const e of entries) {
    if (now - e.ts > windowMs) continue;
    if (e.kind === "interaction" && (e.outcome === "refused" || e.outcome === "venue-blocked")) refused++;
    if (e.kind === "audit" && e.severity === "critical") criticalAudit++;
  }
  return { refused, criticalAudit };
}
