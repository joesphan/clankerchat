import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMsgCache, resetMsgCacheSingletons } from "../dist/msgcache.js";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msgcache-"));
  return { db: path.join(dir, "msgcache.db"), dir };
}

function rec(overrides = {}) {
  return {
    id: "100000000000000001",
    channelId: "1",
    authorId: "2",
    authorName: "tester",
    isBot: false,
    createdAtMs: Date.now(),
    content: "hello world",
    ...overrides,
  };
}

test("openMsgCache returns a full-surface instance on this node (node:sqlite present)", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  assert.ok(mc, "expected a live cache on node >= 23.4");
  for (const k of ["record", "edit", "remove", "setFloor", "covers", "list", "search", "prune", "close"]) {
    assert.equal(typeof mc[k], "function", `missing method ${k}`);
  }
  mc.close();
});

test("same path returns the same instance (singleton), close reopens fresh", () => {
  const { db } = tmpDb();
  const a = openMsgCache(db);
  const b = openMsgCache(db);
  assert.equal(a, b);
  a.close();
  const c = openMsgCache(db);
  assert.notEqual(a, c);
  c.close();
});

test("list returns ascending order and newest-limit window", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  const base = 1_000_000_000_000_000_000n;
  for (let i = 1; i <= 5; i++) {
    mc.record(rec({ id: String(base + BigInt(i)), content: `m${i}`, createdAtMs: 1000 + i }));
  }
  const all = mc.list("1", undefined, 50);
  assert.deepEqual(all.map((m) => m.content), ["m1", "m2", "m3", "m4", "m5"]);
  const three = mc.list("1", undefined, 3);
  assert.deepEqual(three.map((m) => m.content), ["m3", "m4", "m5"], "newest-limit takes the most recent");
  mc.close();
});

test("snowflake ordering is NUMERIC across digit lengths (TEXT sort would flip)", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  const old = "90000000000000000"; // 17 digits
  const newer = "100000000000000000"; // 18 digits — numerically greater, lexicographically SMALLER
  mc.record(rec({ id: newer, createdAtMs: 2000, content: "newer" }));
  mc.record(rec({ id: old, createdAtMs: 1000, content: "older" }));
  const rows = mc.list("1", undefined, 10);
  assert.deepEqual(
    rows.map((m) => m.content),
    ["older", "newer"],
    "ascending numeric order despite differing digit counts",
  );
  // after-semantics on the same trap: after=old must include newer
  const afterOld = mc.list("1", old, 10);
  assert.deepEqual(afterOld.map((m) => m.content), ["newer"]);
  mc.close();
});

test("list channels are isolated", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  mc.record(rec({ id: "100000000000000001", channelId: "A", content: "in A" }));
  mc.record(rec({ id: "100000000000000002", channelId: "B", content: "in B" }));
  assert.deepEqual(mc.list("A", undefined, 10).map((m) => m.content), ["in A"]);
  assert.deepEqual(mc.list("B", undefined, 10).map((m) => m.content), ["in B"]);
  assert.deepEqual(mc.list("C", undefined, 10), [], "unknown channel is empty, not an error");
  mc.close();
});

test("edit updates content only for stored ids; remove deletes; edit of unknown id is a no-op", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  mc.record(rec({ id: "100000000000000001", content: "before" }));
  mc.edit("100000000000000001", "after", 1234);
  const row = mc.list("1", undefined, 10)[0];
  assert.equal(row.content, "after");
  assert.equal(row.editedAtMs, 1234);
  mc.edit("999999999999999999", "ghost", 1); // never recorded — must not throw
  assert.equal(mc.list("1", undefined, 10).length, 1);
  mc.remove("100000000000000001");
  assert.equal(mc.list("1", undefined, 10).length, 0);
  mc.remove("100000000000000001"); // double remove — no-op
  mc.close();
});

