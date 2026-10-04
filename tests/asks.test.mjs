// asks — interactive approve/deny surfaces (round 2, owner 2026-10-04).
// Covers the three contract surfaces the trust split depends on:
//   1. the Discord payload shape (one row, two styled buttons, custom_id law),
//   2. the custom_id parse gate (foreign components must parse to null —
//      another app's button on a visible message can never crash or hijack
//      the handler),
//   3. the registry lifecycle (create → decide idempotence → expiry sweep).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASK_COUNTDOWN_PREFIX,
  ASK_TTL_MS,
  buildAskCountdownEdit,
  buildAskComponents,
  buildDisabledAskComponents,
  askCustomId,
  parseAskCustomId,
  newAskId,
  createPendingAsk,
  getAsk,
  listPendingAsks,
  decideAsk,
  sweepExpiredAsks,
  stampAskEnqueued,
  listCompanionDecisions,
  renderAskForApp,
  askDecisionLine,
  ASK_V2_FLAG,
  buildAskV2Components,
  askClockLine,
  isAskV2Message,
  rebuildAskV2ForEdit,
} from "../dist/asks.js";

function tmpSpool() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-asks-"));
}

const APPROVER = "187396435283542016"; // 18-digit snowflake shape

// --- payload shape -----------------------------------------------------------

test("buildAskComponents: one action row, Approve green + Deny red + YOLO blurple, custom_ids follow the contract", () => {
  const askId = newAskId();
  const rows = buildAskComponents(askId);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.type, 1); // ACTION_ROW
  assert.equal(row.components.length, 3);
  const [approve, deny, yolo] = row.components;
  assert.equal(approve.type, 2); // BUTTON
  assert.equal(approve.style, 3); // Success (green)
  assert.equal(approve.label, "Approve");
  assert.equal(deny.style, 4); // Danger (red)
  assert.equal(deny.label, "Deny");
  assert.equal(yolo.style, 1); // Primary (blurple)
  assert.equal(yolo.label, "YOLO");
  // custom_id contract: ask:<id>:<action>, ≤100 chars (Discord's cap)
  assert.equal(approve.custom_id, `ask:${askId}:approve`);
  assert.equal(deny.custom_id, `ask:${askId}:deny`);
  assert.equal(yolo.custom_id, `ask:${askId}:yolo`);
  assert.ok(approve.custom_id.length <= 100 && yolo.custom_id.length <= 100);
  assert.ok(!("disabled" in approve) && !("disabled" in deny) && !("disabled" in yolo), "live buttons are not disabled");
});

test("buildDisabledAskComponents: same row, all buttons disabled, custom_ids intact", () => {
  const askId = newAskId();
  const [row] = buildDisabledAskComponents(askId);
  assert.equal(row.components.length, 3);
  for (const b of row.components) {
    assert.equal(b.disabled, true);
    assert.ok(parseAskCustomId(b.custom_id), "disabled custom_id still parses");
  }
});

// --- custom_id gate ----------------------------------------------------------

test("askCustomId ↔ parseAskCustomId round-trips all three actions", () => {
  const askId = newAskId();
  assert.deepEqual(parseAskCustomId(askCustomId(askId, "approve")), { askId, action: "approve" });
  assert.deepEqual(parseAskCustomId(askCustomId(askId, "deny")), { askId, action: "deny" });
  assert.deepEqual(parseAskCustomId(askCustomId(askId, "yolo")), { askId, action: "yolo" });
});

test("parseAskCustomId: foreign custom_ids parse to null (never throw, never match)", () => {
  const foreign = [
    "other-app:confirm:1", // another bot's component
    "ask:abc:maybe", // our prefix, foreign action
    "ask:", "ask::approve", "ask:abc:", // malformed
    "ask:ABC:approve", // uppercase id (ours are lowercase)
    "ask:abc;drop:approve", // injection-shaped
    "", "approve", ":::",
    "ask:abc:approve:extra",
  ];
  for (const id of foreign) assert.equal(parseAskCustomId(id), null, `should reject ${JSON.stringify(id)}`);
});

// --- registry lifecycle ------------------------------------------------------

