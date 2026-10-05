// msgcache — local SQLite cache of in-scope Discord messages, fed by the
// host's existing gateway connection (watcher messageCreate + the MCP
// process's own send/edit/delete surfaces), served by the MCP `read` tool
// as a fast path and by the `search` tool (owner phone prompt 2026-10-05:
// zero-latency reads + rich search without REST round-trips).
//
// Laws baked in:
// - FAIL-QUIET: node:sqlite exists only on Node >= 22.5 (unflagged >= 23.4).
//   Every entry point degrades to null / no-op — the cache is an
//   optimization, never a dependency; a machine without it serves REST as
//   before. Loaded via createRequire so a missing builtin THROWS (catchable)
//   instead of failing the whole ESM module graph at import time.
// - HONEST COVERAGE: `covers()` is a claim we can prove. A per-channel
//   floor (raised when a boot-replay window saturates = older missed
//   messages exist) bounds what list() may serve. Below the floor or short
//   of the asked count → not covered → caller falls back to REST. A cache
//   that can lie about gaps is worse than no cache.
// - QUARANTINE BY CONSTRUCTION: writers record only post-quarantine,
//   in-scope messages; this module stores what it is given and never
//   fetches anything itself.
// - SNOWFLAKE ORDERING: message ids are TEXT keys, but snowflakes of
//   different digit lengths sort wrong lexicographically ("999…" > "1000…"),
//   so every comparison/order in SQL casts to INTEGER (SQLite ints are
//   full 64-bit; snowflakes ~1.8e18 fit comfortably). JS-side floor math
//   uses BigInt for the same reason.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface MsgCacheRow {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  createdAtMs: number;
  content: string;
  editedAtMs?: number;
  attachments?: { filename: string; url: string }[];
}

export interface MsgCacheRecord {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  createdAtMs: number;
  content: string;
  attachments?: { filename: string; url: string }[];
}

export interface MsgCache {
  record(m: MsgCacheRecord): void;
  edit(id: string, content: string, editedAtMs: number): void;
  remove(id: string): void;
  /** Raise-only gap floor (snowflake): a saturated boot-replay window
   *  proves a hole below the oldest held message; reads under it use REST.
   *  Ordinary coverage is NOT this — it derives from MIN(cached id) in
   *  covers(), so a cache that starts mid-history can never claim the
   *  older range. */
  setFloor(channelId: string, snowflake: string): void;
  /** Provably-complete view for this query? If false, caller must use REST. */
  covers(channelId: string, after: string | undefined, limit: number): boolean;
  /** REST `after`-semantics: ids numerically > after, newest `limit`, ascending out. */
  list(channelId: string, after: string | undefined, limit: number): MsgCacheRow[];
  search(q: { text: string; channelId?: string; sinceMs?: number; limit?: number }): MsgCacheRow[];
  prune(olderThanMs: number): number;
  close(): void;
}

const CONTENT_CAP = 4000;
const NAME_CAP = 100;
const DEFAULT_SEARCH_LIMIT = 25;

function loadSqlite(): { DatabaseSync: new (path: string) => any } | null {
  try {
    // createRequire keeps this synchronous AND throw-catchable — the ESM
    // graph never sees the missing builtin.
    const req = createRequire(import.meta.url);
    return req("node:sqlite");
  } catch {
    return null;
  }
}

const singletons = new Map<string, MsgCache | null>();

/** Open (or return the already-open) cache at dbPath. Null when node:sqlite
 *  is unavailable or the db cannot open — every caller no-ops on null. */
export function openMsgCache(dbPath: string): MsgCache | null {
  if (singletons.has(dbPath)) return singletons.get(dbPath) ?? null;
  const mc = buildMsgCache(dbPath);
  singletons.set(dbPath, mc);
  return mc;
}

/** Tests only: drop cached handles so reopen paths can be exercised. */
export function resetMsgCacheSingletons(): void {
  singletons.clear();
}

