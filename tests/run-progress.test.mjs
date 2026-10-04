import test from "node:test";
import assert from "node:assert/strict";
import {
  TYPING_BEAT_MS,
  STATUS_AFTER_MS,
  STATUS_EDIT_MS,
  shouldHaveStatusLine,
  statusLine,
  nextStatusDelayMs,
} from "../dist/run-progress.js";

test("thresholds: typing beats stay inside Discord's 10s TTL; status line is late-only", () => {
  assert.ok(TYPING_BEAT_MS < 10_000);
  assert.ok(STATUS_AFTER_MS >= 4 * 60_000); // fast runs never get a line
  assert.ok(STATUS_EDIT_MS >= 60_000); // edits are minutes apart, not churn
});

test("shouldHaveStatusLine: no line before the threshold, line from it on", () => {
  assert.equal(shouldHaveStatusLine(0), false);
  assert.equal(shouldHaveStatusLine(STATUS_AFTER_MS - 1), false);
  assert.equal(shouldHaveStatusLine(STATUS_AFTER_MS), true);
  assert.equal(shouldHaveStatusLine(STATUS_AFTER_MS + 9 * 60_000), true);
});

test("statusLine: minutes floor at 1, label prefixes when present", () => {
  assert.match(statusLine("", STATUS_AFTER_MS), /^⏳ still working — 4m elapsed/);
  assert.match(statusLine("tick 316", 7 * 60_000 + 59_000), /^⏳ tick 316: still working — 7m elapsed/);
  // past the 4-min threshold the count can never read "0m"…
  assert.doesNotMatch(statusLine("x", STATUS_AFTER_MS + 500), /0m/);
  // …and the floor-1 guard itself is proven directly: sub-minute elapsed → 1m
  assert.match(statusLine("x", 30_000), /— 1m elapsed/);
});

test("nextStatusDelayMs: counts down to appearance, then to the next edit boundary", () => {
  // 1 min in: 3 min until the line appears
  assert.equal(nextStatusDelayMs(60_000), STATUS_AFTER_MS - 60_000);
  // exactly at threshold: a full edit cycle until the next edit
  assert.equal(nextStatusDelayMs(STATUS_AFTER_MS), STATUS_EDIT_MS);
  // 1s past an edit boundary: ~a full cycle minus that 1s
  const d = nextStatusDelayMs(STATUS_AFTER_MS + STATUS_EDIT_MS + 1_000);
  assert.equal(d, STATUS_EDIT_MS - 1_000);
  // never returns 0/the spin floor holds even on a boundary instant
  assert.ok(nextStatusDelayMs(STATUS_AFTER_MS + STATUS_EDIT_MS) >= 1_000);
});
