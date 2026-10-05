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
 *     expiresAt, status: pending|approved|denied|expired|yolo, decidedBy?,
 *     decidedAt? }
 *
 * custom_id contract: "ask:<askId>:<approve|deny|yolo>" — ≤100 chars (Discord's
 * cap), one parse path, no free text rides it. yolo (owner-approved third
 * verb, 2026-10-04): approve + one-shot full-auto — the click is the human
 * grant, same standing as "yolo" said in-thread in their own words.
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
  status: "pending" | "approved" | "denied" | "expired" | "yolo";
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

/** One action row: [Approve (green)] [Deny (red)] [YOLO (blurple)]. Legacy
 *  components — still fully supported, no Components-V2 flag needed (verified
 *  against Discord's message-components docs, 2026-10-04). */
export function buildAskComponents(askId: string): {
  type: 1;
  components: {
    type: 2;
    style: 1 | 3 | 4;
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
        { type: 2, style: 1, label: "YOLO", custom_id: askCustomId(askId, "yolo") },
      ],
    },
  ];
}

/** The same row with every button disabled — the post-decision/expiry edit. */
export function buildDisabledAskComponents(askId: string): {
  type: 1;
  components: {
    type: 2;
    style: 1 | 3 | 4;
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
        { type: 2, style: 1, label: "YOLO", custom_id: askCustomId(askId, "yolo"), disabled: true },
      ],
    },
  ];
}

export type AskAction = "approve" | "deny" | "yolo";

export function askCustomId(askId: string, action: AskAction): string {
  return `ask:${askId}:${action}`;
}

/** Sentinel prefix for the live countdown line (buildAskCountdownEdit). */
export const ASK_COUNTDOWN_PREFIX = "⏳";

/** Live countdown edit: while an ask is PENDING, the watcher PATCHes the
 *  card once a minute with a fresh "⏳ Xm left" line — humans see the fuse
 *  burning in-channel without opening the app. Idempotent by sentinel: any
 *  existing ⏳-prefixed line is REPLACED, never duplicated. The caller must
 *  re-send the button row unchanged (an edit that dropped components would
 *  kill the ask); null = nothing to edit (decided or already past expiry). */
export function buildAskCountdownEdit(
  content: string,
  rec: Pick<AskRecord, "status" | "expiresAt">,
  now = Date.now(),
): { content: string; minutesLeft: number } | null {
  const clock = askClockLine(rec, now); // shared clock math (also feeds the V2 slot)
  if (clock === null) return null;
  const minutesLeft = Math.max(1, Math.ceil((rec.expiresAt - now) / 60_000));
  const lines = String(content ?? "")
    .split("\n")
    .filter((l) => !l.startsWith(ASK_COUNTDOWN_PREFIX));
  lines.push(clock);
  return { content: lines.join("\n"), minutesLeft };
}

/** Inverse of askCustomId — returns null for anything not ours. A foreign
 *  custom_id (another bot's component on a message we can see) must parse to
 *  null so the handler ignores it instead of crashing. */
export function parseAskCustomId(customId: string): { askId: string; action: AskAction } | null {
  const m = customId.match(/^ask:([a-z0-9-]+):(approve|deny|yolo)$/);
  return m ? { askId: m[1], action: m[2] as AskAction } : null;
}

// ---------------------------------------------------------------------------
// Components V2 ask cards (TODO round 2026-10-04)
// ---------------------------------------------------------------------------
// Under the IS_COMPONENTS_V2 flag the `content` field is DISABLED — all text
// lives in TextDisplay components — and the flag is permanent per-message, so
// the two shapes coexist during the transition: asks posted before the switch
// are legacy (content + action row) and stay legacy forever. Every edit site
// detects the shape via isAskV2Message and forks; the custom_id contract is
// IDENTICAL in both shapes, so the click handler never cares.

/** MessageFlags.IsComponentsV2 (1 << 15) — the flag that enables the tree. */
export const ASK_V2_FLAG = 32_768;

/** Fixed component ids inside the ask container so edits PATCH in place:
 *  1 = question text display, 2 = clock/decision line, 3 = button row. */
const ASK_V2_Q_ID = 1;
const ASK_V2_CLOCK_ID = 2;
const ASK_V2_ROW_ID = 3;

