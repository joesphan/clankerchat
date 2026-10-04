import test from "node:test";
import assert from "node:assert/strict";

import { slashCommandSpec, renderStatusCard, registerSlashCommands } from "../dist/slash.js";

// Slash commands (owner green-lit 2026-10-04): the spec IS the wire contract
// with Discord (name/length constraints are enforced by the API at
// registration — a bad name 400s the whole bulk overwrite, taking /status
// down with /ask), and both machines register the identical tree so the
// guild menu shows one "clankerchat" entry per bot.

test("spec: one grouped command; every name/description fits Discord's constraints", () => {
  const [cmd] = slashCommandSpec();
  assert.equal(cmd.name, "clankerchat");
  assert.match(cmd.name, /^[-_a-z0-9]{1,32}$/, "command names: lowercase, 1-32");
  assert.ok(cmd.description.length >= 1 && cmd.description.length <= 100, "description 1-100 chars");
  assert.equal(cmd.type, 1, "CHAT_INPUT");
  const subs = cmd.options;
  assert.deepEqual(subs.map((o) => o.name), ["status", "ask"]);
  for (const o of subs) {
    assert.match(o.name, /^[-_a-z0-9]{1,32}$/, "subcommand names: lowercase, 1-32");
    assert.ok(o.description.length >= 1 && o.description.length <= 100);
    assert.equal(o.type, 1, "SUB_COMMAND");
  }
  const text = subs[1].options[0];
  assert.equal(text.type, 3, "STRING option");
  assert.equal(text.required, true);
  assert.equal(text.min_length, 1);
  assert.ok(text.max_length >= 1 && text.max_length <= 6000, "Discord string-option cap");
});

test("renderStatusCard: same facts → the typed-fast-path card shape", () => {
  const card = renderStatusCard({
    bot: "fast-clank",
    uptimeMs: 120_000,
    active: 1,
    maxConcurrent: 2,
    queuedHuman: 0,
    queuedBot: 3,
    lastRunAgoMs: 5 * 60_000,
    lastRunWhere: 'thread "shim" (1555115816775720980)',
    spoolPending: 0,
    servicesLine: "services: watch:✓ · botlink:✓",
  });
  assert.match(card, /^\*\*fast-clank\*\* — status \(canned card, no model run\)$/m);
  assert.match(card, /watcher up 2m · pool 1\/2 · queues h:0 b:3/);
  assert.match(card, /last run 5m ago \(thread "shim" \(1555115816775720980\)\)/);
  assert.ok(card.includes("services: watch:✓ · botlink:✓"));
  assert.match(card, /lane spool: 0 pending/);

  // no run this boot → honest null line, no "undefined" anywhere
  const fresh = renderStatusCard({
    bot: "fast-clank",
    uptimeMs: 30_000,
    active: 0,
    maxConcurrent: 2,
    queuedHuman: 0,
    queuedBot: 0,
    lastRunAgoMs: null,
    spoolPending: 2,
  });
  assert.match(fresh, /no runs this boot/);
  assert.doesNotMatch(fresh, /undefined|null/);
  assert.match(fresh, /watcher up 1m/);
});

test("renderStatusCard: mention-shaped text in card slots renders literal (own-post law)", () => {
  const card = renderStatusCard({
    bot: "fast-clank",
    uptimeMs: 60_000,
    active: 0,
    maxConcurrent: 2,
    queuedHuman: 0,
    queuedBot: 0,
    lastRunAgoMs: 1_000,
    lastRunWhere: 'thread "@everyone here" (1)',
    spoolPending: 0,
  });
  // the @ is stripped entirely — the literal "@everyone" never rides in an
  // own post (law letter), and the watcher's alarm regex can never trip
  assert.doesNotMatch(card, /@(everyone|here)\b/);
  assert.match(card, /thread "everyone here" \(1\)/, "slot stays readable, @ dropped");
  assert.doesNotMatch(card, /<@&\d+>/);
});

test("renderStatusCard: peer recency line — present when fresh, absent when not (phase 0)", () => {
  const base = {
    bot: "fast-clank",
    uptimeMs: 60_000,
    active: 0,
    maxConcurrent: 2,
    queuedHuman: 0,
    queuedBot: 0,
    lastRunAgoMs: 1_000,
    spoolPending: 0,
  };
  // fresh heartbeat facts → one honest line, name mention-stripped
  const withPeer = renderStatusCard({
    ...base,
    peerLastRunAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    peerName: "joesp-desktop",
  });
  assert.match(withPeer, /peer joesp-desktop last ran 12m ago/);

  // a peer name carrying mention text renders inert like every other slot
  const evil = renderStatusCard({
    ...base,
    peerLastRunAt: new Date(Date.now() - 60_000).toISOString(),
    peerName: "@everyone",
  });
  assert.doesNotMatch(evil, /@(everyone|here)\b/);
  assert.match(evil, /peer everyone last ran/);

  // absent / null / unparseable → NO line (never a stale or NaN claim)
  for (const bad of [undefined, null, "not-a-date", ""]) {
    const c = renderStatusCard({ ...base, peerLastRunAt: bad });
    assert.doesNotMatch(c, /peer .* last ran/, `no peer line for ${JSON.stringify(bad)}`);
  }
});

test("registerSlashCommands: one guild-scoped bulk overwrite carrying the spec", async () => {
  const calls = [];
  const rest = {
    put: async (route, options) => {
      calls.push({ route, options });
      return [];
    },
  };
  const out = await registerSlashCommands(rest, "111222333", "444555666");
  assert.equal(calls.length, 1, "idempotent single PUT — caller decides cadence");
  assert.equal(calls[0].route, "/applications/111222333/guilds/444555666/commands");
  assert.deepEqual(calls[0].options.body, slashCommandSpec(), "registered body IS the spec");
  assert.deepEqual(out, []);
});
