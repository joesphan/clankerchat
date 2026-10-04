/**
 * asks — interactive approve/deny surfaces in Discord (owner 2026-10-04:
 * "send messages with buttons attached so you can use like approve and deny
 * buttons for asks").
 *
 * Split by trust boundary, mirroring the rest of the stack:
 *
 *   - THIS module (pure, portable): the Discord component payload builder,
 *     the custom_id contract, and a file-per-ask registry under
 *     <spoolDir>/pending-asks/. Both machines use it verbatim — Windows and
 *     Arch alike — because it is plain fs with atomic writes.
 *   - The MCP `ask` tool (index.ts): composes the question, runs the same
 *     outbound tripwires as send (leak shapes, mass-mention refusal), posts
 *     with components, then records the registry entry.
 *   - The gateway's interaction handler (watcher here, the peer's daemon
 *     layer there): the ONLY place a click becomes a decision — approver
 *     identity comes from the API (interaction.user.id), never from any
 *     content; the decision is journaled in the registry and delivered to
 *     the trigger layer as a human-priority run.
 *
 * Registry shape (one JSON file per ask, atomic tmp+rename, multi-writer
 * safe because each ask has exactly one file and only the decider mutates
 * it after creation):
 *   { askId, question, channelId, messageId, approvers[], createdAt,
 *     expiresAt, status: pending|approved|denied|expired, decidedBy?,
 *     decidedAt? }
 *
 * custom_id contract: "ask:<askId>:<approve|deny>" — ≤100 chars (Discord's
 * cap), one parse path, no free text rides it.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Default ask lifetime: an unanswered ask expires and disables its buttons. */
export const ASK_TTL_MS = 60 * 60 * 1000; // 1h — asks are prompt-class, not standing polls

export interface AskRecord {
  askId: string;
  question: string;
  channelId: string;
  messageId: string | null;
  approvers: string[]; // Discord user ids allowed to click (API-checked)
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired";
  decidedBy?: string; // user id of the clicker, or "auto-expiry" (below)
  decidedAt?: number;
  // Lazy-consensus mode (owner 2026-10-04: "a way for us to auto approve and
  // set the duration"): when set, an ask that reaches expiry UNDECIDED flips
  // to approved instead of expired — silence counts as yes, the ask message
  // says so up front, and any Deny click before expiry still wins. Default
  // (unset) remains fail-closed: expiry is NEVER approval.
  onExpiry?: "approve";
  // Delivery stamp, set by the gateway watcher AFTER the decision run is
  // enqueued (edit-message + trigger). Absent on records created before this
  // field existed and on anything not yet delivered. The companion surface
  // DECIDES but never DELIVERS — the watcher claims delivery exactly once via
  // stampAskEnqueued, so a phone decision can never double-enqueue.
  enqueuedAt?: number;
}

export function asksDir(spoolDir: string): string {
  return path.join(spoolDir, "pending-asks");
}

// ---------------------------------------------------------------------------
// Discord component payload
// ---------------------------------------------------------------------------

/** One action row: [Approve (green)] [Deny (red)]. Legacy components — still
 *  fully supported, no Components-V2 flag needed (verified against Discord's
 *  message-components docs, 2026-10-04). */
export function buildAskComponents(askId: string): {
  type: 1;
  components: {
    type: 2;
    style: 3 | 4;
    label: string;
    custom_id: string;
  }[];
}[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Approve", custom_id: askCustomId(askId, "approve") },
        { type: 2, style: 4, label: "Deny", custom_id: askCustomId(askId, "deny") },
      ],
    },
  ];
}

/** The same row with every button disabled — the post-decision/expiry edit. */
export function buildDisabledAskComponents(askId: string): {
  type: 1;
  components: {
    type: 2;
    style: 3 | 4;
    label: string;
    custom_id: string;
    disabled: boolean;
  }[];
}[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Approve", custom_id: askCustomId(askId, "approve"), disabled: true },
        { type: 2, style: 4, label: "Deny", custom_id: askCustomId(askId, "deny"), disabled: true },
      ],
    },
  ];
}

export function askCustomId(askId: string, action: "approve" | "deny"): string {
  return `ask:${askId}:${action}`;
}

/** Inverse of askCustomId — returns null for anything not ours. A foreign
 *  custom_id (another bot's component on a message we can see) must parse to
 *  null so the handler ignores it instead of crashing. */
export function parseAskCustomId(customId: string): { askId: string; action: "approve" | "deny" } | null {
  const m = customId.match(/^ask:([a-z0-9-]+):(approve|deny)$/);
  return m ? { askId: m[1], action: m[2] as "approve" | "deny" } : null;
}

// ---------------------------------------------------------------------------
// Registry (file-per-ask, atomic)
// ---------------------------------------------------------------------------

function askFile(spoolDir: string, askId: string): string {
  return path.join(asksDir(spoolDir), `${askId}.json`);
}

