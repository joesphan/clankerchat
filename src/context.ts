/**
 * openwolf — shared portable context store (owner-asked 2026-10-04, gate
 * APPROVED by Joe via ask button mutiroux the same day).
 *
 * Design (openwolf-context-server-design.md v2, both sides agreed):
 *   - Store: plain markdown, topic-per-file, under docs/context/ in this
 *     repo — synced by the same git lineage both machines converge on.
 *     Humans read/edit it with zero tooling; git history is provenance.
 *   - Access: THREE read-only MCP tools (context_list / context_read /
 *     context_search). No write tool exists on purpose — files change by
 *     reviewed commits only, so shared memory is unpoisonable by
 *     untrusted content (same trust line as the repo itself).
 *   - Law 1: safety laws NEVER live here — they stay always-loaded in
 *     each machine's CLAUDE.md. This store carries routing tables and
 *     reference detail only.
 *   - Law 2: shared, verifiable, cross-machine facts only. Machine-local
 *     memory stays local; no double-homing, no drift.
 *   - Law 3: stable files = identical bytes across spawns = cache
 *     friendly. Don't churn topics casually; state/current-sync.md churns
 *     by design and is exempt.
 *
 * This module is pure fs and portable (both machines use it verbatim),
 * mirroring asks.ts. Topic slugs are validated against a strict pattern
 * so no tool input can traverse out of the store.
 */

import fs from "node:fs";
import path from "node:path";

/** A topic (or state) file's slug: lowercase letters/digits/dashes. This
 *  pattern IS the path jail — anything not matching it cannot form a
 *  path separator or traversal. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ContextEntry {
  topic: string;
  title: string;
  tags: string[];
  updated: string;
  bytes: number;
  section: "topics" | "state";
}

export interface ContextDoc {
  topic: string;
  title: string;
  tags: string[];
  updated: string;
  body: string;
}

/** Minimal front-matter reader: `---` fenced key: value pairs at byte 0. */
function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw }; // see readStoreText: raw is LF-normalized
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: raw.slice(end + 5) };
}

function storeRoot(baseDir: string): string {
  return path.join(baseDir, "docs", "context");
}

/** Read one store file as LF-normalized text. Windows checkouts with
 *  core.autocrlf=true materialize these files CRLF, which would defeat
 *  the `---\n` front-matter fence (titles fall back to slugs, meta rides
 *  the body) and drift search line numbers. One normalization point for
 *  all three surfaces. */
function readStoreText(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** All entries across topics/ (and state/, listed for completeness —
 *  current-sync is tiny but it IS addressable). Unreadable store → []. */
export function listContext(baseDir: string): ContextEntry[] {
  const root = storeRoot(baseDir);
  const out: ContextEntry[] = [];
  for (const section of ["topics", "state"] as const) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(root, section));
    } catch {
      continue; // section absent on this checkout = nothing to list
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const topic = name.replace(/\.md$/, "");
      if (!SLUG.test(topic)) continue;
      const file = path.join(root, section, name);
      try {
        const raw = readStoreText(file);
        const { meta } = parseFrontMatter(raw);
        out.push({
          topic,
          title: meta.title ?? topic,
          tags: meta.tags ? meta.tags.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean) : [],
          updated: meta.updated ?? "",
          bytes: Buffer.byteLength(raw),
          section,
        });
      } catch {
        /* unreadable file — skip, never fail the listing */
      }
    }
  }
  out.sort((a, b) => a.topic.localeCompare(b.topic));
  return out;
}

/** Exactly one file by slug. Bad slug / missing file → null (the tool
 *  layer turns that into a list-suggestion error, never a stack trace). */
export function readContext(baseDir: string, topic: string): ContextDoc | null {
  for (const section of ["topics", "state"] as const) {
    const file = safeFileForSection(baseDir, section, topic);
    if (!file || !fs.existsSync(file)) continue;
    const raw = readStoreText(file);
    const { meta, body } = parseFrontMatter(raw);
    return {
      topic,
      title: meta.title ?? topic,
      tags: meta.tags ? meta.tags.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean) : [],
      updated: meta.updated ?? "",
      body: body.replace(/^\n+/, ""),
    };
  }
  return null;
}

function safeFileForSection(baseDir: string, section: "topics" | "state", topic: string): string | null {
  if (!SLUG.test(topic)) return null;
  const root = storeRoot(baseDir);
  const file = path.resolve(root, section, `${topic}.md`);
  return file.startsWith(root + path.sep) ? file : null;
}

/** Filename + line hits for a query, capped. Case-insensitive substring
 *  match per line — grep, not a search engine (deliberate: v1 non-goal). */
export function searchContext(
  baseDir: string,
  query: string,
  cap = 20,
): { topic: string; section: "topics" | "state"; line: number; text: string }[] {
  const hits: { topic: string; section: "topics" | "state"; line: number; text: string }[] = [];
  const q = query.toLowerCase();
  if (!q) return hits;
  for (const entry of listContext(baseDir)) {
    const file = path.join(storeRoot(baseDir), entry.section, `${entry.topic}.md`);
    let raw: string;
    try {
      raw = readStoreText(file);
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length && hits.length < cap; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ topic: entry.topic, section: entry.section, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= cap) return hits;
      }
    }
  }
  return hits;
}
