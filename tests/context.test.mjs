// openwolf context store — three read-only surfaces (round 3, gate approved
// 2026-10-04). Covers: the slug path jail (traversal can't escape the store),
// front-matter parsing, the search cap, and read-miss behavior. The real
// seeded topics under docs/context/ are exercised too — they are part of the
// shipped surface, not fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listContext, readContext, searchContext } from "../dist/context.js";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");

function tmpStore() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ctx-"));
  const topics = path.join(base, "docs", "context", "topics");
  fs.mkdirSync(topics, { recursive: true });
  fs.writeFileSync(
    path.join(topics, "alpha.md"),
    "---\ntitle: Alpha topic\ntags: [one, two]\nupdated: 2026-10-04\nowner: gateway\n---\n\nAlpha body line.\nNeedle appears here.\n",
  );
  fs.writeFileSync(path.join(topics, "beta.md"), "---\ntitle: Beta\ntags: []\nupdated: 2026-10-03\n---\n\nBeta has nothing relevant.\n");
  fs.writeFileSync(path.join(topics, "not-markdown.txt"), "ignored by listing\n");
  return base;
}

test("listContext: entries from front-matter, .md only, sorted; txt ignored", () => {
  const base = tmpStore();
  const entries = listContext(base);
  assert.deepEqual(entries.map((e) => e.topic), ["alpha", "beta"]);
  const alpha = entries[0];
  assert.equal(alpha.title, "Alpha topic");
  assert.deepEqual(alpha.tags, ["one", "two"]);
  assert.equal(alpha.updated, "2026-10-04");
  assert.ok(alpha.bytes > 0);
});

test("readContext: body without front-matter, meta parsed; missing topic → null", () => {
  const base = tmpStore();
  const doc = readContext(base, "alpha");
  assert.equal(doc.title, "Alpha topic");
  assert.match(doc.body, /^Alpha body line\./);
  assert.ok(!doc.body.includes("title:"), "front-matter stripped from body");
  assert.equal(readContext(base, "nope"), null);
});

test("readContext slug jail: traversal, separators, dots, empty — all null, no fs escape", () => {
  const base = tmpStore();
  for (const bad of ["../secrets", "a/b", "..", "", "UPPER", "a_b", "a b", ".", "a.".repeat(40), "x".repeat(65)]) {
    assert.equal(readContext(base, bad), null, `must reject ${JSON.stringify(bad)}`);
  }
  // a slug that RESOLVES outside but matches the pattern is still contained:
  // resolve() of "topics/<slug>.md" with a pattern-validated slug cannot
  // contain a separator, so the prefix check is belt-and-braces — proven by
  // the absence of any file read outside the store (no throw, null return).
});

test("searchContext: case-insensitive hits with file+line, capped at 20", () => {
  const base = tmpStore();
  const hits = searchContext(base, "needle");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].topic, "alpha");
  assert.equal(hits[0].line, 9); // counts from file start: 6 fence lines + blank + 2 body lines
  assert.match(hits[0].text, /Needle appears here/);
  assert.deepEqual(searchContext(base, "zzz-not-there"), []);
  // cap: one store, many matches → ≤20
  const many = path.join(base, "docs", "context", "topics");
  fs.writeFileSync(path.join(many, "gamma.md"), "---\ntitle: G\n---\n" + "match line\n".repeat(50));
  const capped = searchContext(base, "match line");
  assert.ok(capped.length <= 20 && capped.length > 0);
});

test("shipped store: our four seed topics + current-sync list, read, and search cleanly", () => {
  const entries = listContext(REPO);
  const topics = entries.filter((e) => e.section === "topics").map((e) => e.topic);
  for (const want of ["mention-mechanics", "orchestrator-laws", "e2e-countersink", "incident-record"]) {
    assert.ok(topics.includes(want), `seed topic ${want} present`);
  }
  assert.ok(entries.some((e) => e.section === "state" && e.topic === "current-sync"));
  const doc = readContext(REPO, "mention-mechanics");
  assert.equal(doc.title, "Mention mechanics (Discord API)");
  assert.ok(doc.body.includes("allowed_mentions"));
  const hits = searchContext(REPO, "allowed_mentions");
  assert.ok(hits.length > 0 && hits.length <= 20);
});
