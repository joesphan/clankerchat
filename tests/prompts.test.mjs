import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createPhonePrompt,
  getPrompt,
  listPhonePrompts,
  listClaimablePrompts,
  stampPromptEnqueued,
  finishPrompt,
  sweepExpiredPrompts,
  renderPromptForApp,
  MAX_PENDING_PROMPTS,
  MAX_PROMPT_CHARS,
  PROMPT_TTL_MS,
} from "../dist/prompts.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-prompts-"));
}

test("create + list: trim, hard cap, deterministic order, fp provenance", () => {
  const dir = tmp();
  const a = createPhonePrompt(dir, { text: "  what's the machine doing?  ", fp: "SHA256:phone-a" });
  assert.equal(a.status, "pending");
  assert.equal(a.text, "what's the machine doing?", "trimmed");
  assert.match(a.promptId, /^pmt[a-z]{8}$/);
  const b = createPhonePrompt(dir, { text: "x".repeat(MAX_PROMPT_CHARS + 500), fp: "SHA256:phone-a" });
  assert.equal(b.text.length, MAX_PROMPT_CHARS, "hard-capped, not rejected");
  const all = listPhonePrompts(dir);
  assert.equal(all.length, 2);
  assert.ok(all[0].createdAt <= all[1].createdAt, "oldest first");
  assert.equal(all[0].fp, "SHA256:phone-a", "creator provenance is the signing key");
});

test("empty text refused", () => {
  const dir = tmp();
  assert.throws(() => createPhonePrompt(dir, { text: "   ", fp: "fp" }), /empty/);
  assert.throws(() => createPhonePrompt(dir, { text: "hi", fp: "" }), /fingerprint/);
});

test("pending-queue cap: thumb-mash guard throws at MAX_PENDING_PROMPTS", () => {
  const dir = tmp();
  for (let i = 0; i < MAX_PENDING_PROMPTS; i++) {
    createPhonePrompt(dir, { text: `prompt ${i}`, fp: "fp" });
  }
  assert.throws(() => createPhonePrompt(dir, { text: "one too many", fp: "fp" }), /queue full/);
  // terminal records free capacity — finished prompts don't count as in-flight
  const first = listPhonePrompts(dir)[0];
  stampPromptEnqueued(dir, first.promptId);
  finishPrompt(dir, first.promptId, { exit: 0, posted: true });
  createPhonePrompt(dir, { text: "fits now", fp: "fp" }); // no throw
});

test("stampPromptEnqueued is exactly-once — racing sweeps get one winner", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "claim me", fp: "fp" });
  const first = stampPromptEnqueued(dir, rec.promptId);
  assert.equal(first.status, "enqueued");
  assert.ok(first.enqueuedAt);
  assert.equal(stampPromptEnqueued(dir, rec.promptId), null, "second claim loses");
  // pending-only: an expired record can never be claimed either
  const old = createPhonePrompt(dir, { text: "stale", fp: "fp" });
  const staleRec = getPrompt(dir, old.promptId);
  const doctored = { ...staleRec, status: "expired" };
  fs.writeFileSync(path.join(dir, "pending-prompts", `${old.promptId}.json`), JSON.stringify(doctored));
  assert.equal(stampPromptEnqueued(dir, old.promptId), null);
});

test("finishPrompt: exit 0 = answered (post or protocol silence), nonzero = failed", () => {
  const dir = tmp();
  const a = createPhonePrompt(dir, { text: "answered with post", fp: "fp" });
  stampPromptEnqueued(dir, a.promptId);
  const done = finishPrompt(dir, a.promptId, { exit: 0, posted: true });
  assert.equal(done.status, "answered");
  assert.equal(done.posted, true);
  assert.ok(done.finishedAt);

  const b = createPhonePrompt(dir, { text: "answered silently", fp: "fp" });
  stampPromptEnqueued(dir, b.promptId);
  assert.equal(finishPrompt(dir, b.promptId, { exit: 0, posted: false }).status, "answered");

  const c = createPhonePrompt(dir, { text: "crashed", fp: "fp" });
  stampPromptEnqueued(dir, c.promptId);
  assert.equal(finishPrompt(dir, c.promptId, { exit: 1, posted: false }).status, "failed");

  // only an ENQUEUED record can finish — a second stamp loses, a pending one refuses
  const d = createPhonePrompt(dir, { text: "pending", fp: "fp" });
  assert.equal(finishPrompt(dir, d.promptId, { exit: 0, posted: true }), null);
  assert.equal(finishPrompt(dir, a.promptId, { exit: 0, posted: true }), null, "already terminal");
});

test("TTL sweep: overdue pending → expired; fresh ones untouched", async () => {
  const dir = tmp();
  const stale = createPhonePrompt(dir, { text: "stale", fp: "fp" });
  await new Promise((r) => setTimeout(r, 20)); // real gap, not a same-ms tie
  const fresh = createPhonePrompt(dir, { text: "fresh", fp: "fp" });
  // jump 10ms past the STALE one's TTL — fresh (20ms newer) still has life left
  const now = stale.createdAt + PROMPT_TTL_MS + 10;
  const swept = sweepExpiredPrompts(dir, now);
  assert.deepEqual(swept.map((r) => r.promptId), [stale.promptId]);
  assert.equal(getPrompt(dir, stale.promptId).status, "expired");
  assert.equal(getPrompt(dir, fresh.promptId).status, "pending");
  assert.deepEqual(listClaimablePrompts(dir).map((r) => r.promptId), [fresh.promptId], "expired never claimable");
});

test("renderPromptForApp: minimum surface — no fp, no ids beyond the prompt id", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "render me", fp: "SHA256:secret-fp" });
  const view = renderPromptForApp(rec);
  assert.deepEqual(Object.keys(view).sort(), ["createdAt", "finishedAt", "promptId", "status", "text"]);
  assert.equal(JSON.stringify(view).includes("SHA256:secret-fp"), false, "no fingerprint on the wire");
});