test("createPendingAsk/getAsk: writes a pending record; approver list is snowflake-filtered; missing id → null", () => {
  const spool = tmpSpool();
  const rec = createPendingAsk(spool, {
    question: "ship the rotation cutover?",
    channelId: "1555115816775720980",
    messageId: "1791099000000-abcdef",
    approvers: [APPROVER, "not-a-snowflake", "12", "123456789012345678901234567", ""],
  });
  assert.equal(rec.status, "pending");
  assert.deepEqual(rec.approvers, [APPROVER]); // garbage dropped at creation
  assert.equal(rec.expiresAt - rec.createdAt, ASK_TTL_MS);
  const readBack = getAsk(spool, rec.askId);
  assert.equal(readBack.question, "ship the rotation cutover?");
  assert.equal(readBack.messageId, "1791099000000-abcdef");
  // atomic write: no tmp file left behind
  assert.deepEqual(fs.readdirSync(path.join(spool, "pending-asks")).filter((f) => f.endsWith(".tmp")), []);
  assert.equal(getAsk(spool, "no-such-ask"), null);
});

test("decideAsk: first decision wins; later clicks return the existing record unchanged (idempotence)", () => {
  const spool = tmpSpool();
  const rec = createPendingAsk(spool, {
    question: "q",
    channelId: "1",
    messageId: null,
    approvers: [APPROVER],
  });
  const first = decideAsk(spool, rec.askId, "approved", APPROVER);
  assert.equal(first.status, "approved");
  assert.equal(first.decidedBy, APPROVER);
  assert.ok(first.decidedAt >= rec.createdAt);
  // a second click — even a DENY by another id — must not flip the decision
  const second = decideAsk(spool, rec.askId, "denied", "999999999999999999");
  assert.equal(second.status, "approved");
  assert.equal(second.decidedBy, APPROVER);
  assert.equal(decideAsk(spool, "missing", "approved", APPROVER), null);
});

test("decideAsk cross-process claim (audit fix 12): a stale pending overwrite can't mint a second decision", () => {
  const spool = tmpSpool();
  const rec = createPendingAsk(spool, {
    question: "q",
    channelId: "1",
    messageId: null,
    approvers: [APPROVER],
  });
  // winner decides (say: the companion HTTP process — a phone tap)
  const winner = decideAsk(spool, rec.askId, "approved", "phone-fp");
  assert.equal(winner.decidedBy, "phone-fp");
  // simulate the losing racer (the watcher process, button click) whose read
  // of "pending" happened BEFORE the winner's write: its stale copy lands as
  // the file. The pre-claim get→check→write would let ITS decideAsk succeed
  // too — double decision run + double message edit.
  const stale = JSON.parse(JSON.stringify(rec));
  fs.writeFileSync(path.join(spool, "pending-asks", `${rec.askId}.json`), JSON.stringify(stale));
  assert.equal(getAsk(spool, rec.askId).status, "pending", "stale overwrite in place");
  const loser = decideAsk(spool, rec.askId, "denied", APPROVER);
  // the winner's O_EXCL claim file blocks the loser: no second decision,
  // no write — the record stays exactly the stale bytes the racer wrote
  assert.equal(loser.status, "pending", "loser gets the record back, not a win");
  const after = getAsk(spool, rec.askId);
  assert.equal(after.status, "pending");
  assert.equal(after.decidedBy, undefined);
  assert.ok(fs.existsSync(path.join(spool, "pending-asks", `${rec.askId}.json.claim`)), "claim marker persists");
});

test("sweepExpiredAsks: overdue pending → expired and returned; fresh + decided stay untouched", () => {
  const spool = tmpSpool();
  const fresh = createPendingAsk(spool, { question: "fresh", channelId: "1", messageId: null, approvers: [APPROVER] });
  const stale = createPendingAsk(spool, {
    question: "stale",
    channelId: "1",
    messageId: null,
    approvers: [APPROVER],
    ttlMs: 1,
  });
  const decided = createPendingAsk(spool, {
    question: "decided",
    channelId: "1",
    messageId: null,
    approvers: [APPROVER],
    ttlMs: 1,
  });
  decideAsk(spool, decided.askId, "denied", APPROVER);
  const now = Date.now() + 10_000;
  const expired = sweepExpiredAsks(spool, now);
  assert.deepEqual(expired.map((r) => r.askId), [stale.askId]); // exactly the overdue pending one
  assert.equal(getAsk(spool, stale.askId).status, "expired");
  assert.equal(getAsk(spool, fresh.askId).status, "pending");
  assert.equal(getAsk(spool, decided.askId).status, "denied"); // decided ≠ sweepable
  // a decided record carries decidedAt; an expired one does not (decision-shaped
  // fields only ever exist on real decisions)
  assert.equal(getAsk(spool, stale.askId).decidedBy, undefined);
});

