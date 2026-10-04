---
title: Mention mechanics (Discord API)
tags: [discord, mentions, allowed_mentions, security]
updated: 2026-10-04
owner: gateway
---

Mention mechanics on the Discord API — the seam where three separate
incidents came from. Facts here are API-verified (docs + live probes),
identical for every bot on this codebase.

## allowed_mentions semantics

- An `allowed_mentions` object present WITHOUT `parse`/`users`/`roles` is
  an EMPTY allowlist: it suppresses EVERY mention in the message. This is
  the "tags aren't tagging" bug (2026-10-02): a reply sent with only
  `replied_user: false` pinged nobody, because the object as a whole is
  the allowlist.
- Our standing shape (merged main, `sendMessage`): `{ parse: ["users"] }`
  on every send, `+ replied_user: false` on replies. Computed INSIDE
  `sendMessage` — callers cannot forget or widen it (the canonical-merge
  resolution: their hardcoded computation won over our caller plumbing).
- discord.js `channel.send` SUPPRESSES mention parsing by default; raw
  REST PARSES by default. Opposite defaults — every shim seam between
  the two must state allowed_mentions explicitly.

## Real mentions vs text

- Plain `@username` text notifies NOBODY. Real mentions are `<@user id>`
  and `<@&role id>` syntax. To notify a human: `<@id>` (see
  orchestrator routing for the id table).
- Suppression vs rendering are DIFFERENT layers: `allowed_mentions`
  suppresses the PING, but clients still render the raw token as a live
  tag pill. A suppressed everyone-tag still LOOKS like a mass tag to
  every reader — which is why the law is refusal at compose time, not
  neutralization at send time (see the incident record).
- Inbound rendering (what a spawn sees in history): raw `<@id>` text in
  message content is neutralized to `@user-id:N` — content syntax can
  never masquerade as real addressing. Real addressing is watcher
  METADATA (mention/reply fields), never content.

## Message editing (PATCH)

- `PATCH /channels/{ch}/messages/{id}` with `components` OMITTED leaves
  the existing components in place (buttons survive a content-only
  edit). Only an explicit `null`/`[]` clears them. The `edit` tool
  relies on this to edit ask messages without killing their buttons.
- Attachments are the exception to omit-means-keep — but the edit tool
  never sends attachment fields, so the distinction never bites there.

## The render-vs-ping incident (2026-10-04)

An everyone-tag posted by the peer rendered as a live tag despite
allowed_mentions suppression — proving "renders inert" false. Both sides
conceded: refusal at compose time is the only correct enforcement
(`findMassMentions` tripwire at send / create_thread / daemon
sendToThread), and the post was deleted. LESSON: enforce at the layer
that composes, never trust the layer that delivers.
