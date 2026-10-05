import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanPromptUsage, promptsLine, scanTokenUsage } from "../dist/promptmeter.js";

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
function usageLine(ts, u, extra = "") {
  const model = u.model ?? "glm-5.3";
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u };
  delete usage.model;
  return `{"type":"assistant","timestamp":"${ts}","message":{"role":"assistant","model":"${model}","usage":${JSON.stringify(usage)}},"sessionId":"s1"${extra}}`;
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

test("serializer-shape tolerance: spaced JSON counts exactly like compact (r28 L8)", async () => {
  const root = tmpRoot();
  // A JSON writer change (`"type": "user"` with a space) must not zero the
  // meter: the substring fast-path accepts both shapes; JSON.parse stays the
  // semantic gate either way.
  const spacedUser = userLine(IN).replace('"type":"user"', '"type": "user"');
  const spacedSidechain = sidechainLine(IN).replace('"type":"user"', '"type": "user"');
  const spacedUsage = usageLine(IN, { input_tokens: 100, output_tokens: 10 }).replace('"type":"assistant"', '"type": "assistant"');
  writeProj(root, "-home-tyler-app", { "a.jsonl": [spacedUser, spacedSidechain, spacedUsage] });
  const s = await scanPromptUsage({ projectsRoot: root, now: NOW, cap: 100 });
  assert.equal(s.turns, 1, "spaced user line still counted as a turn");
  assert.equal(s.sidechain, 1, "spaced sidechain still separated");
  const t = await scanTokenUsage({ projectsRoot: root, now: NOW });
  assert.equal(t.total.input, 100, "spaced assistant usage still metered");
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

test("token meter: per-class sums, model split, sidechain split, window filter (round 25)", async () => {
  const root = tmpRoot();
  writeProj(root, "-fit", {
    "a.jsonl": [
      usageLine(IN, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 300 }),
      usageLine(IN, { model: "haiku", input_tokens: 10, output_tokens: 20 }, ',"isSidechain":true'),
      usageLine(OUT, { input_tokens: 99999, output_tokens: 99999 }), // outside window
      assistantLine(IN), // no usage block → contributes nothing
      '{"type":"assistant","timestamp":"' + IN + '","message":{"usage":{', // torn tail
    ],
  });
  const t = await scanTokenUsage({ projectsRoot: root, now: NOW });
  assert.equal(t.mainline.input, 1000);
  assert.equal(t.mainline.output, 500);
  assert.equal(t.mainline.cacheRead, 20000);
  assert.equal(t.mainline.cacheCreation, 300);
  assert.equal(t.mainline.messages, 1);
  assert.equal(t.sidechain.input, 10, "sidechain split carries its own classes");
  assert.equal(t.sidechain.messages, 1);
  assert.equal(t.total.input, 1010, "total = mainline + sidechain");
  assert.equal(t.total.cacheRead, 20000);
  assert.equal(t.byModel.length, 2);
  assert.equal(t.byModel[0].model, "glm-5.3", "cache-heavy model ranks first by total tokens");
  assert.equal(t.byModel[0].sums.input, 1000);
  assert.equal(t.byModel[1].model, "haiku");
  assert.equal(t.byModel[1].sums.output, 20);
});

test("token meter: empty/missing root and mtime-stale files degrade to zeros", async () => {
  const t1 = await scanTokenUsage({ projectsRoot: "/nonexistent/definitely", now: NOW });
  assert.equal(t1.total.messages, 0);
  assert.deepEqual(t1.byModel, []);
  const root = tmpRoot();
  writeProj(root, "-old", { "stale.jsonl": [usageLine(IN, { input_tokens: 5000 })] });
  const old = new Date(NOW - 10 * 3600 * 1000);
  fs.utimesSync(path.join(root, "-old", "stale.jsonl"), old, old);
  const t2 = await scanTokenUsage({ projectsRoot: root, now: NOW });
  assert.equal(t2.total.input, 0, "stale file never opened");
});