function buildMsgCache(dbPath: string): MsgCache | null {
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync) return null;
  let db: any;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new sqlite.DatabaseSync(dbPath);
    const run = (sql: string) => db.prepare(sql).run();
    // WAL: the watcher process writes while MCP-server processes read/write —
    // concurrent-access mode without corrupting readers. busy_timeout rides
    // along so a writer collision waits instead of throwing SQLITE_BUSY.
    db.prepare("PRAGMA journal_mode = WAL").get();
    run("PRAGMA busy_timeout = 2000");
    run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      is_bot INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      content TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]'
    )`);
    run("CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, CAST(id AS INTEGER))");
    run("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at)");
    run(`CREATE TABLE IF NOT EXISTS floors (
      channel_id TEXT PRIMARY KEY,
      floor_snowflake TEXT NOT NULL
    )`);
  } catch {
    try { db?.close(); } catch { /* already quiet */ }
    return null;
  }

  const quiet = (fn: () => void): void => {
    try { fn(); } catch { /* cache never breaks the host path */ }
  };

  return {
    record(m: MsgCacheRecord): void {
      quiet(() => {
        db.prepare(
          `INSERT OR REPLACE INTO messages (id, channel_id, author_id, author_name, is_bot, created_at, content, attachments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          String(m.id),
          String(m.channelId),
          String(m.authorId),
          String(m.authorName ?? "").slice(0, NAME_CAP),
          m.isBot ? 1 : 0,
          Number(m.createdAtMs) || 0,
          String(m.content ?? "").slice(0, CONTENT_CAP),
          JSON.stringify((m.attachments ?? []).slice(0, 10)),
        );
      });
    },
    edit(id: string, content: string, editedAtMs: number): void {
      quiet(() => {
        db.prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?").run(
          String(content ?? "").slice(0, CONTENT_CAP),
          editedAtMs,
          String(id),
        );
      });
    },
    remove(id: string): void {
      quiet(() => {
        db.prepare("DELETE FROM messages WHERE id = ?").run(String(id));
      });
    },
    setFloor(channelId: string, snowflake: string): void {
      quiet(() => {
        // Raise-only, compared numerically in JS (BigInt) — SQL MAX() on
        // TEXT snowflakes would order by codepoint across digit lengths.
        const row = db.prepare("SELECT floor_snowflake FROM floors WHERE channel_id = ?").get(String(channelId)) as
          | { floor_snowflake: string }
          | undefined;
        if (row && BigInt(row.floor_snowflake) >= BigInt(snowflake)) return;
        db.prepare(
          "INSERT OR REPLACE INTO floors (channel_id, floor_snowflake) VALUES (?, ?)",
        ).run(String(channelId), String(snowflake));
      });
    },
    covers(channelId: string, after: string | undefined, limit: number): boolean {
      try {
        // Contiguous coverage starts at the OLDEST row we hold (fresh caches
        // start mid-history — absence of a floor row must NOT read as "full
        // history"; a read below the oldest cached id falls back to REST).
        // Gap floors (saturated boot replays) only ever RAISE that start.
        // MIN comes back CAST to TEXT: raw INTEGER snowflakes exceed 2^53 and
        // would lose precision as JS numbers.
        const lo = (
          db
            .prepare("SELECT CAST(MIN(CAST(id AS INTEGER)) AS TEXT) AS lo FROM messages WHERE channel_id = ?")
            .get(String(channelId)) as { lo: string | null }
        )?.lo;
        if (!lo) return false; // nothing cached for this channel
        let contiguous = BigInt(lo);
        const gap = db.prepare("SELECT floor_snowflake FROM floors WHERE channel_id = ?").get(String(channelId)) as
          | { floor_snowflake: string }
          | undefined;
        if (gap && BigInt(gap.floor_snowflake) > contiguous) contiguous = BigInt(gap.floor_snowflake);
        if (after !== undefined) return BigInt(after) >= contiguous;
        const count = (
          db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(String(channelId)) as {
            n: number;
          }
        ).n;
        // No `after`: caller wants the newest `limit` — covered only if we
        // hold at least that many (else REST may return more than we have).
        return count >= limit;
      } catch {
        return false;
      }
    },
    list(channelId: string, after: string | undefined, limit: number): MsgCacheRow[] {
      try {
        const rows = after
          ? db
              .prepare(
                "SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?",
              )
              .all(String(channelId), String(after), limit)
          : db
              .prepare(
                "SELECT * FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT ?",
              )
              .all(String(channelId), limit);
        return (rows as any[]).map(rowToMsg).reverse();
      } catch {
        return [];
      }
    },
    search(q: { text: string; channelId?: string; sinceMs?: number; limit?: number }): MsgCacheRow[] {
      try {
        // LIKE is case-insensitive for ASCII by default; % and _ are escaped
        // so a literal "50%" query doesn't widen into a wildcard.
        const esc = String(q.text).replace(/[\\%_]/g, (c) => `\\${c}`);
        const conds = ["content LIKE ? ESCAPE '\\'"];
        const params: unknown[] = [`%${esc}%`];
        if (q.channelId) {
          conds.push("channel_id = ?");
          params.push(String(q.channelId));
        }
        if (q.sinceMs !== undefined) {
          conds.push("created_at >= ?");
          params.push(Number(q.sinceMs));
        }
        const rows = db
          .prepare(
            `SELECT * FROM messages WHERE ${conds.join(" AND ")} ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
          )
          .all(...(params as any[]), q.limit ?? DEFAULT_SEARCH_LIMIT);
        return (rows as any[]).map(rowToMsg);
      } catch {
        return [];
      }
    },
    prune(olderThanMs: number): number {
      try {
        return db.prepare("DELETE FROM messages WHERE created_at < ?").run(Number(olderThanMs)).changes as number;
      } catch {
        return 0;
      }
    },
    close(): void {
      quiet(() => db.close());
      singletons.delete(dbPath);
    },
  };
}

function rowToMsg(r: any): MsgCacheRow {
  let attachments: { filename: string; url: string }[] = [];
  try {
    const parsed = JSON.parse(r.attachments ?? "[]");
    if (Array.isArray(parsed)) attachments = parsed.slice(0, 10);
  } catch {
    /* torn/corrupt column → no attachments */
  }
  return {
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorName: r.author_name,
    isBot: r.is_bot === 1,
    createdAtMs: r.created_at,
    content: r.content,
    ...(r.edited_at !== null && r.edited_at !== undefined ? { editedAtMs: r.edited_at } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
