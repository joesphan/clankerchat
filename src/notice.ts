#!/usr/bin/env node
/**
 * notice — CLI writer for the machine→phone notices lane (round 8,
 * 2026-10-04). Local sessions/services drop a report for Tyler's phone
 * WITHOUT a Discord post (owner: "let me know not in discord but just on
 * the phone").
 *
 * Usage:
 *   node dist/notice.js [--warn] [--from <label>] [--spool <dir>] "<text>"
 *
 *   --warn    severity warn (red + urgent banner shape on the card)
 *   --from    author label shown on the phone (default "machine")
 *   --spool   spool dir (default: CLANKER_BOTLINK_SPOOL ?? <cwd>/botlink-spool)
 *
 * Stdout: the stored notice id (machine-readable). Exit 0 stored; 1 refused
 * (empty text / leak-shaped text — rewrite, never bypass).
 */
import { appendNotice, defaultSpool, type NoticeSeverity } from "./notices.js";

const argv = process.argv.slice(2);
let from = "machine";
let severity: NoticeSeverity = "info";
let spool: string | null = null;
const parts: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--warn") severity = "warn";
  else if (a === "--from") from = argv[++i] ?? "";
  else if (a === "--spool") spool = argv[++i] ?? "";
  else if (a === "--help" || a === "-h") {
    console.error('usage: notice [--warn] [--from <label>] [--spool <dir>] "<text>"');
    process.exit(0);
  } else parts.push(a);
}
const text = parts.join(" ").trim();
if (!text) {
  console.error('usage: notice [--warn] [--from <label>] [--spool <dir>] "<text>"');
  process.exit(1);
}
try {
  const rec = appendNotice(spool ?? defaultSpool(), { from, text, severity });
  console.log(rec.id);
} catch (err) {
  console.error(`notice refused: ${(err as Error).message}`);
  process.exit(1);
}