/** Snowflake-ish unique id: never guessable in bulk, sortable by creation. */
export function newAskId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function createPendingAsk(
  spoolDir: string,
  rec: Omit<AskRecord, "askId" | "createdAt" | "expiresAt" | "status" | "onExpiry"> & {
    askId?: string;
    ttlMs?: number;
    onExpiry?: "approve";
  },
): AskRecord {
  const full: AskRecord = {
    askId: rec.askId ?? newAskId(),
    question: rec.question.slice(0, 1500),
    channelId: rec.channelId,
    messageId: rec.messageId,
    approvers: rec.approvers.filter((id) => /^\d{15,25}$/.test(id)).slice(0, 10),
    createdAt: Date.now(),
    expiresAt: Date.now() + (rec.ttlMs ?? ASK_TTL_MS),
    status: "pending",
    ...(rec.onExpiry === "approve" ? { onExpiry: "approve" } : {}),
  };
  fs.mkdirSync(asksDir(spoolDir), { recursive: true });
  const file = askFile(spoolDir, full.askId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 1) + "\n");
  fs.renameSync(tmp, file);
  return full;
}

export function getAsk(spoolDir: string, askId: string): AskRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(askFile(spoolDir, askId), "utf8"));
    return typeof raw?.askId === "string" ? (raw as AskRecord) : null;
  } catch {
    return null;
  }
}

export function listPendingAsks(spoolDir: string): AskRecord[] {
  try {
    return fs
      .readdirSync(asksDir(spoolDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => getAsk(spoolDir, f.replace(/\.json$/, "")))
      .filter((r): r is AskRecord => r !== null);
  } catch {
    return [];
  }
}

/** Record a decision (approve/deny by a validated approver) — atomic, and
 *  idempotent-ish: a second click on the same ask finds status != pending
 *  and returns the existing record unchanged (the disabled buttons make this
 *  a race edge, not a path). */
export function decideAsk(
  spoolDir: string,
  askId: string,
  decision: "approved" | "denied",
  decidedBy: string,
): AskRecord | null {
  const rec = getAsk(spoolDir, askId);
  if (!rec) return null;
  if (rec.status !== "pending") return rec;
  const next: AskRecord = { ...rec, status: decision, decidedBy, decidedAt: Date.now() };
  const file = askFile(spoolDir, askId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n");
  fs.renameSync(tmp, file);
  return next;
}

/** Sweep overdue pending asks to their terminal state. Default (and the
 *  security invariant): expired — no decision, no approval, buttons die.
 *  Lazy-consensus asks (onExpiry: "approve", stated on the message itself)
 *  flip to approved with decidedBy "auto-expiry" — any Deny before expiry
 *  already won via decideAsk, so this only fires on true silence. Returns
 *  every record transitioned this pass so the caller can edit its message
 *  and (for auto-approvals) enqueue the decision run. */
export function sweepExpiredAsks(spoolDir: string, now = Date.now()): AskRecord[] {
  const swept: AskRecord[] = [];
  for (const rec of listPendingAsks(spoolDir)) {
    if (rec.status === "pending" && rec.expiresAt <= now) {
      const next: AskRecord = rec.onExpiry === "approve"
        ? { ...rec, status: "approved", decidedBy: "auto-expiry", decidedAt: now }
        : { ...rec, status: "expired" };
      const file = askFile(spoolDir, rec.askId);
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n");
        fs.renameSync(tmp, file);
        swept.push(next);
      } catch {
        /* unreadable/locked — next sweep retries */
      }
    }
  }
  return swept;
}

/** Stamp a decided ask as DELIVERED (decision run enqueued). Returns the
 *  stamped record, or null when the ask is missing OR already stamped —
 *  callers use the null-on-repeat shape as a claim: only one caller ever
 *  proceeds per ask. The companion surface decides but never delivers; this
 *  is the watcher's claim ticket. */
export function stampAskEnqueued(spoolDir: string, askId: string): AskRecord | null {
  const rec = getAsk(spoolDir, askId);
  if (!rec || rec.status === "pending" || rec.enqueuedAt) return null;
  const next: AskRecord = { ...rec, enqueuedAt: Date.now() };
  const file = askFile(spoolDir, askId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n");
  fs.renameSync(tmp, file);
  return next;
}

/** Terminal asks decided from the companion (phone) surface that the watcher
 *  has not yet delivered. decidedBy provenance: "companion:<phone fp>". */
export function listCompanionDecisions(spoolDir: string): AskRecord[] {
  return listPendingAsks(spoolDir).filter(
    (r) => r.status !== "pending" && !r.enqueuedAt && typeof r.decidedBy === "string" && r.decidedBy.startsWith("companion:"),
  );
}

/** The phone-facing rendering of a pending ask — the question and the clock,
 *  nothing else (no channel ids, no approver ids; the phone doesn't need
 *  them and untrusted-app surfaces get minimum surface area). */
export function renderAskForApp(rec: AskRecord): Record<string, unknown> {
  return {
    askId: rec.askId,
    question: rec.question,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    lazy: rec.onExpiry === "approve",
  };
}

/** The one-line status suffix appended to the ask message at decision time.
 *  decidedName is the DISPLAY name of the clicker (render only — authority
 *  was the API id check, already done by the caller). Auto-expiry renders
 *  its own line — nobody clicked, and the record must say so honestly. */
export function askDecisionLine(rec: AskRecord, decidedName: string): string {
  const t = new Date(rec.decidedAt ?? Date.now()).toISOString().slice(11, 19);
  if (rec.decidedBy === "auto-expiry") return `Auto-approved (no Deny before expiry) · ${t}Z`;
  const verb = rec.status === "approved" ? "Approved" : rec.status === "denied" ? "Denied" : "Expired";
  return `${verb} by ${decidedName} · ${t}Z`;
}
