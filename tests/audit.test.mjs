import test from "node:test";
import assert from "node:assert/strict";

import { AUDIT_ACTIONS, classifyAudit, filterAuditSince } from "../dist/audit.js";

const OPTS = { botId: "1555116018332864522", channelIds: ["1555103465179455488", "1555115816775720980"] };

test("audit: message deletes of the BOT's posts are critical; humans' are not ours", () => {
  const v = classifyAudit(
    { id: "1", action: AUDIT_ACTIONS.MESSAGE_DELETE, executorId: "210949752617959424", targetId: OPTS.botId, channelId: null },
    OPTS,
  );
  assert.equal(v.severity, "critical");
  assert.match(v.label, /bot posts deleted/);

  const null_ = classifyAudit(
    { id: "2", action: AUDIT_ACTIONS.MESSAGE_DELETE, executorId: "210949752617959424", targetId: "187396435283542016", channelId: null },
    OPTS,
  );
  assert.equal(null_, null); // a human deleting a human message = moderation, not our blast radius
});

test("audit: watched-channel surgery — delete critical, modify/overwrites notify", () => {
  const del = classifyAudit(
    { id: "3", action: AUDIT_ACTIONS.CHANNEL_DELETE, executorId: "u1", targetId: OPTS.channelIds[0], channelId: null },
    OPTS,
  );
  assert.equal(del.severity, "critical");

  const upd = classifyAudit(
    { id: "4", action: AUDIT_ACTIONS.CHANNEL_UPDATE, executorId: "u1", targetId: OPTS.channelIds[1], channelId: null },
    OPTS,
  );
  assert.equal(upd.severity, "notify");

  const ow = classifyAudit(
    { id: "5", action: AUDIT_ACTIONS.CHANNEL_OVERWRITE_UPDATE, executorId: "u1", targetId: null, channelId: OPTS.channelIds[0] },
    OPTS,
  );
  assert.equal(ow.severity, "notify");

  // same actions on FOREIGN channels are noise
  assert.equal(
    classifyAudit({ id: "6", action: AUDIT_ACTIONS.CHANNEL_DELETE, executorId: "u1", targetId: "999", channelId: null }, OPTS),
    null,
  );
});

test("audit: webhook created in a watched channel is critical (B6 spoof class at the source)", () => {
  const v = classifyAudit(
    { id: "7", action: AUDIT_ACTIONS.WEBHOOK_CREATE, executorId: "u1", targetId: "w1", channelId: OPTS.channelIds[0] },
    OPTS,
  );
  assert.equal(v.severity, "critical");
  assert.match(v.label, /webhook created/);

  // webhook elsewhere, or update/delete here → notify at most
  assert.equal(classifyAudit({ id: "8", action: AUDIT_ACTIONS.WEBHOOK_CREATE, executorId: "u1", targetId: "w1", channelId: "999" }, OPTS), null);
  assert.equal(
    classifyAudit({ id: "9", action: AUDIT_ACTIONS.WEBHOOK_DELETE, executorId: "u1", targetId: "w1", channelId: OPTS.channelIds[1] }, OPTS).severity,
    "notify",
  );
});

test("audit: the bot kicked or re-rolled is critical", () => {
  const kick = classifyAudit({ id: "10", action: AUDIT_ACTIONS.MEMBER_KICK, executorId: "u1", targetId: OPTS.botId, channelId: null }, OPTS);
  assert.equal(kick.severity, "critical");

  const roles = classifyAudit({ id: "11", action: AUDIT_ACTIONS.MEMBER_ROLE_UPDATE, executorId: "u1", targetId: OPTS.botId, channelId: null }, OPTS);
  assert.equal(roles.severity, "critical");

  assert.equal(classifyAudit({ id: "12", action: AUDIT_ACTIONS.MEMBER_KICK, executorId: "u1", targetId: "someone-else", channelId: null }, OPTS), null);
});

test("audit: labels carry ids, never names — a hidden executor is named honestly", () => {
  const v = classifyAudit({ id: "13", action: AUDIT_ACTIONS.WEBHOOK_CREATE, executorId: null, targetId: "w1", channelId: OPTS.channelIds[0] }, OPTS);
  assert.match(v.label, /no longer names/);
  assert.ok(!v.label.includes("<@"));
});

test("audit: filterAuditSince — strictly newer, oldest first, malformed skipped", () => {
  const entries = [
    { id: "300", action: 1, executorId: null, targetId: null, channelId: null },
    { id: "100", action: 1, executorId: null, targetId: null, channelId: null },
    { id: "200", action: 1, executorId: null, targetId: null, channelId: null },
    { id: "150", action: 1, executorId: null, targetId: null, channelId: null },
    { id: "not-a-snowflake", action: 1, executorId: null, targetId: null, channelId: null },
  ];
  const fresh = filterAuditSince(entries, "100");
  assert.deepEqual(fresh.map((e) => e.id), ["150", "200", "300"]);
  // lastId "0" or empty → everything (first sweep after boot)
  assert.equal(filterAuditSince(entries, "0").length, 4);
});
