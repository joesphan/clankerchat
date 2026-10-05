// Notices module tests (round 8, owner 2026-10-04 "let me know not in discord
// but just on the phone") — the machine→phone report lane. Covers the
// properties the design claims:
//   - append/list: registry order oldest-first, id shape, severity default.
//   - Caps: text hard-capped not rejected, from capped, empty refused.
//   - Bound: MAX_NOTICES appends drop the OLDEST (bounded file).
//   - Leak law: leak-shaped text is REFUSED (a local session bug must not
//     ship a token shape to any surface, phone included).
//   - ack: one (idempotent, unknown → null), all (count), badge semantics.
//   - Durability shapes: atomic writes (no .tmp residue), corrupt file →
//     empty lane not a crash, sweep-old keeps fresh.
//
// Usage: node --test tests/notices.test.mjs   (build first: npm run build)

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_NOTICES,
  ackAllNotices,
  ackNotice,
  appendNotice,
  listNotices,
  noticesFile,
  sweepOldNotices,
} from "../dist/notices.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clanker-notices-"));

test("append + list: order, id shape, severity, caps", () => {
  const dir = tmp();
  assert.deepEqual(listNotices(dir), [], "absent file → empty lane, not an error");

  const a = appendNotice(dir, { from: "gateway", text: "round 3 landed: 177/177 green" });
  const b = appendNotice(dir, { from: "gateway", text: "  ".repeat(50) + "trimmed text" });
  const c = appendNotice(dir, { from: "x".repeat(200), text: "warny", severity: "warn" });
  const d = appendNotice(dir, { from: "gateway", text: "l".repeat(9000) });

  assert.match(a.id, /^ntc[a-f0-9]{8}$/);
  assert.equal(a.severity, "info", "severity defaults to info");
  assert.equal(c.severity, "warn");
  assert.equal(c.from.length, 64, "from capped at 64");
  assert.equal(b.text, "trimmed text", "text trimmed");
  assert.equal(d.text.length, 4000, "text hard-capped at 4000, not rejected");

  const list = listNotices(dir);
  assert.deepEqual(list.map((r) => r.id), [a.id, b.id, c.id, d.id], "registry order oldest-first");
  assert.throws(() => appendNotice(dir, { from: "x", text: "   " }), /empty/);
});

test("leak law: leak-shaped text is refused at append", () => {
  const dir = tmp();
  // github token SHAPE (not a real secret — the pattern class is the point)
  assert.throws(
    () => appendNotice(dir, { from: "buggy", text: `here is the token: ghp_${"A".repeat(24)}` }),
    /leak scanner/,
  );
  assert.throws(
    () => appendNotice(dir, { from: "buggy", text: "-----BEGIN OPENSSH PRIVATE KEY-----\nxyz" }),
    /leak scanner/,
  );
  // The refusal left NOTHING behind — the lane is still clean.
  assert.deepEqual(listNotices(dir), []);
  // Prefix mention in prose is FINE (shape law, not content law)
  const ok = appendNotice(dir, { from: "gateway", text: "rotated the cfut_ token family today" });
  assert.equal(listNotices(dir).length, 1);
  assert.equal(listNotices(dir)[0].id, ok.id);
});

test("bound: MAX_NOTICES appends drop the oldest", () => {
  const dir = tmp();
  for (let i = 0; i < MAX_NOTICES + 5; i++) {
    appendNotice(dir, { from: "bulk", text: `notice ${i}` });
  }
  const list = listNotices(dir);
  assert.equal(list.length, MAX_NOTICES);
  assert.match(list[0].text, new RegExp(`notice 5$`), "oldest dropped first");
  assert.match(list[list.length - 1].text, /notice 54$/, "newest kept");
  // Atomic write shape: no tmp residue
  assert.ok(!fs.existsSync(noticesFile(dir) + ".tmp"));
});

test("ack one: unknown → null, idempotent, badge count via unacked", () => {
  const dir = tmp();
  const a = appendNotice(dir, { from: "gateway", text: "one" });
  const b = appendNotice(dir, { from: "gateway", text: "two" });

  assert.equal(ackNotice(dir, "ntcdeadbeef"), null, "unknown id → null");
  const first = ackNotice(dir, a.id);
  assert.ok(first.ackedAt, "ackedAt stamped");
  assert.equal(listNotices(dir).filter((r) => !r.ackedAt).length, 1, "b still unacked");
  const again = ackNotice(dir, a.id);
  assert.equal(again.ackedAt, first.ackedAt, "re-ack is idempotent — stamp not rewritten");

  assert.equal(ackAllNotices(dir), 1, "only b remained");
  assert.equal(listNotices(dir).filter((r) => !r.ackedAt).length, 0);
  assert.equal(ackAllNotices(dir), 0, "nothing left to ack");
});

test("corrupt file → empty lane (never a crash); sweep-old keeps fresh", () => {
  const dir = tmp();
  appendNotice(dir, { from: "gateway", text: "fresh" });
  fs.writeFileSync(noticesFile(dir), "{torn");
  assert.deepEqual(listNotices(dir), [], "corrupt → empty, not a throw");

  const old = appendNotice(dir, { from: "gateway", text: "old report" });
  const fresh = appendNotice(dir, { from: "gateway", text: "fresh report" });
  // Age the first by rewriting its ts behind the module's back
  const aged = listNotices(dir).map((r) => (r.id === old.id ? { ...r, ts: Date.now() - 8 * 24 * 3600_000 } : r));
  fs.writeFileSync(noticesFile(dir), JSON.stringify(aged));
  const removed = sweepOldNotices(dir);
  assert.equal(removed, 1);
  assert.deepEqual(listNotices(dir).map((r) => r.id), [fresh.id]);
});

test("CLI: notice writer drops a report (exit 0, id on stdout; refuses leaks)", () => {
  const dir = tmp();
  const spool = path.join(dir, "spool");
  const run = (args) =>
    spawnSync(process.execPath, ["dist/notice.js", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
    });
  let r = run(["--spool", spool, "--from", "gateway", "phone report test"]);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.match(id, /^ntc[a-f0-9]{8}$/);
  assert.equal(listNotices(spool)[0].from, "gateway");
  assert.equal(listNotices(spool)[0].severity, "info");

  r = run(["--spool", spool, "--warn", "--from", "daemon", "audit degraded"]);
  assert.equal(r.status, 0);
  assert.equal(listNotices(spool)[1].severity, "warn");

  // leak-shaped text → refused loudly, nothing stored
  r = run(["--spool", spool, `token: ghp_${"B".repeat(24)}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak scanner/);
  assert.equal(listNotices(spool).length, 2);
});
