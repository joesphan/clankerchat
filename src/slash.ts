// Slash commands (owner green-lit 2026-10-04): /clankerchat status + ask —
// less typo friction than typing "status?" or tagging the bot. This module is
// the PURE core shared by every consumer (our watcher, the peer's daemon):
// the command spec (one shape = both machines register identical commands),
// the status-card renderer (same facts → same card as the typed "status"
// fast-path), and the guild-scoped registration call. Gateway glue
// (interaction handling) stays in the always-on client per machine.
//
// Trust class: a slash interaction carries API-verified identity
// (interaction.user.id) — same class as a human message or an ask click, and
// bots cannot invoke another app's commands, so there is no webhook/spoof
// surface here. The ask TEXT is still untrusted trigger content downstream,
// exactly like a tagged message.

/** Minimal REST surface registerSlashCommands needs — discord.js's client.rest
 *  satisfies it structurally; tests pass a stub. Keeps this module free of
 *  gateway imports. */
export interface SlashRest {
  put(route: string, options?: { body?: unknown }): Promise<unknown>;
}

export interface ApplicationCommandPayload {
  name: string;
  description: string;
  /** 1 = CHAT_INPUT (top-level) or SUB_COMMAND (nested option); 3 = STRING. */
  type?: number;
  /** STRING options only. */
  required?: boolean;
  min_length?: number;
  max_length?: number;
  options?: ApplicationCommandPayload[];
}

/** The command tree: ONE top-level command with two subcommands, so the
 *  guild's slash menu gains a single "clankerchat" entry instead of two
 *  bare /status + /ask names that collide with every other bot's.
 *  Both machines register the identical spec; Discord lists each under its
 *  own bot ("clankerchat — fast-clank" / "… — joesp-desktop"), which is the
 *  desired routing: the human picks WHICH machine to talk to. */
export function slashCommandSpec(): ApplicationCommandPayload[] {
  return [
    {
      name: "clankerchat",
      description: "Talk to this machine's Claude gateway (status, prompt)",
      type: 1,
      options: [
        {
          name: "status",
          description: "Machine status card — no model run",
          type: 1,
        },
        {
          name: "ask",
          description: "Send a prompt to this machine's sessions",
          type: 1,
          options: [
            {
              name: "text",
              description: "Your prompt — the answer posts in this channel",
              type: 3,
              required: true,
              min_length: 1,
              max_length: 1500,
            },
          ],
        },
      ],
    },
  ];
}

/** Guild-scoped bulk overwrite: instant availability (global commands take
 *  up to an hour to propagate) and zero footprint in every other server the
 *  bot is in. Idempotent — safe on every boot. NOTE: users only SEE the
 *  commands once the application carries the applications.commands scope in
 *  the guild (SETUP.md re-auth step); registration itself succeeds without
 *  it, which is fine — the watcher registers on every boot. */
export async function registerSlashCommands(
  rest: SlashRest,
  applicationId: string,
  guildId: string,
): Promise<unknown> {
  return rest.put(`/applications/${applicationId}/guilds/${guildId}/commands`, {
    body: slashCommandSpec(),
  });
}

// ---------------------------------------------------------------------------
// Status card — one renderer for every surface (typed fast-path, slash
// reply), so the two can't drift. Facts are machine-local; the renderer is
// pure and mention-safe: any @ escaping via a thread name (the one string in
// here a third party could have named) is backslash-escaped so it renders as
// literal text, never a live tag.
// ---------------------------------------------------------------------------

export interface StatusFacts {
  bot: string;
  uptimeMs: number;
  active: number;
  maxConcurrent: number;
  queuedHuman: number;
  queuedBot: number;
  /** Ms since the last run started, or null when nothing ran this boot. */
  lastRunAgoMs: number | null;
  /** Where the last run was (thread/channel description), or null. */
  lastRunWhere?: string | null;
  spoolPending: number;
  /** Pre-built machine-local line (service states) appended verbatim. */
  servicesLine?: string;
  /** Prompt-budget one-liner (promptmeter.promptsLine) — plan bills by
   *  prompt count (owner 2026-10-05); absent until the first meter sweep. */
  promptsLine?: string;
  /** Peer machine's last-run time (ISO), relayed by the lane heartbeat —
   *  multi-machine prompts phase 0 on the Discord card. Null-honest: no
   *  fresh lane facts (never probed, peer down) renders NO line rather than
   *  a stale one; the renderer also skips unparseable dates defensively. */
  peerLastRunAt?: string | null;
  /** Lane peer's bot name for the same line (their status verb's "bot"). */
  peerName?: string | null;
}

function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function fmtUptime(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;
}

/** Neutralize mention-shaped text in a card slot by STRIPPING the @ — the
 *  mass-mention law is about the literal token riding in an own post (and the
 *  watcher's own-post alarm greps exactly that shape), so escaping with a
 *  backslash is not enough: "\@everyone" still contains "@everyone". A thread
 *  named "@everyone" renders as "everyone" here — slightly lossy, never live. */
const noMention = (s: string): string => s.replace(/@/g, "");

export function renderStatusCard(f: StatusFacts): string {
  const lines = [`**${noMention(f.bot)}** — status (canned card, no model run)`];
  lines.push(
    `watcher up ${fmtUptime(f.uptimeMs)} · pool ${f.active}/${f.maxConcurrent} · ` +
      `queues h:${f.queuedHuman} b:${f.queuedBot}` +
      (f.lastRunAgoMs !== null
        ? ` · last run ${fmtAgo(f.lastRunAgoMs)}${f.lastRunWhere ? ` (${noMention(f.lastRunWhere)})` : ""}`
        : " · no runs this boot"),
  );
  if (f.servicesLine) lines.push(noMention(f.servicesLine));
  if (f.promptsLine) lines.push(noMention(f.promptsLine));
  // Peer recency line (phase 0): only when the heartbeat delivered a
  // parseable timestamp — absent, null, or garbage renders nothing, so the
  // card never claims peer freshness it doesn't have.
  const peerMs = f.peerLastRunAt ? Date.parse(f.peerLastRunAt) : NaN;
  if (peerMs === peerMs && peerMs > 0) {
    lines.push(`peer ${noMention(f.peerName ?? "machine")} last ran ${fmtAgo(Math.max(0, Date.now() - peerMs))}`);
  }
  lines.push(`lane spool: ${f.spoolPending} pending — richer asks still spawn a run`);
  return lines.join("\n");
}
