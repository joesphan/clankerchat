/**
 * notices — machine→phone free-text report lane (round 8, owner 2026-10-04
 * "let me know not in discord but just on the phone").
 *
 * Asks are decision gates, alerts are health-class lines on the machine
 * card — neither carries a report. This module is the third thing: short
 * life-text FROM the machine (round summaries, route verdicts, "here's what
 * changed while you were away") rendered on its own phone card with arrival
 * banners, without a single Discord post.
 *
 * Trust shape (deliberately asymmetric):
 *   - WRITERS are local processes (sessions, daemon, the `notice` CLI)
 *     appending to the spool file directly — same writer class as the
 *     interaction journal. The signed phone surface can never create one.
 *   - The phone READS and ACKS over the companion surface (GET /notices,
 *     POST /notices/:id/ack, POST /notices/ack-all) — nothing else.
 *   - Notice text is display data, never instructions — the same framing
 *     law as answer excerpts. Leak-shaped text is REFUSED at append (the
 *     writer is a local session; a session bug must not be able to ship a
 *     token-shaped string to ANY surface, phone included).
 *
 * File: <spool>/notices.json — one bounded array (file-per-record buys
 * nothing at a 50-entry cap), atomic tmp+rename writes like every other
 * registry. Append is read-modify-write of the whole array: two writers
 * racing can lose the loser's notice (a lost report, never corruption —
 * the rename is atomic). No chain: notices are reports, not evidence —
 * the interaction journal owns tamper-evidence for the security-relevant
 * classes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findLeakSignals } from "./leaks.js";

export type NoticeSeverity = "info" | "warn";

export interface NoticeRecord {
  id: string;
  ts: number;
  /** Monotonic append sequence (max existing + 1) — insertion ORDER as a
   *  stored fact, because ts collides on same-ms bursts and the id is
   *  random (the sort must never reorder a burst). Legacy records without
   *  seq sort by ts among themselves. */
  seq?: number;
  /** Author provenance — a LOCAL label the writer chooses ("gateway",
   *  "daemon", "agy-runner"); display data, never a trust root. */
  from: string;
  text: string;
  severity: NoticeSeverity;
  /** Set by the phone's ack (dismiss); absent = unread. */
  ackedAt?: number;
}

/** Bounded window — append drops the oldest past this. */
export const MAX_NOTICES = 50;
export const MAX_NOTICE_CHARS = 4000;
export const MAX_FROM_CHARS = 64;

export function noticesFile(spoolDir: string): string {
  return path.join(spoolDir, "notices.json");
}

/** Same expression the daemon/index use for the spool — duplicated here so
 *  the CLI (dist/notice.js) and any importer resolve identically without a
 *  daemon import. */
export function defaultSpool(): string {
  return process.env.CLANKER_BOTLINK_SPOOL ?? path.join(process.cwd(), "botlink-spool");
}

function newNoticeId(): string {
  return `ntc${crypto.randomBytes(4).toString("hex")}`; // ntc + 8 hex
}

function readAll(spoolDir: string): NoticeRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(noticesFile(spoolDir), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is NoticeRecord =>
        r && typeof r.id === "string" && typeof r.text === "string" && typeof r.ts === "number",
    );
  } catch {
    return []; // absent or unreadable — an empty lane, not an error
  }
}

function writeAll(spoolDir: string, list: NoticeRecord[]): void {
  fs.mkdirSync(spoolDir, { recursive: true });
  const file = noticesFile(spoolDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1) + "\n");
  fs.renameSync(tmp, file);
}

/** Append a notice (local writers only). Text is trimmed + hard-capped (a
 *  long report still lands, truncated); leak-shaped text THROWS — the caller
 *  decides how loudly, but nothing leak-shaped rides to the phone. Returns
 *  the stored record. */
export function appendNotice(
  spoolDir: string,
  input: { from: string; text: string; severity?: NoticeSeverity },
): NoticeRecord {
  const text = String(input.text ?? "").trim().slice(0, MAX_NOTICE_CHARS);
  if (!text) throw new Error("empty notice");
  const from = String(input.from ?? "").trim().slice(0, MAX_FROM_CHARS) || "machine";
  const severity: NoticeSeverity = input.severity === "warn" ? "warn" : "info";
  if (findLeakSignals(text).length > 0) {
    throw new Error("notice refused: text trips the leak scanner — rewrite without secret-shaped strings");
  }
  const list = readAll(spoolDir);
  const seq = Math.max(0, ...list.map((r) => r.seq ?? 0)) + 1;
  const rec: NoticeRecord = { id: newNoticeId(), ts: Date.now(), seq, from, text, severity };
  writeAll(spoolDir, [...list, rec].slice(-MAX_NOTICES)); // bounded: append drops the oldest
  return rec;
}

/** Registry order (oldest-first), same convention as prompts — by seq when
 *  present (insertion fact), ts only for legacy records. */
export function listNotices(spoolDir: string): NoticeRecord[] {
  return readAll(spoolDir).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.ts - b.ts);
}

/** Dismiss one notice from the phone. Null when the id is unknown; acking an
 *  already-acked notice is idempotent (returns it unchanged). */
export function ackNotice(spoolDir: string, id: string): NoticeRecord | null {
  const list = readAll(spoolDir);
  const hit = list.find((r) => r.id === id);
  if (!hit) return null;
  if (hit.ackedAt) return hit; // already dismissed — nothing to write
  const next = list.map((r) => (r.id === id ? { ...r, ackedAt: Date.now() } : r));
  writeAll(spoolDir, next);
  return next.find((r) => r.id === id) ?? hit;
}

/** Dismiss everything unread in one gesture. Returns the count acked. */
export function ackAllNotices(spoolDir: string): number {
  const now = Date.now();
  let n = 0;
  const next = readAll(spoolDir).map((r) => {
    if (r.ackedAt) return r;
    n++;
    return { ...r, ackedAt: now };
  });
  if (n > 0) writeAll(spoolDir, next);
  return n;
}

/** Hygiene: drop notices older than keepMs regardless of ack state (the cap
 *  already bounds the file; this keeps the PHONE's window fresh). Returns
 *  the count removed. */
export function sweepOldNotices(spoolDir: string, now = Date.now(), keepMs = 7 * 24 * 60 * 60 * 1000): number {
  const all = readAll(spoolDir);
  const keep = all.filter((r) => now - r.ts < keepMs);
  const removed = all.length - keep.length;
  if (removed > 0) writeAll(spoolDir, keep);
  return removed;
}
