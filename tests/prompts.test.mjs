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
  sweepStuckEnqueued,
  STUCK_ENQUEUED_MS,
  renderPromptForApp,
  MAX_EXCERPT_CHARS,
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

test("stuck-enqueued sweep (audit fix 2): orphaned enqueued → failed; fresh enqueued + pending untouched", () => {
  const dir = tmp();
  // orphan: claimed but its run never stamped (queue drop / watcher crash
  // between claim and exit / spawn failure) — age it past the stuck window
  const orphan = createPhonePrompt(dir, { text: "orphan", fp: "fp" });
  const claimed = stampPromptEnqueued(dir, orphan.promptId);
  const doctored = JSON.parse(JSON.stringify(claimed));
  doctored.enqueuedAt -= STUCK_ENQUEUED_MS + 10;
  fs.writeFileSync(path.join(dir, "pending-prompts", `${orphan.promptId}.json`), JSON.stringify(doctored));
  // fresh enqueued (a live run owns it) + plain pending — both must survive
  const live = createPhonePrompt(dir, { text: "live", fp: "fp" });
  stampPromptEnqueued(dir, live.promptId);
  const pending = createPhonePrompt(dir, { text: "pending", fp: "fp" });

  const swept = sweepStuckEnqueued(dir, claimed.enqueuedAt);
  assert.deepEqual(swept.map((r) => r.promptId), [orphan.promptId]);
  const rot = getPrompt(dir, orphan.promptId);
  assert.equal(rot.status, "failed");
  assert.equal(rot.exit, -1, "exit recorded — the phone can say the run never finished");
  assert.equal(getPrompt(dir, live.promptId).status, "enqueued");
  assert.equal(getPrompt(dir, pending.promptId).status, "pending");
});

test("renderPromptForApp: minimum surface — no fp, no ids beyond the prompt id", () => {
  const dir = tmp();
  const rec = createPhonePrompt(dir, { text: "render me", fp: "SHA256:secret-fp" });
  const view = renderPromptForApp(rec);
  assert.deepEqual(Object.keys(view).sort(), ["answerExcerpt", "createdAt", "finishedAt", "promptId", "status", "text"]);
  assert.equal(view.answerExcerpt, null, "no excerpt before an answer exists");
  assert.equal(JSON.stringify(view).includes("SHA256:secret-fp"), false, "no fingerprint on the wire");
});

test("answer excerpt (round 5.1): normalized, capped, absent when empty, on the wire", () => {
  const dir = tmp();
  const a = createPhonePrompt(dir, { text: "with excerpt", fp: "fp" });
  stampPromptEnqueued(dir, a.promptId);
  const done = finishPrompt(dir, a.promptId, {
    exit: 0,
    posted: true,
    excerpt: "  The answer is 42.\n\nDetails   follow\nin the thread.  ",
  });
  assert.equal(done.answerExcerpt, "The answer is 42. Details follow in the thread.");
  assert.equal(renderPromptForApp(done).answerExcerpt, done.answerExcerpt, "excerpt rides the phone rendering");

  // hard cap at MAX_EXCERPT_CHARS
  const b = createPhonePrompt(dir, { text: "long", fp: "fp" });
  stampPromptEnqueued(dir, b.promptId);
  const capped = finishPrompt(dir, b.promptId, { exit: 0, posted: true, excerpt: "x".repeat(MAX_EXCERPT_CHARS + 500) });
  assert.equal(capped.answerExcerpt.length, MAX_EXCERPT_CHARS);

  // whitespace-only / missing excerpt → field absent (not an empty string)
  const c = createPhonePrompt(dir, { text: "silent", fp: "fp" });
  stampPromptEnqueued(dir, c.promptId);
  const silent = finishPrompt(dir, c.promptId, { exit: 0, posted: false, excerpt: "   \n\t  " });
  assert.equal(silent.answerExcerpt, undefined);
  assert.equal(renderPromptForApp(silent).answerExcerpt, null);
});
