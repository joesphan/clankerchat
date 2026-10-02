import test from "node:test";
import assert from "node:assert/strict";
import { findLeakSignals, leakRefusal } from "../dist/leaks.js";

test("findLeakSignals: every deployment secret shape is caught", () => {
  assert.deepEqual(findLeakSignals("cfut_ABCdef12345"), ["cloudflare api token"]);
  assert.deepEqual(findLeakSignals("headscale key hskey-abcdefghij0123456789"), ["headscale auth key"]);
  assert.deepEqual(findLeakSignals("ghp_" + "a".repeat(36)), ["github token"]);
  assert.deepEqual(findLeakSignals("gho_" + "A1b2".repeat(9)), ["github token"]);
  assert.deepEqual(findLeakSignals("sk-" + "z".repeat(32)), ["api key (sk-…)"]);
  assert.deepEqual(findLeakSignals("xoxb-123456789012-abcdef"), ["slack token"]);
  assert.deepEqual(
    findLeakSignals("-----BEGIN OPENSSH PRIVATE KEY-----\nMIb3NzaC1kc3MA"),
    ["private key material"],
  );
  assert.deepEqual(findLeakSignals("-----BEGIN RSA PRIVATE KEY-----"), ["private key material"]);
  assert.deepEqual(findLeakSignals("-----BEGIN ENCRYPTED PRIVATE KEY-----"), ["private key material"]);
  assert.deepEqual(findLeakSignals("DISCORD_TOKEN=MTIzNDU2Nzg5MDEyMzQ1Njc4"), [
    "discord bot token assignment",
  ]);
});

test("findLeakSignals: discussion of tokens without the live shape stays clean", () => {
  // Naming the prefix while discussing rotation is legitimate ops talk.
  assert.deepEqual(findLeakSignals("rotate the cfut_ token, it was exfiltrated"), []);
  assert.deepEqual(findLeakSignals("the hskey- format is headscale auth keys"), []);
  assert.deepEqual(findLeakSignals("env var DISCORD_TOKEN is in .env"), []);
});

test("findLeakSignals: public material never matches", () => {
  // Public key lines share the PEM header shape minus "PRIVATE" — must not trip.
  assert.deepEqual(findLeakSignals("-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq"), []);
  assert.deepEqual(
    findLeakSignals("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDe4+8L3 tyler@cachy"),
    [],
  );
  // Hashes, commit SHAs, UUIDs, base64 blobs: no secret prefixes.
  assert.deepEqual(findLeakSignals("sha256:9ed9f7fabc1234567890abcdef0123456789abcdef"), []);
  assert.deepEqual(findLeakSignals("commit 1a7553f58d2e91c4a7b3f0d5e6a7b8c9d0e1f2a3"), []);
  assert.deepEqual(findLeakSignals("correlation 550e8400-e29b-41d4-a716-446655440000"), []);
});

test("findLeakSignals: multiple kinds in one text all surface, deduplicated", () => {
  const kinds = findLeakSignals(
    `leak both: sk-${"q".repeat(30)} and ghp_${"b".repeat(40)} and again sk-${"q".repeat(30)}`,
  );
  assert.deepEqual(kinds.sort(), ["api key (sk-…)", "github token"]);
});

test("findLeakSignals: empty/undefined-ish input is clean, not a crash", () => {
  assert.deepEqual(findLeakSignals(""), []);
  assert.deepEqual(findLeakSignals(undefined), []);
});

test("leakRefusal: names the kinds and starts with REFUSED (the send-side alarm prefix)", () => {
  const text = leakRefusal(["github token"]);
  assert.match(text, /^REFUSED: outbound text matches secret-shape patterns \(github token\)/);
  assert.match(text, /never leave through this channel/);
});

test("short stubs that share a prefix but are not token-shaped stay clean", () => {
  // Under the length thresholds = almost certainly prose/code identifiers, not live secrets.
  assert.deepEqual(findLeakSignals("cfut_short"), []);
  assert.deepEqual(findLeakSignals("sk-tooshort"), []);
  assert.deepEqual(findLeakSignals("xox-notas-1"), []);
});
