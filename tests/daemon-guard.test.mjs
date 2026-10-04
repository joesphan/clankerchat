/**
 * daemon-guard tests — the trigger-path invariants daemon.ts enforces but
 * cannot be tested on directly (it is a composition root: Discord client,
 * intervals, and main() all fire at import time). Audit round 2 fixes
 * 2/4/6/9.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  advanceCursor,
  atomicWrite,
  ChannelBlocklist,
  idIsNewer,
  isUnderRoot,
  parseBlockedIdList,
  parseBlocklistFile,
} from "../dist/daemon-guard.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-daemon-guard-"));
}

// ---------------------------------------------------------------------------
// Cursors (fix 6): monotonic only
// ---------------------------------------------------------------------------

test("idIsNewer: snowflake order via BigInt, absent/unparseable held counts as behind", () => {
  assert.equal(idIsNewer("1000000000000000001", "1000000000000000000"), true);
  assert.equal(idIsNewer("1000000000000000000", "1000000000000000001"), false);
  assert.equal(idIsNewer("1000000000000000000", "1000000000000000000"), false); // equal = not newer
  assert.equal(idIsNewer("5", undefined), true);
  assert.equal(idIsNewer("5", ""), true);
  assert.equal(idIsNewer("5", "not-a-snowflake"), true); // unparseable cursor re-sweeps
});

test("advanceCursor (fix 6): a stale poll position never regresses a live write", () => {
  const cursors = { thread: "1000000000000000005" };
  // The exact race: pollOnce's local cursor (…003) lands after a live
  // handler already advanced to …005 — the write must be refused.
  assert.equal(advanceCursor(cursors, "thread", "1000000000000000003"), false);
  assert.equal(cursors.thread, "1000000000000000005");
  assert.equal(advanceCursor(cursors, "thread", "1000000000000000009"), true);
  assert.equal(cursors.thread, "1000000000000000009");
  // New channel ids seed freely.
  assert.equal(advanceCursor(cursors, "other", "0"), true);
  assert.equal(cursors.other, "0");
  // "0" never overwrites a real position (first-sight seed vs live race).
  assert.equal(advanceCursor(cursors, "thread", "0"), false);
});

// ---------------------------------------------------------------------------
// Venue quarantine (fix 2)
// ---------------------------------------------------------------------------

test("parseBlockedIdList: comma list trims and drops empties", () => {
  assert.deepEqual(
    [...parseBlockedIdList(" 111 ,,, 222 ,")].sort(),
    ["111", "222"],
  );
  assert.equal(parseBlockedIdList(undefined).size, 0);
  assert.equal(parseBlockedIdList("").size, 0);
});

test("parseBlocklistFile: snowflakes only, # comments, blanks ignored", () => {
  const text = [
    "# blocked venues",
    "111111111111111111",
    "   222222222222222222   # trailing comment",
    "not-a-snowflake",
    "",
  ].join("\n");
  assert.deepEqual([...parseBlocklistFile(text)].sort(), [
    "111111111111111111",
    "222222222222222222",
  ]);
});

test("ChannelBlocklist: env list + mtime-cached file, missing file fails open-closed (no match, no throw)", () => {
  const dir = tmp();
  const file = path.join(dir, "blocklist.txt");
  fs.writeFileSync(file, "111111111111111111\n");
  const bl = new ChannelBlocklist("999", file);
  assert.equal(bl.contains("999"), true); // env side
  assert.equal(bl.contains("111111111111111111"), true); // file side
  assert.equal(bl.contains("888"), false);

  // Extend the file WITHOUT a restart: bump mtime explicitly (filesystem
  // mtime granularity is not a test assumption we want to make).
  fs.writeFileSync(file, "111111111111111111\n333333333333333333\n");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  assert.equal(bl.contains("333333333333333333"), true, "mtime change re-reads the file");

  // Unreadable file keeps the last-known cache — never silently empty.
  fs.unlinkSync(file);
  assert.equal(bl.contains("111111111111111111"), true, "cache survives a missing file");

  // A blocklist with no file at all never throws on contains.
  const noFile = new ChannelBlocklist(undefined, path.join(dir, "never-exists.txt"));
  assert.equal(noFile.contains("111111111111111111"), false);
});

// ---------------------------------------------------------------------------
// Router cwd containment (fix 4)
// ---------------------------------------------------------------------------

test("isUnderRoot (fix 4): containment, not existence — escapes and foreign roots refused", () => {
  const root = path.resolve(os.tmpdir(), "repos-root");
  assert.equal(isUnderRoot(root, path.join(root, "clankerchat")), true);
  assert.equal(isUnderRoot(root, path.join(root, "a", "b", "c")), true);
  assert.equal(isUnderRoot(root, root), true); // the root itself
  // The exact finding: a crafted cwd steering at .ssh exists — but is outside.
  assert.equal(isUnderRoot(root, path.join(path.dirname(root), ".ssh")), false);
  assert.equal(isUnderRoot(root, path.resolve(root, "..", "elsewhere")), false);
  assert.equal(isUnderRoot(root, "C:\\Windows\\System32"), false); // absolute outside
});

// ---------------------------------------------------------------------------
// Atomic writes (fix 9)
// ---------------------------------------------------------------------------

test("atomicWrite: parseable result, no tmp residue, overwrite works", () => {
  const dir = tmp();
  const file = path.join(dir, "daemon.state.json");
  atomicWrite(file, JSON.stringify({ cursors: { a: "1" } }, null, 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { cursors: { a: "1" } });
  assert.equal(fs.existsSync(file + ".tmp"), false, "no torn tmp left behind");
  atomicWrite(file, JSON.stringify({ cursors: { a: "2" } }, null, 2));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cursors.a, "2");
  assert.equal(fs.existsSync(file + ".tmp"), false);
});
