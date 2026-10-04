import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendJournal,
  dailyDigestText,
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
  // noise meter lines (own-post rate) chain like any other kind — and the
  // stats below must stay blind to them
  appendJournal(dir, { ts: 4, kind: "noise", detail: "noise: 10 own posts in thread 1 within 1h", type: "own-post meter" });

  const entries = verifyJournalFile(journalFile(dir));
  assert.equal(entries.length, 4);
  assert.equal(entries[0].outcome, "handled");
  assert.equal(entries[1].actor, "123");
  assert.equal(entries[2].severity, "critical");
  assert.equal(entries[3].kind, "noise");
  // every link is distinct (chain advances per entry)
  assert.equal(new Set(entries.map((e) => e.h)).size, 4);
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
    { h: "x", ts: now - 1000, kind: "noise", detail: "webhook post in 1 by \"w\" (2)" },
    { h: "x", ts: now - 48 * 60 * 60 * 1000, kind: "interaction", outcome: "refused" }, // outside 24h
    { h: "x", ts: now - 48 * 60 * 60 * 1000, kind: "noise", detail: "stale noise" }, // outside 24h
  ];
  const stats = journalStats(entries, now);
  assert.equal(stats.refused, 2);
  assert.equal(stats.criticalAudit, 1);
  assert.equal(stats.noise, 1); // round 16: window-scoped noise count (webhook/spoof)
});

test("journal: daily digest text counts the 24h window and carries the chain verdict", () => {
  const now = Date.now();
  const entries = [
    { h: "x", ts: now - 1000, kind: "interaction", outcome: "handled" },
    { h: "x", ts: now - 1000, kind: "interaction", outcome: "refused" },
    { h: "x", ts: now - 1000, kind: "audit", severity: "critical" },
    { h: "x", ts: now - 1000, kind: "audit", severity: "notify" },
    { h: "x", ts: now - 1000, kind: "noise", detail: "10 own posts" },
    { h: "x", ts: now - 48 * 60 * 60 * 1000, kind: "interaction", outcome: "refused" }, // outside
  ];
  const ok = dailyDigestText(entries, now, true);
  // window only: 2 interactions (the third is 48h old), 1 critical, 1 notify, 1 noise
  assert.match(ok, /last 24h: 2 interactions \(1 refused\) · 1 critical \+ 1 notify audit · 1 noise flags · journal chain OK/);
  // a broken chain still files a digest — it just refuses to vouch for the counts
  const broken = dailyDigestText(entries, now, false);
  assert.match(broken, /JOURNAL CHAIN BROKEN — counts untrusted: 2 interactions/);
  // an all-quiet day is still a digest (the daily all-clear IS the signal)
  assert.match(dailyDigestText([], now, true), /last 24h: 0 interactions \(0 refused\) · 0 critical \+ 0 notify audit · 0 noise flags/);
});

test("CLI: journal-verify proves the chain (and says so loudly when broken)", () => {
  const dir = tmp();
  const run = (args) =>
    spawnSync(process.execPath, ["dist/journal-verify.js", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
    });
  // absent → honest exit 1
  let r = run(["--spool", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no journal at/);

  appendJournal(dir, { ts: Date.now(), kind: "interaction", detail: "slash /clankerchat status", outcome: "handled" });
  appendJournal(dir, { ts: Date.now(), kind: "audit", detail: "webhook created", severity: "critical" });
  appendJournal(dir, { ts: Date.now(), kind: "noise", detail: "webhook post in 1555103465179455488 by \"w\" (1)" });
  r = run(["--spool", dir, "--tail", "2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chain OK · 3 entries/);
  // this fixture has 0 refused interactions, 1 critical audit — the summary
  // counts both per-class AND the 24h window
  assert.match(r.stdout, /0 refused · 1 critical · last 24h: 0 refused \/ 1 critical \/ 1 noise/);
  assert.match(r.stdout, /webhook created/);

  // tamper → exit 1 with the broken-link line
  const file = journalFile(dir);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("webhook created", "nothing happened"));
  r = run(["--spool", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /chain broken/);
});