test("listPendingAsks lists every record file (registry view, all statuses)", () => {
  const spool = tmpSpool();
  const a = createPendingAsk(spool, { question: "a", channelId: "1", messageId: null, approvers: [APPROVER] });
  const b = createPendingAsk(spool, { question: "b", channelId: "1", messageId: null, approvers: [APPROVER] });
  decideAsk(spool, b.askId, "approved", APPROVER);
  const ids = listPendingAsks(spool).map((r) => r.askId).sort();
  assert.deepEqual(ids, [a.askId, b.askId].sort());
});

test("askDecisionLine renders Approved/Denied/YOLO'd with the decider's display name", () => {
  const approved = { status: "approved", decidedAt: Date.UTC(2026, 9, 4, 12, 34, 56) };
  const line = askDecisionLine(approved, "fast335xi");
  assert.match(line, /^Approved by fast335xi · 12:34:56Z$/);
  assert.equal(askDecisionLine({ status: "denied", decidedAt: 0 }, "x"), "Denied by x · 00:00:00Z");
  assert.equal(askDecisionLine({ status: "yolo", decidedAt: 0 }, "x"), "YOLO'd by x · 00:00:00Z");
});

// --- yolo third verb (owner-approved ask muucxgb9, 2026-10-04) ---------------

test("decideAsk records yolo as a distinct terminal status with the clicker's provenance", () => {
  const spool = tmpSpool();
  const rec = createPendingAsk(spool, { question: "merge now?", channelId: "1", messageId: null, approvers: [APPROVER] });
  const decided = decideAsk(spool, rec.askId, "yolo", APPROVER);
  assert.equal(decided.status, "yolo"); // the distinct verb, recorded in the outcome
  assert.equal(decided.decidedBy, APPROVER);
  assert.equal(getAsk(spool, rec.askId).status, "yolo");
  // yolo is decided → not sweepable, clock dead, stampable (delivery contract unchanged)
  assert.ok(!sweepExpiredAsks(spool, Date.now() + 10_000).some((r) => r.askId === rec.askId));
  assert.equal(askClockLine(getAsk(spool, rec.askId)), null);
  assert.ok(stampAskEnqueued(spool, rec.askId).enqueuedAt > 0);
});

// --- lazy consensus (round 3, owner 2026-10-04: "auto approve and set the duration") ---

test("createPendingAsk persists onExpiry=approve and honors ttlMs; default records carry NEITHER", () => {
  const spool = tmpSpool();
  const lazy = createPendingAsk(spool, {
    question: "proceed if nobody objects?",
    channelId: "1",
    messageId: null,
    approvers: [APPROVER],
    ttlMs: 5 * 60_000,
    onExpiry: "approve",
  });
  assert.equal(getAsk(spool, lazy.askId).onExpiry, "approve"); // persisted, not just returned
  assert.equal(lazy.expiresAt - lazy.createdAt, 5 * 60_000); // custom duration took
  const strict = createPendingAsk(spool, {
    question: "fail-closed default",
    channelId: "1",
    messageId: null,
    approvers: [APPROVER],
  });
  assert.equal("onExpiry" in getAsk(spool, strict.askId), false, "default records carry no onExpiry key");
});

test("sweepExpiredAsks: lazy ask flips to approved (decidedBy auto-expiry); default stays expired — and a pre-expiry Deny wins", () => {
  const spool = tmpSpool();
  const lazy = createPendingAsk(spool, {
    question: "lazy", channelId: "1", messageId: null, approvers: [APPROVER], ttlMs: 1, onExpiry: "approve",
  });
  const strict = createPendingAsk(spool, {
    question: "strict", channelId: "1", messageId: null, approvers: [APPROVER], ttlMs: 1,
  });
  const deniedLazy = createPendingAsk(spool, {
    question: "denied-lazy", channelId: "1", messageId: null, approvers: [APPROVER], ttlMs: 60_000, onExpiry: "approve",
  });
  decideAsk(spool, deniedLazy.askId, "denied", APPROVER); // silence-yes contract: Deny beats the timer
  const swept = sweepExpiredAsks(spool, Date.now() + 10_000);
  const byId = Object.fromEntries(swept.map((r) => [r.askId, r]));
  assert.equal(byId[lazy.askId].status, "approved");
  assert.equal(byId[lazy.askId].decidedBy, "auto-expiry"); // honest provenance: nobody clicked
  assert.ok(byId[lazy.askId].decidedAt > 0);
  assert.equal(byId[strict.askId].status, "expired"); // THE invariant: expiry is never approval by default
  assert.equal(byId[strict.askId].decidedBy, undefined);
  assert.ok(!byId[deniedLazy.askId], "a decided ask is not sweepable — the Deny already won");
  assert.equal(getAsk(spool, deniedLazy.askId).status, "denied");
});