const ASK_ACCENT = 0x7aa2f7; // the stack's blue — matches the companion app theme

function askV2Row(askId: string, disabled: boolean) {
  return {
    type: 1 as const,
    id: ASK_V2_ROW_ID,
    components: [
      { type: 2 as const, style: 3 as const, label: "Approve", custom_id: askCustomId(askId, "approve"), disabled },
      { type: 2 as const, style: 4 as const, label: "Deny", custom_id: askCustomId(askId, "deny"), disabled },
      { type: 2 as const, style: 1 as const, label: "YOLO", custom_id: askCustomId(askId, "yolo"), disabled },
    ],
  };
}

/** The pending ask as one Container tree: question, clock line, button row.
 *  text = the ALREADY-COMPOSED display text (sender prefix + lazy note) —
 *  callers run the same leak/mass-mention tripwires on it they ran on legacy
 *  content; nothing here re-derives policy. */
export function buildAskV2Components(
  askId: string,
  text: string,
  opts: { clockLine: string; disabled?: boolean },
): { type: 17; id: number; accent_color: number; components: unknown[] }[] {
  return [
    {
      type: 17,
      id: 0,
      accent_color: ASK_ACCENT,
      components: [
        { type: 10, id: ASK_V2_Q_ID, content: String(text ?? "") },
        { type: 10, id: ASK_V2_CLOCK_ID, content: opts.clockLine },
        askV2Row(askId, opts.disabled ?? false),
      ],
    },
  ];
}

/** The "⏳ Xm left" line for a pending ask, or null when terminal (decided /
 *  past expiry) — shared by the legacy content edit and the V2 clock slot. */
export function askClockLine(rec: Pick<AskRecord, "status" | "expiresAt">, now = Date.now()): string | null {
  if (rec.status !== "pending" || rec.expiresAt <= now) return null;
  return `${ASK_COUNTDOWN_PREFIX} ${Math.max(1, Math.ceil((rec.expiresAt - now) / 60_000))}m left`;
}

/** True when a message's components are a V2 container tree (edit sites fork
 *  on this; legacy asks can never gain the flag retroactively). */
export function isAskV2Message(components: unknown): boolean {
  return Array.isArray(components) && (components[0] as { type?: number } | undefined)?.type === 17;
}

/** Tree surgery for V2 ask edits: replace the clock line (id 2) and, when
 *  `disabled` is set (terminal edits), set the buttons' disabled flag —
 *  undefined leaves clickability UNTOUCHED, so a countdown tick racing a
 *  decision edit can never re-enable buttons. The question (id 1) and
 *  container styling pass through untouched: the posted message stays the
 *  source of truth for what was asked; only the fuse/status line and
 *  clickability ever change. Accepts raw JSON (tests) or discord.js
 *  component classes (watcher): class instances normalize via their own
 *  toJSON before surgery. */
