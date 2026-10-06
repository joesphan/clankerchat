import test from "node:test";
import assert from "node:assert/strict";
import { prespawnClass } from "../dist/prespawn.js";

const ack = (s) => prespawnClass(s)?.kind === "ack";
const status = (s) => prespawnClass(s)?.kind === "status";

// ---- ack shapes ----
test("bare ack words", () => {
  for (const s of ["ok", "OK", "Okay", "k", "kk", "ok!", "ok.", "ok?", "ok!!", "thanks", "THANK YOU", "thx", "ty", "nice", "good", "great", "cool", "perfect", "np", "got it", "sounds good", "roger that", "understood", "lol", "lmao", "haha", "same", "gg", "f", "rip", "based", "w", "alright", "o7", "no problem"]) {
    assert.ok(ack(s), `expected ack: ${s}`);
  }
});

test("emoji-only clusters", () => {
  for (const s of ["👍", "🔥🔥", "💀", "🙌", "😂", "👍 🔥", "👎", "🤝"]) assert.ok(ack(s), `expected ack: ${s}`);
});

test("ack word + trailing emoji", () => {
  for (const s of ["ok 👍", "nice 🔥", "thanks 💯🙌", "gg 👏"]) assert.ok(ack(s), `expected ack: ${s}`);
});

test("mention-prefixed acks (how triggers arrive)", () => {
  assert.ok(ack("<@1555116018332864522> ok"));
  assert.ok(status("<@1555116018332864522>  status"));
  assert.ok(status("<@!1555116018332864522> <@1555109304351064074> status?"));
  assert.ok(ack("  <@123456789012345678>   thanks!  "));
});

// ---- status shapes ----
test("status shapes", () => {
  for (const s of ["status", "status?", "STATUS", "state", "stat", "what's the status", "whats the status?", "what's your status", "any status", "any status?"]) {
    assert.ok(status(s), `expected status: ${s}`);
  }
});

// ---- ambiguous words deliberately NOT acks ----
test("semantically loaded words fall through", () => {
  for (const s of ["yes", "no", "sure", "fine", "done", "go", "stop", "now", "please", "why", "what"]) {
    assert.ok(!prespawnClass(s), `must NOT classify: ${s}`);
  }
});

// ---- negatives: anything with content falls through ----
test("sentences, questions, directives fall through", () => {
  for (const s of [
    "ok now flash the firmware",
    "ok do it",
    "ok, but what about the ledger",
    "thanks, can you check the logs",
    "thanks that's exactly what I wanted to see",
    "status of the build?",
    "what's the status of the bake-off",
    "can you give me a status on the merge",
  ]) {
    assert.ok(!prespawnClass(s), `must fall through: ${s}`);
  }
  assert.ok(ack("ok?")); // punctuation alone never makes it a question
});

test("urls, markup, code, ids, multiline fall through", () => {
  for (const s of [
    "ok https://example.com",
    "ok <#1555103465179455488>",
    "ok <@&1234>",
    "thanks `code`",
    "ok 1556820659747950614",
    "ok\nok",
    "```ok```",
  ]) {
    assert.ok(!prespawnClass(s), `must fall through: ${s}`);
  }
});

test("over-cap and empty shapes fall through", () => {
  assert.ok(!prespawnClass(""));
  assert.ok(!prespawnClass(null));
  assert.ok(!prespawnClass(undefined));
  assert.ok(!prespawnClass("   "));
  assert.ok(ack("ok")); // sanity: plain ack still classifies
  assert.ok(!prespawnClass("ok ".repeat(20).trim())); // 59 chars > 48 cap
  assert.ok(!prespawnClass("<@123>")); // mention-only: not consumed cheaply
  assert.ok(!prespawnClass("42")); // digits are not an emoji ack
});

test("remainder and reason are audit-friendly", () => {
  const m = prespawnClass("<@111222333444555666> Thanks!");
  assert.equal(m.kind, "ack");
  assert.equal(m.remainder, "Thanks!");
  assert.match(m.reason, /^shape:ack:/);
  const s = prespawnClass("status?");
  assert.equal(s.kind, "status");
  assert.equal(s.reason, "shape:status");
});
