/**
 * Pure guard logic for the daemon's trigger path — fork audit round 2,
 * daemon-side findings 2/4/6/9. daemon.ts is a composition root (Discord
 * client, intervals, main() at import time) so tests cannot import it; the
 * invariants it enforces live here instead: monotonic message cursors, the
 * venue quarantine blocklist (the same CLANKER_BLOCKED_IDS /
 * CLANKER_BLOCKLIST_FILE contract index.ts enforces on every tool), router
 * cwd containment, and atomic file swaps.
 */

import fs from "node:fs";
import path from "node:path";

const SNOWFLAKE_RE = /^\d{15,25}$/;

// ---------------------------------------------------------------------------
// Cursors — Discord message ids are 64-bit snowflakes, so ordering must go
// through BigInt, and a cursor may only ever move FORWARD.
// ---------------------------------------------------------------------------

/** True when candidate orders after held (or held is absent/unparseable —
 *  an unreadable cursor is treated as behind so the range re-sweeps). */
export function idIsNewer(candidate: string, held: string | undefined): boolean {
  if (held === undefined || held === "") return true;
  try {
    return BigInt(candidate) > BigInt(held);
  } catch {
    return true;
  }
}

/** Monotonic cursor advance (audit fix 6): pollOnce used to write its local
 *  cursor after an await — a live gateway write that landed mid-fetch was
 *  overwritten with the stale poll position, regressing the cursor (false
 *  GATEWAY STALE → re-login → double dispatch). Mutates the map; returns
 *  whether it moved. Callers persist. */
export function advanceCursor(
  cursors: Record<string, string>,
  channelId: string,
  messageId: string,
): boolean {
  if (!idIsNewer(messageId, cursors[channelId])) return false;
  cursors[channelId] = messageId;
  return true;
}

// ---------------------------------------------------------------------------
// Venue quarantine (audit fix 2) — mirror of index.ts's blocked-ID deny.
// ---------------------------------------------------------------------------

/** CLANKER_BLOCKED_IDS: comma-separated channel/thread/user snowflakes. */
export function parseBlockedIdList(list: string | undefined): Set<string> {
  return new Set(
    (list ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** CLANKER_BLOCKLIST_FILE body: one snowflake per line, # comments. */
export function parseBlocklistFile(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => SNOWFLAKE_RE.test(l)),
  );
}

/** Absolute venue quarantine, mtime-cached like index.ts's forbiddenId():
 *  the file extends the list without a restart; an unreadable/missing file
 *  keeps the last-known cache (fail toward the last human-set state, never
 *  silently empty). */
export class ChannelBlocklist {
  private readonly envIds: Set<string>;
  private fileCache: { mtimeMs: number; ids: Set<string> } | null = null;

  constructor(envList: string | undefined, private readonly blocklistFile?: string) {
    this.envIds = parseBlockedIdList(envList);
  }

  contains(id: string): boolean {
    if (this.envIds.has(id)) return true;
    const file = this.blocklistFile?.trim();
    if (!file) return false;
    let cached = this.fileCache;
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!cached || cached.mtimeMs !== mtimeMs) {
        cached = { mtimeMs, ids: parseBlocklistFile(fs.readFileSync(file, "utf8")) };
        this.fileCache = cached;
      }
    } catch {
      /* unreadable/missing file — keep the last-known cache */
    }
    return cached ? cached.ids.has(id) : false;
  }
}

// ---------------------------------------------------------------------------
// Router cwd containment (audit fix 4).
// ---------------------------------------------------------------------------

/** True when candidate resolves inside root (root itself counts). The
 *  router's cwd output is MODEL OUTPUT steered by untrusted prompt text —
 *  existsSync alone let a crafted `{"cwd": "...\\.ssh"}` point a worker at
 *  any existing directory on the disk. */
export function isUnderRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Atomic file swap (audit fix 9) — same shape as companion.ts's
// writePrivate: a torn daemon.json/daemon.state.json must not be a state a
// boot ever observes.
// ---------------------------------------------------------------------------

export function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