export function rebuildAskV2ForEdit(
  components: unknown[],
  clockLine: string,
  opts: { disabled?: boolean },
): unknown[] {
  const plain = (node: unknown): Record<string, unknown> => {
    const n = node as { toJSON?: () => Record<string, unknown> };
    return typeof n?.toJSON === "function" ? n.toJSON() : { ...(n as Record<string, unknown>) };
  };
  return components.map((top) => {
    const c = plain(top);
    if (c.type !== 17 || !Array.isArray(c.components)) return c;
    return {
      ...c,
      components: c.components.map((child) => {
        const ch = plain(child);
        if (ch.type === 10 && ch.id === ASK_V2_CLOCK_ID) return { ...ch, content: clockLine };
        if (ch.type === 1 && Array.isArray(ch.components)) {
          return {
            ...ch,
            components: ch.components.map((b) => ({ ...plain(b), ...(opts.disabled === undefined ? {} : { disabled: opts.disabled }) })),
          };
        }
        return ch;
      }),
    };
  });
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
  // One clock read for both stamps: createdAt/expiresAt differ by EXACTLY
  // the ttl (tests assert this; two Date.now() calls drifted ±ms on a
  // scheduler tick and flaked the suite).
  const now = Date.now();
  const full: AskRecord = {
    askId: rec.askId ?? newAskId(),
    question: rec.question.slice(0, 1500),
    channelId: rec.channelId,
    messageId: rec.messageId,
    approvers: rec.approvers.filter((id) => /^\d{15,25}$/.test(id)).slice(0, 10),
    createdAt: now,
    expiresAt: now + (rec.ttlMs ?? ASK_TTL_MS),
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

/** Record a decision (approve/deny/yolo by a validated approver). Cross-
 *  process claim (audit finding 12): the companion HTTP process and the
 *  watcher process BOTH decide on this registry (phone decision vs button
 *  click) — the old get→check→write let both racers read "pending", both
 *  write, and both see their own decidedBy (double decision run + double
 *  message edit). O_EXCL makes the claim kernel-atomic: exactly one winner
 *  per ask, ever, across processes. The claim file persists beside the
 *  record as proof a decision was in flight — fail-closed direction for
 *  asks. */
export function decideAsk(
  spoolDir: string,
  askId: string,
  decision: "approved" | "denied" | "yolo",
  decidedBy: string,
): AskRecord | null {
  const rec = getAsk(spoolDir, askId);
  if (!rec) return null;
  if (rec.status !== "pending") return rec;
  // Expiry is a hard boundary on EVERY deciding surface (audit round 3,
  // finding 1): past the fuse the sweep owns the ask — a late tap or click
  // must never approve what "buttons die at expiry" promised would die.
  // Return the still-pending record unchanged; callers report it honestly
  // (the companion route and click handler pre-check this for a clean
  // "expired" answer, this is the backstop at the single choke point).
  if (rec.expiresAt <= Date.now()) return rec;
  const file = askFile(spoolDir, askId);
  const claim = `${file}.claim`;
  let claimed = false;
  try {
    fs.closeSync(fs.openSync(claim, "wx", 0o600));
    claimed = true;
  } catch {
    /* exists — another process already decided this ask */
  }
  if (!claimed) return getAsk(spoolDir, askId); // winner's record (maybe still mid-write; callers' decidedBy checks handle it)
  const next: AskRecord = { ...rec, status: decision, decidedBy, decidedAt: Date.now() };
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    // audit round 4 (finding 2): a write failure AFTER the claim must release
    // it, mirroring the sweep's failure path — otherwise the ask wedges
    // forever (every later click loses the claim, and the expiry sweep skips
    // held claims). Re-throw so the caller reports the failure honestly; the
    // claim is gone, a retry works.
    try {
      fs.rmSync(claim, { force: true });
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do — the stale-claim reaper in sweepExpiredAsks recovers it */
    }
    throw e;
  }
  return next;
}

/** Sweep overdue pending asks to their terminal state. Default (and the
 *  security invariant): expired — no decision, no approval, buttons die.
 *  Lazy-consensus asks (onExpiry: "approve", stated on the message itself)
 *  flip to approved with decidedBy "auto-expiry" — any Deny before expiry
 *  already won via decideAsk, so this only fires on true silence. Returns
 *  every record transitioned this pass so the caller can edit its message
 *  and (for auto-approvals) enqueue the decision run.
 *
 *  Claim-gated since audit round 3 (finding 1): the old read-modify-write
 *  could OVERWRITE a decision that landed between listPendingAsks and the
 *  write — proven live as a phone DENY silently flipped to an auto-expiry
 *  APPROVAL with the message re-edited. The sweep now takes the same O_EXCL
 *  claim decideAsk does: a lost claim means a live decision (tap, click)
 *  holds the ask and the sweep skips it entirely. Deny-before-expiry wins
 *  on every interleaving.
 *
 *  Stale-claim reaper (audit round 4, finding 2): a claim held longer than
 *  STALE_CLAIM_MS on a STILL-PENDING record is a dead claimant — a process
 *  that died between claim and write (decideAsk's catch releases its own,
 *  but a kill -9 mid-window never runs any catch). Without the reaper such
 *  an ask is undead: no click can win the claim, the sweep skips it, and it
 *  never even expires. Real decisions write in <1s; 5min is a very safe
 *  margin against a slow-but-alive claimant. */
export const STALE_CLAIM_MS = 5 * 60_000;

export function sweepExpiredAsks(spoolDir: string, now = Date.now()): AskRecord[] {
  const swept: AskRecord[] = [];
  for (const rec of listPendingAsks(spoolDir)) {
    if (rec.status === "pending") {
      try {
        const st = fs.statSync(`${askFile(spoolDir, rec.askId)}.claim`);
        if (now - st.mtimeMs > STALE_CLAIM_MS) {
          fs.rmSync(`${askFile(spoolDir, rec.askId)}.claim`, { force: true });
        }
      } catch {
        /* no claim file — the normal case */
      }
    }
    if (rec.status === "pending" && rec.expiresAt <= now) {
      const file = askFile(spoolDir, rec.askId);
      const claim = `${file}.claim`;
      try {
        fs.closeSync(fs.openSync(claim, "wx", 0o600));
      } catch {
        continue; // a live decision holds the claim — it wins, the sweep skips
      }
      const next: AskRecord = rec.onExpiry === "approve"
        ? { ...rec, status: "approved", decidedBy: "auto-expiry", decidedAt: now }
        : { ...rec, status: "expired" };
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n");
        fs.renameSync(tmp, file);
        swept.push(next);
      } catch {
        /* unreadable/locked — release our own claim so the next sweep
           retries (only a crash mid-window leaves it held, same as decideAsk) */
        try {
          fs.rmSync(claim, { force: true });
        } catch {
          /* nothing more to do — the record stays pending, next sweep retries */
        }
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

/** Hygiene sweep (2026-10-04 self-audit): delete TERMINAL ask records older
 *  than keepMs (default 7 days). The registry is file-per-ask and a terminal
 *  record has no further readers — the Discord message is the human record.
 *  Never touches pending records, and never deletes an UNDELIVERED companion
 *  decision (status terminal, decidedBy companion:*, no enqueuedAt): that
 *  record is still owed a delivery stamp. Returns the ids removed. */
export function sweepTerminalAsks(
  spoolDir: string,
  now = Date.now(),
  keepMs = 7 * 24 * 60 * 60 * 1000,
): string[] {
  const removed: string[] = [];
  const weekAgo = now - keepMs;
  for (const rec of listPendingAsks(spoolDir)) {
    if (rec.status === "pending") continue;
    if (!rec.enqueuedAt && typeof rec.decidedBy === "string" && rec.decidedBy.startsWith("companion:")) continue;
    const ageFrom = rec.decidedAt ?? rec.createdAt;
    if (ageFrom >= weekAgo) continue;
    try {
      fs.rmSync(askFile(spoolDir, rec.askId), { force: true });
      // audit round 4 (finding 7): the record's .claim (and any torn .tmp)
      // are garbage the moment the record is — GC'ing only the .json orphaned
      // one claim file per ask forever, slowly rotting every readdir scan.
      fs.rmSync(`${askFile(spoolDir, rec.askId)}.claim`, { force: true });
      fs.rmSync(`${askFile(spoolDir, rec.askId)}.tmp`, { force: true });
      removed.push(rec.askId);
    } catch {
      /* unreadable/locked — next sweep retries */
    }
  }
  return removed;
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
  const verb = rec.status === "approved" ? "Approved" : rec.status === "denied" ? "Denied" : rec.status === "yolo" ? "YOLO'd" : "Expired";
  return `${verb} by ${decidedName} · ${t}Z`;
}

/** The per-status INSTRUCTION a decision run executes — ONE shared source for
 *  every delivery surface (Discord click, phone tap, and any future one), so
 *  a YOLO means one-shot full-auto no matter which host delivers the run.
 *  Round-12 law: the delivery paths used to carry only the bare status word
 *  ("[ask decision] YOLO by …"), leaving the semantics to whichever brain
 *  read it — daemon.ts had the instructions inline, the watcher host didn't,
 *  and the two hosts' YOLO runs would have behaved differently. deciderName
 *  is display-only (authority was the API/signed-surface check upstream). */
export function askDecisionInstruction(status: AskRecord["status"], deciderName: string): string {
  if (status === "approved")
    return `The human (${deciderName}) approved — proceed with exactly what the ask requested, then answer in the thread.`;
  if (status === "yolo")
    return `The human (${deciderName}) YOLO'd — one-shot full-auto granted by their gesture: execute the ask's request now with no further asks, then answer in the thread with the receipt.`;
  return `The human (${deciderName}) denied — do NOT proceed; stand down and acknowledge the denial in the thread.`;
}