test("askDecisionLine: auto-expiry renders its own honest line (no clicker to name)", () => {
  const rec = { status: "approved", decidedBy: "auto-expiry", decidedAt: Date.UTC(2026, 9, 4, 8, 29, 10) };
  assert.equal(askDecisionLine(rec, "irrelevant-name"), "Auto-approved (no Deny before expiry) · 08:29:10Z");
});

// --- round 4: companion (phone) decisions + exactly-once delivery ----------

test("stampAskEnqueued: stamps a decided ask exactly once; pending/missing/null-safe", () => {
  const spool = tmpSpool();
  const pending = createPendingAsk(spool, {
    question: "still open", channelId: "1", messageId: null, approvers: [APPROVER],
  });
  assert.equal(stampAskEnqueued(spool, pending.askId), null, "pending ask is never deliverable");
  const decided = createPendingAsk(spool, {
    question: "decided", channelId: "1", messageId: null, approvers: [APPROVER],
  });
  decideAsk(spool, decided.askId, "approved", `companion:${APPROVER}`);
  const first = stampAskEnqueued(spool, decided.askId);
  assert.ok(first && first.enqueuedAt > 0, "first claim stamps and returns the record");
  assert.equal(stampAskEnqueued(spool, decided.askId), null, "second claim is null — exactly-once");
  assert.equal(stampAskEnqueued(spool, "no-such-ask"), null);
  assert.ok(getAsk(spool, decided.askId).enqueuedAt > 0, "stamp persisted");
});

test("listCompanionDecisions: only terminal, companion-sourced, undelivered asks", () => {
  const spool = tmpSpool();
  const comp = createPendingAsk(spool, { question: "phone", channelId: "1", messageId: null, approvers: [APPROVER] });
  decideAsk(spool, comp.askId, "approved", "companion:SHA256:abc123");
  const click = createPendingAsk(spool, { question: "click", channelId: "1", messageId: null, approvers: [APPROVER] });
  decideAsk(spool, click.askId, "denied", APPROVER); // Discord click — not companion's to deliver
  const auto = createPendingAsk(spool, { question: "auto", channelId: "1", messageId: null, approvers: [APPROVER], ttlMs: 1, onExpiry: "approve" });
  sweepExpiredAsks(spool, Date.now() + 10_000); // → approved/auto-expiry
  const delivered = createPendingAsk(spool, { question: "done", channelId: "1", messageId: null, approvers: [APPROVER] });
  decideAsk(spool, delivered.askId, "approved", "companion:SHA256:xyz789");
  stampAskEnqueued(spool, delivered.askId);
  const open = createPendingAsk(spool, { question: "open", channelId: "1", messageId: null, approvers: [APPROVER] });

  const ids = listCompanionDecisions(spool).map((r) => r.askId);
  assert.deepEqual(ids, [comp.askId], "click/auto/expired/stamped/pending all excluded");
  assert.ok(!ids.includes(open.askId));
});

test("renderAskForApp: question + clock + lazy flag, and NOTHING else", () => {
  const spool = tmpSpool();
  const rec = createPendingAsk(spool, {
    question: "ship it?", channelId: "1555103465179455488", messageId: "999", approvers: [APPROVER], onExpiry: "approve",
  });
  const view = renderAskForApp(rec);
  assert.deepEqual(Object.keys(view).sort(), ["askId", "createdAt", "expiresAt", "lazy", "question"]);
  assert.equal(view.lazy, true);
  assert.equal(view.question, "ship it?");
  assert.equal(view.channelId, undefined, "no channel ids on the phone surface");
  assert.equal(view.approvers, undefined);
});

