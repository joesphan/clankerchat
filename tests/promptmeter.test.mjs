import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanPromptUsage, promptsLine } from "../dist/promptmeter.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "promptmeter-"));
}

const NOW = Date.parse("2026-10-05T04:30:00Z");
const IN = "2026-10-05T02:00:00Z"; // inside the 5h window
const OUT = "2026-10-04T20:00:00Z"; // outside

function userLine(ts, extra = "") {
  return `{"type":"user","timestamp":"${ts}","message":{"role":"user","content":"do the thing"},"sessionId":"s1"${extra}}`;
}
function toolResultLine(ts) {
  return `{"type":"user","timestamp":"${ts}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x"}]},"sessionId":"s1"}`;
}
function sidechainLine(ts) {
  return `{"type":"user","isSidechain":true,"timestamp":"${ts}","message":{"role":"user","content":"subagent chatter"},"sessionId":"s1"}`;
}
function compactLine(ts) {
  return `{"type":"user","isCompactSummary":true,"timestamp":"${ts}","message":{"role":"user","content":"compacted"},"sessionId":"s1"}`;
}
function assistantLine(ts) {
  return `{"type":"assistant","timestamp":"${ts}","message":{"role":"assistant","content":"ok"},"sessionId":"s1"}`;
}

function writeProj(root, proj, files) {
  const dir = path.join(root, proj);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), (Array.isArray(lines) ? lines : [lines]).join("\n") + "\n");
  }
}

test("counts user turns, excludes tool_result and sidechain, window-filters", async () => {
  const root = tmpRoot();
  writeProj(root, "-home-tyler-app", {
    "a.jsonl": [
      userLine(IN), // 1
      assistantLine(IN),
      toolResultLine(IN), // excluded
      userLine(OUT), // outside window
      assistantLine(OUT),
    ],
    "b.jsonl": [sidechainLine(IN), userLine(IN)], // 1 turn + 1 sidechain
  });
  const s = await scanPromptUsage({ projectsRoot: root, now: NOW, cap: 100 });
  assert.equal(s.turns, 2);
  assert.equal(s.sidechain, 1);
  assert.equal(s.activeSessions, 2);
  assert.equal(s.byProject.length, 1);
  assert.equal(s.byProject[0].project, "-home-tyler-app");
  assert.equal(s.byProject[0].sessions, 2);
  assert.equal(s.pctOfCap, 0.02);
  assert.equal(s.hot, false);
});

test("mtime filter: a file not touched in the window is never opened", async () => {
  const root = tmpRoot();
  writeProj(root, "-old", { "stale.jsonl": [userLine(IN)] });
  const old = new Date(NOW - 10 * 3600 * 1000); // vs the fixed scan clock — Date.now() would drift into the window after 2026-10-05T09:30Z
  fs.utimesSync(path.join(root, "-old", "stale.jsonl"), old, old); // Date, not ms — utimes treats numbers as SECONDS
  const s = await scanPromptUsage({ projectsRoot: root, now: NOW });
  assert.equal(s.turns, 0, "stale file skipped without reading");
});

test("hot flag trips at softPct and promptsLine renders it", async () => {
  const root = tmpRoot();
  writeProj(root, "-hot", { "h.jsonl": Array.from({ length: 9 }, (_, i) => userLine(IN)) });
  const s = await scanPromptUsage({ projectsRoot: root, now: NOW, cap: 10, softPct: 0.8 });
  assert.equal(s.turns, 9);
  assert.equal(s.hot, true);
  const line = promptsLine(s);
  assert.match(line, /prompts 9\/10 \(90\.0%\) · /);
  assert.match(line, /HOT/);
});

test("spam suspect: many tiny sessions in one project", async () => {
  const root = tmpRoot();
  const files = {};
  for (let i = 0; i < 6; i++) files[`s${i}.jsonl`] = [userLine(IN), userLine(IN)];
  writeProj(root, "-tmp", files);
  writeProj(root, "-real", { "one.jsonl": Array.from({ length: 30 }, () => userLine(IN)) });
  const s = await scanPromptUsage({ projectsRoot: root, now: NOW });
  assert.equal(s.spamSuspects.length, 1);
  assert.match(s.spamSuspects[0], /^-tmp \(6 sessions/);
  assert.equal(s.byProject[0].project, "-real", "real work outranks the storm");
});

test("unreadable/corrupt files and a missing root degrade to zeros, never throw", async () => {
  const s1 = await scanPromptUsage({ projectsRoot: "/nonexistent/definitely", now: NOW });
  assert.equal(s1.turns, 0);
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "-torn"), { recursive: true });
  fs.writeFileSync(path.join(root, "-torn", "t.jsonl"), '{"type":"user","timestamp":"' + IN + '","message":{'); // torn JSON — no trailing newline
  const s2 = await scanPromptUsage({ projectsRoot: root, now: NOW });
  assert.equal(s2.turns, 0);
  assert.ok(s2.byProject);
});

test("compaction summaries count separately; replenish projects oldest turn age-out; peak window flag (round 24)", async () => {
  const root = tmpRoot();
  writeProj(root, "-c", {
    "a.jsonl": [userLine("2026-10-05T00:30:00Z"), compactLine("2026-10-05T01:00:00Z"), userLine(IN)],
  });
  const s = await scanPromptUsage({ projectsRoot: root, now: NOW, cap: 100 });
  assert.equal(s.turns, 2, "human turns only");
  assert.equal(s.compact, 1, "compact summary split out of turns");
  assert.equal(s.sidechain, 0);
  // oldest turn 00:30Z + 5h window = 05:30Z; NOW = 04:30Z → 60 min to capacity
  assert.equal(Math.round(s.replenishInMs / 60000), 60);
  assert.match(promptsLine(s), /\+1@05:30Z/);
  assert.equal(s.peak, false, "04:30Z is outside the claimed 06:00–10:00Z peak");
  // inside the claimed peak window
  const s2 = await scanPromptUsage({ projectsRoot: root, now: Date.parse("2026-10-05T07:00:00Z"), cap: 100 });
  assert.equal(s2.peak, true);
  // compact-only window: counted (visible) but no turn → no replenish promise
  const onlyCompact = tmpRoot();
  writeProj(onlyCompact, "-k", { "k.jsonl": [compactLine("2026-10-05T06:30:00Z")] });
  const s3 = await scanPromptUsage({ projectsRoot: onlyCompact, now: Date.parse("2026-10-05T07:00:00Z") });
  assert.equal(s3.compact, 1);
  assert.equal(s3.turns, 0);
  assert.equal(s3.replenishInMs, null, "nothing gating → no age-out to project");
  assert.doesNotMatch(promptsLine(s3), /\+1@/);
});
