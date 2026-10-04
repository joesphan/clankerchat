/**
 * audit — pure classification of guild audit-log entries (S-tier #5, owner
 * round 2026-10-04). The daemon normalizes discord.js entries into the
 * AuditLike shape (ids and the numeric action only — no display names, no
 * untrusted text enters this module or the journal), and classifyAudit()
 * decides what each entry MEANS for this machine:
 *
 *   critical — the transport or the bot's authority itself is touched:
 *     our channel deleted/archived-or-renamed, a webhook spawned in it
 *     (the B6 spoof class gaining a SOURCE), the bot kicked or re-rolled,
 *     OTHER people deleting the BOT's posts (the record of decisions).
 *   notify   — config drift worth a journal line and a card alert, not a
 *     human ping: permission overwrites and channel updates on our venues.
 *   null     — everything else. A guild is noisy; the watch is scoped to
 *     this machine's blast radius, or it trains everyone to ignore it.
 *
 * Discord's audit action ids are API constants (stable, documented); the
 * enum is restated locally so this module stays discord.js-free and both
 * machines (and the tests) share one table.
 */

/** Discord AuditLogEvent ids used here — restated from the API constants. */
export const AUDIT_ACTIONS = {
  CHANNEL_UPDATE: 11,
  CHANNEL_DELETE: 12,
  CHANNEL_OVERWRITE_CREATE: 13,
  CHANNEL_OVERWRITE_UPDATE: 14,
  CHANNEL_OVERWRITE_DELETE: 15,
  MEMBER_KICK: 20,
  MEMBER_ROLE_UPDATE: 25,
  WEBHOOK_CREATE: 50,
  WEBHOOK_UPDATE: 51,
  WEBHOOK_DELETE: 52,
  MESSAGE_DELETE: 72,
  MESSAGE_BULK_DELETE: 73,
} as const;

/** The daemon-side normalization target: ids and numbers only. */
export interface AuditLike {
  /** Audit entry snowflake (time-ordered). */
  id: string;
  /** AuditLogAction number (see AUDIT_ACTIONS). */
  action: number;
  /** Who performed the action, user id (null when Discord hides executors
   *  after retention — the label says so honestly). */
  executorId: string | null;
  /** What it was performed on: message author, channel, member, bot. */
  targetId: string | null;
  /** For webhook/channel actions: the channel the event lives in. */
  channelId: string | null;
}

export interface AuditVerdict {
  severity: "critical" | "notify";
  /** One-line label for journal/alerts/post — ids only, never names. */
  label: string;
}

function byId(id: number | undefined): string | undefined {
  if (id === undefined) return undefined;
  return (Object.keys(AUDIT_ACTIONS) as (keyof typeof AUDIT_ACTIONS)[]).find((k) => AUDIT_ACTIONS[k] === id);
}

/** Classify one normalized entry against this machine's blast radius:
 *  botId = our application's user id; channelIds = the team channel and
 *  every thread we hold a cursor for (the watched surface). */
export function classifyAudit(a: AuditLike, opts: { botId: string; channelIds: string[] }): AuditVerdict | null {
  const who = a.executorId ?? "an executor Discord no longer names";
  const watch = new Set(opts.channelIds);
  switch (a.action) {
    case AUDIT_ACTIONS.MESSAGE_DELETE:
    case AUDIT_ACTIONS.MESSAGE_BULK_DELETE:
      if (a.targetId === opts.botId) {
        // Our own posts being deleted by someone else — the ask/decision
        // record disappearing is the class that motivated this watch.
        return { severity: "critical", label: `bot posts deleted by user ${a.executorId ?? "?"} (audit ${a.id})` };
      }
      return null; // humans deleting humans' messages is normal moderation
    case AUDIT_ACTIONS.CHANNEL_DELETE:
      if (watch.has(a.targetId ?? "")) {
        return { severity: "critical", label: `watched channel ${a.targetId} deleted by ${who} (audit ${a.id})` };
      }
      return null;
    case AUDIT_ACTIONS.CHANNEL_UPDATE:
      if (watch.has(a.targetId ?? "")) {
        return { severity: "notify", label: `watched channel ${a.targetId} modified by ${who} (audit ${a.id})` };
      }
      return null;
    case AUDIT_ACTIONS.CHANNEL_OVERWRITE_CREATE:
    case AUDIT_ACTIONS.CHANNEL_OVERWRITE_UPDATE:
    case AUDIT_ACTIONS.CHANNEL_OVERWRITE_DELETE:
      if (watch.has(a.channelId ?? "")) {
        return { severity: "notify", label: `permission overwrite changed on ${a.channelId} by ${who} (audit ${a.id})` };
      }
      return null;
    case AUDIT_ACTIONS.WEBHOOK_CREATE:
      if (watch.has(a.channelId ?? "")) {
        // B6: webhook messages never trigger — but a webhook APPEARING in
        // our channel is someone building a spoof class at the source.
        return { severity: "critical", label: `webhook created in watched channel ${a.channelId} by ${who} (audit ${a.id})` };
      }
      return null;
    case AUDIT_ACTIONS.WEBHOOK_UPDATE:
    case AUDIT_ACTIONS.WEBHOOK_DELETE:
      if (watch.has(a.channelId ?? "")) {
        return { severity: "notify", label: `webhook ${byId(a.action)?.toLowerCase()} in watched channel ${a.channelId} by ${who} (audit ${a.id})` };
      }
      return null;
    case AUDIT_ACTIONS.MEMBER_KICK:
      if (a.targetId === opts.botId) {
        return { severity: "critical", label: `BOT KICKED from the guild by ${who} (audit ${a.id})` };
      }
      return null;
    case AUDIT_ACTIONS.MEMBER_ROLE_UPDATE:
      if (a.targetId === opts.botId) {
        return { severity: "critical", label: `bot roles changed by ${who} (audit ${a.id})` };
      }
      return null;
    default:
      return null;
  }
}

/** Entries strictly NEWER than lastId, oldest first (snowflakes are
 *  time-ordered; the sweep journals and advances once per entry). */
export function filterAuditSince(entries: AuditLike[], lastId: string): AuditLike[] {
  const last = BigInt(lastId || "0");
  return entries
    .filter((e) => {
      try {
        return BigInt(e.id) > last;
      } catch {
        return false; // malformed id — skip rather than crash the sweep
      }
    })
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