test("countdown edit (TODO round): one ⏳ line, replaced not duplicated, null when terminal", () => {
  const spool = tmpSpool();
  const rec = createPendingAsk(spool, { question: "fuse?", channelId: "1", messageId: "m1", approvers: [APPROVER] });
  const now = Date.now();
  // 5.5 minutes left → ceil = 6, never 0
  const t0 = rec.expiresAt - 330_000;
  const first = buildAskCountdownEdit(`**fuse?**\nbuttons above`, rec, t0);
  assert.ok(first);
  assert.equal(first.minutesLeft, 6);
  assert.ok(first.content.endsWith("⏳ 6m left"));
  // second edit on ALREADY-countdown content → the old line is replaced
  const second = buildAskCountdownEdit(first.content, rec, t0 + 60_000);
  assert.ok(second);
  assert.equal(second.content.match(/⏳/g)?.length, 1, "exactly one countdown line");
  assert.ok(second.content.endsWith("⏳ 5m left"));
  assert.ok(second.content.includes("**fuse?**"), "question text preserved");
  // sub-minute remainder floors to "1m left", never 0
  const last = buildAskCountdownEdit(first.content, rec, rec.expiresAt - 5_000);
  assert.equal(last?.minutesLeft, 1);
  // terminal states: decided → null; past expiry → null (expiry sweep owns it)
  const decided = decideAsk(spool, rec.askId, "approved", APPROVER);
  assert.equal(buildAskCountdownEdit("x", decided, now), null);
  assert.equal(buildAskCountdownEdit("x", { status: "pending", expiresAt: now - 1 }, now), null);
});

// --- Components V2 ask cards (TODO round 2026-10-04) ---------------------------
// The V2 flag is permanent per-message, so the two shapes coexist forever:
// these pin the tree shape, the shape gate, the clock slot contract, and the
// edit surgery (question verbatim, clock swapped, buttons never re-enabled).
test("ask V2: container tree shape, custom_id law, shape gate", () => {
  assert.equal(ASK_V2_FLAG, 32_768, "flag value is 1 << 15 (MessageFlags.IsComponentsV2)");
  const tree = buildAskV2Components("abc123", "ship it?\nline two", { clockLine: "⏳ 5m left" });
  assert.equal(tree.length, 1);
  const c = tree[0];
  assert.equal(c.type, 17); // container
  assert.equal(typeof c.accent_color, "number");
  const [q, clock, row] = c.components;
  assert.equal(q.type, 10); // text display
  assert.equal(q.id, 1);
  assert.equal(q.content, "ship it?\nline two"); // composed text rides verbatim
  assert.equal(clock.type, 10);
  assert.equal(clock.id, 2);
  assert.equal(clock.content, "⏳ 5m left");
  assert.equal(row.type, 1); // action row
  assert.equal(row.id, 3);
  assert.deepEqual(
    row.components.map((b) => [b.label, b.custom_id, b.disabled]),
    [
      ["Approve", "ask:abc123:approve", false],
      ["Deny", "ask:abc123:deny", false],
      ["YOLO", "ask:abc123:yolo", false],
    ],
    "custom_id contract IDENTICAL to the legacy row — clicks never know the shape",
  );
  // disabled variant (not used by the post path; the rebuild path owns edits)
  assert.equal(buildAskV2Components("x9", "q", { clockLine: "c", disabled: true })[0].components[2].components[0].disabled, true);
  // shape gate: container tree → true; legacy row / empty / junk → false
  assert.equal(isAskV2Message(tree), true);
  assert.equal(isAskV2Message(buildAskComponents("abc123")), false);
  assert.equal(isAskV2Message([]), false);
  assert.equal(isAskV2Message(undefined), false);
});

test("ask V2: clock line math shared with the legacy sentinel edit", () => {
  const soon = Date.now() + 330_000; // 5.5 min → ceil 6
  assert.equal(askClockLine({ status: "pending", expiresAt: soon }), "⏳ 6m left");
  assert.equal(askClockLine({ status: "pending", expiresAt: Date.now() + 5_000 }), "⏳ 1m left", "min 1");
  assert.equal(askClockLine({ status: "approved", expiresAt: soon }), null);
  assert.equal(askClockLine({ status: "pending", expiresAt: Date.now() - 1 }), null);
});