test("covers: empty channel false; newest-read needs count>=limit; after-read bounded by oldest cached id + gap floors", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  assert.equal(mc.covers("1", undefined, 5), false, "nothing cached → REST");
  const base = 1_000_000_000_000_000_000n;
  for (let i = 1; i <= 3; i++) mc.record(rec({ id: String(base + BigInt(i)) }));
  assert.equal(mc.covers("1", undefined, 5), false, "3 rows cannot serve a 50-default read");
  assert.equal(mc.covers("1", undefined, 3), true);
  // contiguous from the start: any after >= lowest id is covered
  assert.equal(mc.covers("1", String(base + 1n), 50), true);
  // MID-HISTORY START (the live-probe bug class): a cache that begins
  // mid-channel has NO floor row, but an after BELOW the oldest cached id
  // must still fall back to REST — absence of a floor is not "full history".
  assert.equal(mc.covers("1", "999999999999999999", 50), false, "after below oldest cached id → REST");
  // a gap is recorded (saturated boot replay): reads below the floor are NOT covered
  mc.setFloor("1", String(base + 2n));
  assert.equal(mc.covers("1", String(base + 1n), 50), false, "below floor → REST");
  assert.equal(mc.covers("1", String(base + 2n), 50), true, "at floor → covered");
  mc.close();
});

test("setFloor is raise-only", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  const base = 1_000_000_000_000_000_000n;
  for (let i = 1; i <= 3; i++) mc.record(rec({ id: String(base + BigInt(i)) }));
  mc.setFloor("1", String(base + 3n));
  mc.setFloor("1", String(base + 1n)); // lower — must be ignored
  assert.equal(mc.covers("1", String(base + 2n), 50), false, "floor stayed high");
  mc.setFloor("1", String(base + 4n)); // raise — numeric compare, not codepoint
  assert.equal(mc.covers("1", String(base + 3n), 50), false, "floor rose");
  assert.equal(mc.covers("1", String(base + 4n), 50), true, "at the new floor");
  mc.close();
});

test("search: substring, case-insensitive, LIKE metachars escaped, channel/since/limit filters", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  const base = 1_000_000_000_000_000_000n;
  mc.record(rec({ id: String(base + 1n), content: "Deploy the launch codes", createdAtMs: 1000 }));
  mc.record(rec({ id: String(base + 2n), content: "deploy again", channelId: "2", createdAtMs: 2000 }));
  mc.record(rec({ id: String(base + 3n), content: "progress: 50% done_ partly", createdAtMs: 3000 }));
  mc.record(rec({ id: String(base + 4n), content: "old deploy", createdAtMs: 4000 }));

  assert.equal(mc.search({ text: "DEPLOY" }).length, 3, "case-insensitive across channels");
  assert.equal(mc.search({ text: "deploy", channelId: "2" }).length, 1);
  assert.deepEqual(
    mc.search({ text: "deploy" }).map((m) => m.content),
    ["old deploy", "deploy again", "Deploy the launch codes"],
    "newest-first",
  );
  // a literal % or _ in the query must NOT act as a wildcard
  assert.equal(mc.search({ text: "50%" }).length, 1, "literal percent matches only the literal");
  assert.equal(mc.search({ text: "done_" }).length, 1, "literal underscore ditto");
  assert.equal(mc.search({ text: "5%" }).length, 0, "% does not widen");
  assert.equal(mc.search({ text: "deploy", sinceMs: 2500 }).length, 1, "since filter");
  assert.equal(mc.search({ text: "deploy", limit: 2 }).length, 2, "limit clamps");
  mc.close();
});

test("prune removes only older-than rows and reports the count", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  const base = 1_000_000_000_000_000_000n;
  mc.record(rec({ id: String(base + 1n), createdAtMs: 1000 }));
  mc.record(rec({ id: String(base + 2n), createdAtMs: 2000 }));
  assert.equal(mc.prune(1500), 1);
  assert.equal(mc.list("1", undefined, 10).length, 1);
  mc.close();
});

test("persistence: close + reopen keeps rows and floors", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  const base = 1_000_000_000_000_000_000n;
  for (let i = 1; i <= 3; i++) mc.record(rec({ id: String(base + BigInt(i)), content: `m${i}` }));
  mc.setFloor("1", String(base + 2n));
  mc.close();
  resetMsgCacheSingletons();
  const mc2 = openMsgCache(db);
  assert.equal(mc2.list("1", undefined, 10).length, 3);
  assert.equal(mc2.covers("1", String(base + 1n), 50), false, "floor survived the reopen");
  mc2.close();
});

test("record caps oversized fields instead of throwing", () => {
  const { db } = tmpDb();
  const mc = openMsgCache(db);
  mc.record(rec({ content: "x".repeat(9000), authorName: "n".repeat(300) }));
  const row = mc.list("1", undefined, 10)[0];
  assert.equal(row.content.length, 4000);
  assert.equal(row.authorName.length, 100);
  mc.close();
});
