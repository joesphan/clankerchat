import test from "node:test";
import assert from "node:assert/strict";
import {
  TYPING_BEAT_MS,
  STATUS_AFTER_MS,
  STATUS_EDIT_MS,
  shouldHaveStatusLine,
  statusLine,
  nextStatusDelayMs,
  salvagePostLine,
  isTransientOwnPost,
} from "../dist/run-progress.js";
import { renderStatusCard } from "../dist/slash.js";

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

test("salvagePostLine (round 18): composes the crash salvage line the matcher class covers", () => {
  assert.match(salvagePostLine("timed out at 10 min"), /^run timed out at 10 min before posting in-thread — /);
  assert.match(salvagePostLine("exited early (code 1)"), /^run exited early \(code 1\) before posting in-thread — /);
  assert.match(salvagePostLine("exited early (code -9)"), /^run exited early \(code -9\) before posting in-thread — /);
  // the full line ends with the honest guidance, no dangling punctuation drift
  assert.ok(salvagePostLine("timed out at 10 min").endsWith("ask again or narrow the ask."));
});

test("isTransientOwnPost (round 18): matches the ACTUAL generators — template drift fails here", () => {
  // The drift-kill pins: matcher vs the real templates, not parallel prose.
  // Change statusLine/salvagePostLine/renderStatusCard wording without
  // updating isTransientOwnPost and this test breaks in the same commit.
  assert.equal(isTransientOwnPost(statusLine("", STATUS_AFTER_MS)), true);
  assert.equal(isTransientOwnPost(statusLine("", 5 * 60_000)), true);
  assert.equal(isTransientOwnPost(statusLine("thread \"shim\" (1555115816775720980)", 9 * 60_000 + 30_000)), true);
  assert.equal(isTransientOwnPost(salvagePostLine("timed out at 10 min")), true);
  assert.equal(isTransientOwnPost(salvagePostLine("exited early (code 1)")), true);
  assert.equal(isTransientOwnPost(salvagePostLine("exited early (code -9)")), true);
  // Canned status card: first line AND the whole multi-line card (first line
  // decides — the rest of the card is facts, never an answer).
  const card = renderStatusCard({
    bot: "fast-clank",
    uptimeMs: 90_000,
    active: 0,
    maxConcurrent: 2,
    queuedHuman: 0,
    queuedBot: 1,
    lastRunAgoMs: null,
    spoolPending: 3,
  });
  assert.equal(isTransientOwnPost(card.split("\n")[0]), true);
  assert.equal(isTransientOwnPost(card), true);
  // Card facts line alone (no header) is NOT transient-shaped — only the
  // header anchors the match.
  assert.equal(isTransientOwnPost(card.split("\n")[1]), false);
});

test("isTransientOwnPost: near-misses and real answers stay non-transient", () => {
  // truncated status line (no closing suffix)
  assert.equal(isTransientOwnPost("⏳ still working — 5m elapsed"), false);
  // trailing graft after the suffix
  assert.equal(isTransientOwnPost(statusLine("x", 5 * 60_000) + " extra"), false);
  // salvage-shaped prose missing the anchor phrase
  assert.equal(isTransientOwnPost("run timed out at 10 min — no post"), false);
  // card header missing the "(canned card, no model run)" suffix
  assert.equal(isTransientOwnPost("**fast-clank** — status (canned)"), false);
  // empty / absent
  assert.equal(isTransientOwnPost(""), false);
  assert.equal(isTransientOwnPost(undefined), false);
  assert.equal(isTransientOwnPost(null), false);
  // a real answer that merely MENTIONS working — no machinery prefix
  assert.equal(isTransientOwnPost("Still working on the migration — tests pass now."), false);
  // first-line anchoring: machinery text buried on line 2 does not count
  assert.equal(isTransientOwnPost("quick update\n" + statusLine("x", 5 * 60_000)), false);
});