test("ask V2: edit surgery — clock swapped, question verbatim, buttons never re-enabled", () => {
  const tree = buildAskV2Components("abc123", "the QUESTION stays byte-exact", { clockLine: "⏳ 60m left" });
  // terminal edit: decision line lands in the clock slot, buttons disabled
  const terminal = rebuildAskV2ForEdit(tree, "Approved by tyler · 12:00:00Z", { disabled: true });
  const tc = terminal[0].components;
  assert.equal(tc[0].content, "the QUESTION stays byte-exact");
  assert.equal(tc[1].content, "Approved by tyler · 12:00:00Z");
  assert.ok(tc[2].components.every((b) => b.disabled === true));
  assert.deepEqual(tc[2].components.map((b) => b.custom_id), ["ask:abc123:approve", "ask:abc123:deny", "ask:abc123:yolo"]);
  // countdown edit: disabled UNDEFINED must not touch clickability — a tick
  // racing the decision edit can never re-enable buttons
  const disabledTree = rebuildAskV2ForEdit(tree, "x", { disabled: true });
  const ticked = rebuildAskV2ForEdit(disabledTree, "⏳ 30m left", {});
  assert.ok(ticked[0].components[2].components.every((b) => b.disabled === true), "undefined disabled passes through");
  // non-container tops and non-matching children pass through untouched
  const mixed = [{ type: 1, components: [{ type: 2, custom_id: "ask:abc123:approve" }] }, ...rebuildAskV2ForEdit(tree, "y", { disabled: true })];
  const out = rebuildAskV2ForEdit(mixed, "z", { disabled: true });
  assert.deepEqual(out[0], mixed[0], "legacy row tops untouched");
  // discord.js class instances (toJSON) normalize before surgery
  const classy = [
    {
      toJSON: () => ({ type: 17, id: 0, accent_color: 1, components: [
        { toJSON: () => ({ type: 10, id: 1, content: "q" }) },
        { toJSON: () => ({ type: 10, id: 2, content: "old" }) },
      ] }),
    },
  ];
  const norm = rebuildAskV2ForEdit(classy, "⏳ 2m left", {});
  assert.equal(norm[0].components[1].content, "⏳ 2m left");
  assert.equal(norm[0].components[0].content, "q");
  assert.ok(!("toJSON" in norm[0]), "output is plain data");
});

test("ask registry hygiene: terminal records GC at 7d; undelivered companion decisions kept", async () => {
  const { sweepTerminalAsks, asksDir } = await import("../dist/asks.js");
  const spool = tmpSpool();
  const dir = asksDir(spool);
  fs.mkdirSync(dir, { recursive: true });
  const old = Date.now() - 8 * 24 * 3600_000;
  const write = (rec) => fs.writeFileSync(path.join(dir, `${rec.askId}.json`), JSON.stringify(rec));
  // a live pending ask — untouchable
  const live = createPendingAsk(spool, { question: "live?", channelId: "1", messageId: null, approvers: [APPROVER] });
  // terminal + delivered + old → gone
  write({ askId: "gone-approved", question: "q", channelId: "1", messageId: null, approvers: [], createdAt: old - 1000, expiresAt: old, status: "approved", decidedBy: APPROVER, decidedAt: old, enqueuedAt: old });
  // terminal (plain expiry, no decision run) + old → gone
  write({ askId: "gone-expired", question: "q", channelId: "1", messageId: null, approvers: [], createdAt: old, expiresAt: old, status: "expired" });
  // terminal + UNDELIVERED companion decision + old → KEPT (still owed a delivery stamp)
  write({ askId: "kept-undelivered", question: "q", channelId: "1", messageId: null, approvers: [], createdAt: old - 1000, expiresAt: old, status: "approved", decidedBy: "companion:SHA256:" + "a".repeat(43), decidedAt: old });
  // terminal but DECIDED RECENTLY (old creation) → kept
  write({ askId: "kept-recent", question: "q", channelId: "1", messageId: null, approvers: [], createdAt: old, expiresAt: old, status: "denied", decidedBy: APPROVER, decidedAt: Date.now() - 1000 });
  const removed = sweepTerminalAsks(spool).sort();
  assert.deepEqual(removed, ["gone-approved", "gone-expired"]);
  for (const id of ["gone-approved", "gone-expired"]) {
    assert.ok(!fs.existsSync(path.join(dir, `${id}.json`)), `${id} removed`);
  }
  for (const id of [live.askId, "kept-undelivered", "kept-recent"]) {
    assert.ok(fs.existsSync(path.join(dir, `${id}.json`)), `${id} kept`);
  }
});
