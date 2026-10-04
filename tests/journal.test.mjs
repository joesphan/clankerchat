import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendJournal,
  journalFile,
  journalStats,
  readJournalTail,
  verifyJournalFile,
} from "../dist/journal.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-journal-"));
}

test("journal: appends chain correctly and verifies", () => {
  const dir = tmp();
  appendJournal(dir, { ts: 1, kind: "interaction", detail: "slash /clankerchat status", type: "chat_input", outcome: "handled" });
  appendJournal(dir, { ts: 2, kind: "interaction", detail: "ask click refused", type: "button", name: "ask:x:approve", outcome: "refused", actor: "123" });
  appendJournal(dir, { ts: 3, kind: "audit", detail: "webhook created", action: "WEBHOOK_CREATE", severity: "critical" });

  const entries = verifyJournalFile(journalFile(dir));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].outcome, "handled");
  assert.equal(entries[1].actor, "123");
  assert.equal(entries[2].severity, "critical");
  // every link is distinct (chain advances per entry)
  assert.equal(new Set(entries.map((e) => e.h)).size, 3);
});

test("journal: tampering with a line breaks the chain", () => {
  const dir = tmp();
  appendJournal(dir, { ts: 1, kind: "interaction", detail: "a" });
  appendJournal(dir, { ts: 2, kind: "interaction", detail: "b" });
  const file = journalFile(dir);
  const forged = fs
    .readFileSync(file, "utf8")
    .replace('"detail":"b"', '"detail":"b (edited)"');
  fs.writeFileSync(file, forged);
  assert.throws(() => verifyJournalFile(file), /chain broken/);
});

test("journal: readJournalTail is newest-last and bounded", () => {
  const dir = tmp();
  for (let i = 0; i < 10; i++) {
    appendJournal(dir, { ts: i, kind: "interaction", detail: `e${i}` });
  }
  const tail = readJournalTail(dir, 3);
  assert.deepEqual(tail.map((e) => e.detail), ["e7", "e8", "e9"]);
  assert.deepEqual(readJournalTail(dir, 0), []);
  // missing file → empty, never a throw (dashboard reads must not crash)
  assert.deepEqual(readJournalTail(path.join(dir, "nope"), 5), []);
});

test("journal: stats count refusals + critical audit in the window only", () => {
  const now = Date.now();
  const entries = [
    { h: "x", ts: now - 1000, kind: "interaction", outcome: "refused" },
    { h: "x", ts: now - 1000, kind: "interaction", outcome: "venue-blocked" },
    { h: "x", ts: now - 1000, kind: "interaction", outcome: "handled" },
    { h: "x", ts: now - 1000, kind: "audit", severity: "critical" },
    { h: "x", ts: now - 1000, kind: "audit", severity: "notify" },
    { h: "x", ts: now - 48 * 60 * 60 * 1000, kind: "interaction", outcome: "refused" }, // outside 24h
  ];
  const stats = journalStats(entries, now);
  assert.equal(stats.refused, 2);
  assert.equal(stats.criticalAudit, 1);
});
