#!/usr/bin/env node
/**
 * journal-verify — human-facing check of the interaction journal's hash
 * chain (round 3 tooling). verifyJournalFile is the loud path; this is the
 * command that runs it: an owner (or a suspicious session) can prove the
 * local record is untampered without writing JS.
 *
 * Usage:
 *   node dist/journal-verify.js [--spool DIR] [--tail N] [--all]
 *
 *   --spool DIR   spool dir (default CLANKER_BOTLINK_SPOOL ?? <cwd>/botlink-spool)
 *   --tail N      also print the newest N entries (default 0 = summary only)
 *   --all         verify the rotated .1 generation too (skipped by default —
 *                 the live file is the one still being written)
 *
 * Exit: 0 chain intact; 1 broken/absent.
 */
import fs from "node:fs";
import { journalFile, journalStats, readJournalTail, verifyJournalFile } from "./journal.js";

const argv = process.argv.slice(2);
let spool: string | null = null;
let tail = 0;
let all = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--spool") spool = argv[++i] ?? "";
  else if (a === "--tail") tail = Number(argv[++i] ?? 0) || 0;
  else if (a === "--all") all = true;
  else if (a === "--help" || a === "-h") {
    console.error("usage: journal-verify [--spool DIR] [--tail N] [--all]");
    process.exit(0);
  }
}
const dir = spool ?? process.env.CLANKER_BOTLINK_SPOOL ?? `${process.cwd()}/botlink-spool`;
const file = journalFile(dir);

if (!fs.existsSync(file)) {
  console.error(`journal-verify: no journal at ${file} (no interactions recorded yet, or wrong spool)`);
  process.exit(1);
}

try {
  const entries = verifyJournalFile(file);
  const stats = journalStats(entries);
  const refused = entries.filter((e) => e.outcome === "refused" || e.outcome === "venue-blocked").length;
  const critical = entries.filter((e) => e.severity === "critical").length;
  console.log(`chain OK · ${entries.length} entries · ${refused} refused · ${critical} critical · last 24h: ${stats.refused} refused / ${stats.criticalAudit} critical`);
  if (all && fs.existsSync(`${file}.1`)) {
    const rotated = verifyJournalFile(`${file}.1`);
    console.log(`rotated .1 OK · ${rotated.length} entries`);
  }
  for (const e of readJournalTail(dir, tail)) {
    console.log(`  ${new Date(e.ts).toISOString()} [${e.kind}] ${e.detail}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`journal-verify: ${(err as Error).message}`);
  process.exit(1);
}
