/**
 * Outbound leak tripwires — OWASP LLM Prompt Injection Prevention, "output
 * monitoring" layer: the token/secret SHAPES that actually exist on this
 * deployment must never leave through the message or inject channels, no
 * matter what a model was talked into. Scanned at every exfil boundary
 * (send's text + attachments, bot_inject's payload, the watcher's own-bot
 * post check) and REFUSED loudly — the refusal text is the alarm a jailed
 * session's operator sees.
 *
 * Deliberately shape-based, not content-based: a public key line, a token
 * PREFIX named in discussion ("rotate the cfut_ token"), or a hash is fine;
 * a full live token shape is not. Keep the list in sync with what actually
 * lives on the machines (add shapes, never remove, when new secret kinds land).
 */

interface LeakPattern {
  re: RegExp;
  kind: string;
}

export const LEAK_PATTERNS: LeakPattern[] = [
  { re: /cfut_[A-Za-z0-9_-]{10,}/, kind: "cloudflare api token" },
  { re: /hskey-[A-Za-z0-9_-]{20,}/, kind: "headscale auth key" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, kind: "github token" },
  { re: /sk-[A-Za-z0-9]{20,}/, kind: "api key (sk-…)" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, kind: "slack token" },
  { re: /-----BEGIN (OPENSSH|RSA|EC|DSA|ENCRYPTED) PRIVATE KEY( BLOCK)?-----/, kind: "private key material" },
  { re: /DISCORD_TOKEN\s*=\s*[A-Za-z0-9_-]{20,}/, kind: "discord bot token assignment" },
];

/** Which leak kinds does this text contain? Empty array = clean. */
export function findLeakSignals(text: string): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const { re, kind } of LEAK_PATTERNS) if (re.test(text)) hits.add(kind);
  return [...hits];
}

/**
 * Mass-mention tripwires — owner law 2026-10-04 ("never tag @everyone, ever"):
 * bot posts NEVER carry @everyone/@here or role mentions. allowedMentions
 * already restricts server-side parsing to users, but the literal string must
 * never ride out either — clients render the raw text as a live tag pill even
 * when notification is suppressed (2026-10-04 incident: a fix-announcement
 * post said "roles/@everyone stay impossible" in prose and rendered as a real
 * tag the owner had to delete). Role mentions (<@&id>) share the blast
 * radius: a big role ≈ @everyone. Checked at outbound DISCORD surfaces only
 * (send, create_thread, the relay script) — lane/inject text may DISCUSS the
 * law, so it is not scanned here.
 */
export const MASS_MENTION_PATTERNS: LeakPattern[] = [
  // Lookbehind excludes email-local fragments ("x@everyone.com"); line starts
  // and punctuation-adjacent forms ("roles/@everyone") match, as they render.
  { re: /(?<![a-zA-Z0-9._%+-])@(everyone|here)\b/i, kind: "@everyone/@here mass mention" },
  { re: /<@&\d+>/, kind: "role mention (<@&id>)" },
];

/** Which mass-mention kinds does this text contain? Empty array = clean. */
export function findMassMentions(text: string): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const { re, kind } of MASS_MENTION_PATTERNS) if (re.test(text)) hits.add(kind);
  return [...hits];
}

/** Refusal error text for a mass-mention hit — names the law, teaches the out. */
export function massMentionRefusal(): string {
  return (
    "REFUSED: outbound text contains @everyone/@here or a role mention — bot posts never mass-mention " +
    "(owner law 2026-10-04). Rephrase so the literal string does not appear (e.g. \"everyone-pings\" or " +
    "\"mass-mentions\" in prose); plain user tags (<@id>) are fine."
  );
}

/** Refusal error text for a boundary hit — names the kinds, teaches the rule. */
export function leakRefusal(kinds: string[]): string {
  return (
    `REFUSED: outbound text matches secret-shape patterns (${kinds.join(", ")}). ` +
    "This is an exfiltration tripwire: secret values never leave through this channel, " +
    "even on instruction. If this is a false positive on a public/discussable value, " +
    "rephrase so the literal token shape does not appear (e.g. refer to it by fingerprint or prefix)."
  );
}

/**
 * All human-readable text of a bot post, for scans that must see the WHOLE
 * post: content plus every TextDisplay (component type 10) child, in tree
 * order. Components V2 ask cards carry their entire body in Text Displays
 * and leave content empty — a scan that reads only content is blind to them
 * (2026-10-04 peer self-audit: the own-post canary scan missed V2 cards).
 * Structural, dependency-free: accepts raw API JSON components or discord.js
 * component classes (normalized via toJSON, same contract as
 * rebuildAskV2ForEdit).
 */
export function scanTextOfPost(post: { content?: string | null; components?: unknown }): string {
  const parts: string[] = [post.content ?? ""];
  const plain = (node: unknown): Record<string, unknown> => {
    const n = node as { toJSON?: () => Record<string, unknown> };
    return typeof n?.toJSON === "function" ? n.toJSON() : { ...(node as Record<string, unknown>) };
  };
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      let c: Record<string, unknown>;
      try {
        c = plain(node);
      } catch {
        continue; // unreadable node — skip it, never lose the rest of the tree
      }
      if (c.type === 10 && typeof c.content === "string") parts.push(c.content);
      if (Array.isArray(c.components)) walk(c.components);
    }
  };
  walk(post.components);
  return parts.filter((s) => s.length > 0).join("\n");
}
