/**
 * journal — append-only, hash-chained local record of the event classes
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
 *   - noise meter lines (TODO round): the daemon's own-post rate per thread
 *     crossing the quiet-discord threshold — visibility, never suppression.
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
  kind: "interaction" | "audit" | "noise";
  /** One-line human summary (already oneLine()-cleaned by the caller). */
  detail: string;
  /** interaction: "chat_input" | "button"; noise: "own-post meter" */
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
  // Rotation-stable (audit round 3, finding 2): a rotated .1 was chained
  // under its LIVE name — binding genesis to the current filename made every
  // healthy rotation fail verification as a false tamper alarm. Bind to the
  // journal's identity instead: strip the .1 suffix, so the live file and
  // its rotated generation share the same deterministic, still-file-bound
  // genesis.
  const base = path.basename(file).replace(/\.1$/, "");
  return crypto.createHash("sha256").update(`clanker-journal:${base}`).digest("hex");
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

/** Newest-last tail for dashboards/stat derivations. Reads the live file;
 *  when a rotation just emptied it (live shorter than n), the rotated .1's
 *  verified entries are prepended so the 24h stats window survives rotation
 *  (audit round 3, finding 6 — a flood big enough to force rotation is
 *  exactly the window the stats must NOT silently forget). Missing file →
 *  empty; a BROKEN live chain → empty (untrusted, verifyJournalFile is the
 *  loud path); a broken/absent .1 → live tail only. */
export function readJournalTail(spoolDir: string, n: number): JournalEntry[] {
  if (n <= 0) return [];
  let all: JournalEntry[];
  try {
    all = verifyJournalFile(journalFile(spoolDir));
  } catch {
    return [];
  }
  if (all.length < n) {
    try {
      all = verifyJournalFile(`${journalFile(spoolDir)}.1`).concat(all);
    } catch {
      /* no rotated generation yet, or its chain is broken — live tail only */
    }
  }
  return all.slice(-n); // n>0 — slice(-n) is the tail; -0 would be the whole file
}

/** Refusal/decision stats over a tail — feeds the phone's machine card.
 *  Counted by outcome class, last `windowMs` only. */
export function journalStats(entries: JournalEntry[], now = Date.now(), windowMs = 24 * 60 * 60 * 1000): {
  refused: number;
  criticalAudit: number;
  noise: number;
} {
  let refused = 0;
  let criticalAudit = 0;
  let noise = 0;
  for (const e of entries) {
    if (now - e.ts > windowMs) continue;
    if (e.kind === "interaction" && (e.outcome === "refused" || e.outcome === "venue-blocked")) refused++;
    if (e.kind === "audit" && e.severity === "critical") criticalAudit++;
    // Round 16: noise = webhook posts + identity-spoof refusals (watcher
    // flavor writes them; display-identity events the machine never acted on
    // but the audit trail keeps). Surfaced on the phone card + verify CLI.
    if (e.kind === "noise") noise++;
  }
  return { refused, criticalAudit, noise };
}

/** One-line 24h summary for the daily digest notice (round 9). Pure: the
 *  daemon supplies verified entries + the chain verdict from its own
 *  verifyJournalFile try/catch — a broken chain still gets a digest, it just
 *  says so loudly instead of presenting untrusted counts as fact. */
export function dailyDigestText(entries: JournalEntry[], now = Date.now(), chainOk = true): string {
  const windowMs = 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => now - e.ts <= windowMs);
  const interactions = recent.filter((e) => e.kind === "interaction").length;
  const refused = recent.filter(
    (e) => e.kind === "interaction" && (e.outcome === "refused" || e.outcome === "venue-blocked"),
  ).length;
  const critical = recent.filter((e) => e.kind === "audit" && e.severity === "critical").length;
  const notify = recent.filter((e) => e.kind === "audit" && e.severity === "notify").length;
  const noise = recent.filter((e) => e.kind === "noise").length;
  const counts = `${interactions} interactions (${refused} refused) · ${critical} critical + ${notify} notify audit · ${noise} noise flags`;
  return chainOk
    ? `last 24h: ${counts} · journal chain OK`
    : `JOURNAL CHAIN BROKEN — counts untrusted: ${counts}`;
}
