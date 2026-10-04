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
  ASK_TTL_MS,
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
} from "../dist/asks.js";

function tmpSpool() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-asks-"));
}

const APPROVER = "187396435283542016"; // 18-digit snowflake shape

// --- payload shape -----------------------------------------------------------

test("buildAskComponents: one action row, Approve green + Deny red, custom_ids follow the contract", () => {
  const askId = newAskId();
  const rows = buildAskComponents(askId);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.type, 1); // ACTION_ROW
  assert.equal(row.components.length, 2);
  const [approve, deny] = row.components;
  assert.equal(approve.type, 2); // BUTTON
  assert.equal(approve.style, 3); // Success (green)
  assert.equal(approve.label, "Approve");
  assert.equal(deny.style, 4); // Danger (red)
  assert.equal(deny.label, "Deny");
  // custom_id contract: ask:<id>:<action>, ≤100 chars (Discord's cap)
  assert.equal(approve.custom_id, `ask:${askId}:approve`);
  assert.equal(deny.custom_id, `ask:${askId}:deny`);
  assert.ok(approve.custom_id.length <= 100 && deny.custom_id.length <= 100);
  assert.ok(!("disabled" in approve) && !("disabled" in deny), "live buttons are not disabled");
});

test("buildDisabledAskComponents: same row, both buttons disabled, custom_ids intact", () => {
  const askId = newAskId();
  const [row] = buildDisabledAskComponents(askId);
  assert.equal(row.components.length, 2);
  for (const b of row.components) {
    assert.equal(b.disabled, true);
    assert.ok(parseAskCustomId(b.custom_id), "disabled custom_id still parses");
  }
});

// --- custom_id gate ----------------------------------------------------------

test("askCustomId ↔ parseAskCustomId round-trips both actions", () => {
  const askId = newAskId();
  assert.deepEqual(parseAskCustomId(askCustomId(askId, "approve")), { askId, action: "approve" });
  assert.deepEqual(parseAskCustomId(askCustomId(askId, "deny")), { askId, action: "deny" });
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

test("askDecisionLine renders Approved/Denied with the decider's display name", () => {
  const approved = { status: "approved", decidedAt: Date.UTC(2026, 9, 4, 12, 34, 56) };
  const line = askDecisionLine(approved, "fast335xi");
  assert.match(line, /^Approved by fast335xi · 12:34:56Z$/);
  assert.equal(askDecisionLine({ status: "denied", decidedAt: 0 }, "x"), "Denied by x · 00:00:00Z");
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
