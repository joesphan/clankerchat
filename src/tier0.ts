// tier0 — the routing decision layer between trigger admission and the
// orchestrator spawn (design settled over three research rounds, 2026-10-05).
//
// The cascade, in evaluation order:
//   1. FORCED rules (security/authority classes) → always tier-1. Never
//      classifier-trusted: repo mutations, secrets/ceremony words, SHAs
//      (cited-SHA law: peer merge asks carry them), ask-decision deliveries,
//      owner/listen/bot-inject triggers. A false positive here only costs
//      today's behavior (a claude spawn) — the safe direction.
//   2. Laya local decision pass (ONNX sidecar over a unix socket, ~40ms,
//      zero egress, fail-safe delegate) when the sidecar is up.
//   3. Heuristic fail-safe when the sidecar is down: strong task verbs →
//      tier-1; strong chatter shapes → tier-0; inconclusive → tier-1
//      (today's behavior — the delegate IS the status quo path).
//
// Bands are binary at the routing seam (t0 = answer via the Groq generation
// seat, t1 = orchestrator/claude spawn). τ_lo exists only as a REPORTED
// confidence marker for the shadow ledger + backtest; the ambiguity band
// routes to t0 with full context (the scrutinizer pattern — t0 WITH context
// is the scrutinizer; there is no drop state and no silent refusal).
//
// Laws baked in:
// - SANITIZE THE COPY, NOT THE MESSAGE: invisible-unicode stripping + NFC
//   run on the classifier input only. Stored/rendered messages humans see
//   are never mutated (defense vs tokenizer-boundary attacks: U+200B/200C/
//   200D/2060/2063/FEFF binary payloads + homoglyph canonical-equivalents).
// - NO NEW DEPENDENCIES: node:net only. The ONNX runtime lives in the
//   machine-local sidecar (~/tools/laya-sidecar), so this repo stays
//   portable to the Windows peer; the peer runs identical routing from the
//   identical repo code, which is the bilateral consistency mechanism.
// - FAIL-SAFE DELEGATE: every error path degrades to t1 (spawn as today).

import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

/** Windows transport shim (2026-10-05): AF_UNIX listen()/connect() on a
 *  filesystem socket path refuses on win32 (EACCES) — the 3/272 r29 audit
 *  fails. Node's named pipes are the native equivalent there. EVERY end of
 *  the sidecar contract (the real listener, layaAsk's client, the test
 *  fakeSidecar) must derive its address through this helper so both sides
 *  always meet on the same name; POSIX passes through untouched, so the
 *  unix-socket contract outside Windows is byte-identical. The sha256 tail
 *  keeps distinct configured paths on distinct pipes even after the
 *  filesystem-unfriendly characters are stripped. */
export function sidecarAddress(sockPath: string): string {
  if (process.platform !== "win32") return sockPath;
  const name = path.basename(sockPath).replace(/[^a-zA-Z0-9_-]/g, "");
  const tag = crypto.createHash("sha256").update(sockPath).digest("hex").slice(0, 8);
  return `\\\\.\\pipe\\cc-laya-${name}-${tag}`;
}

// --- input sanitization --------------------------------------------------------

// Zero-width / invisible characters weaponized against tokenizer boundaries
// (round-3 research: U+200B start marker, U+200C/U+2063 as binary 0/1 bits).
// Stripped BEFORE normalization so the two stages can't recombine. Written as
// escapes, never literal zero-width bytes — invisible regex source is exactly
// the corruption class this rule exists to stop.
const INVISIBLE = /[\u200B\u200C\u200D\u2060\u2063\uFEFF]/g;

export function sanitizeClassifierInput(text: string): string {
  return text.replace(INVISIBLE, "").normalize("NFC");
}

// --- forced escalation (security + authority classes) ---------------------------

const FORCED_RULES: { reason: string; re: RegExp }[] = [
  // Repo mutation intents — version-control operators with targets.
  { reason: "git-operator", re: /\bgit\s+(push|merge|commit|revert|reset|checkout|rebase|cherry-pick|tag)\b/i },
  { reason: "merge-cite", re: /\b(merge|cherry-pick|revert|pull in|take)\s+(the\s+)?(pr|pull[- ]request|commit|branch)\b/i },
  // Cited-SHA law: bilateral merge asks carry bare 7-40 hex SHAs. Rare in
  // chatter, load-bearing in work orders.
  { reason: "sha-cited", re: /(^|[^0-9a-f])[0-9a-f]{7,40}([^0-9a-f]|$)/ },
  // Secrets / ceremonies / credentials — never classifier-trusted, ever.
  { reason: "secret-class", re: /\b(rotat\w+|host[- ]?key|authorized_keys|\bpin\b|pinning|pairing|\bsas\b|api[_ -]?key|token|secret|credential|\.env\b)\b/i },
  // Settings / permissions / containment infrastructure.
  { reason: "settings-class", re: /\b(settings\.json|permissions?|blocklist|allowlist|jail|deny rule|mcp\b|config)\b/i },
  // Process / infrastructure operations.
  { reason: "infra-class", re: /\b(systemctl|daemon|restart (the|your) .+|deploy|unit file|service)\b/i },
];

/** Authority-class triggers decided by the caller's flags, not content. */
export function authorityReason(i: { owner?: boolean; listen?: boolean; isBot?: boolean; deliveryClass?: boolean }): string | null {
  if (i.deliveryClass) return "delivery-class"; // [ask decision] / companion receipts
  if (i.owner) return "owner-direct-line";
  if (i.listen) return "listen-list";
  if (i.isBot) return "bot-inject";
  return null;
}

export function forcedEscalationReason(text: string): string | null {
  for (const r of FORCED_RULES) if (r.re.test(text)) return r.reason;
  return null;
}

// --- heuristic fail-safe (sidecar-down path; also logged as hints when up) -----

const STRONG_TASK =
  /\b(build|compile|deploy|fix|bug|error|crash|fail(?:ed|ing)?|merge|commit|push|branch|refactor|implement|investigate|debug|review|audit|ship|release|migrate|worktree|tests?|pr|patch|diff|regression|flash|reboot|power[ -]?cycle|shut (?:it |this |everything )?down|stop the)\b/i;
// Chatter shape: a chatter token plus any number of FURTHER chatter tokens
// ("lol ok", "thanks, got it") — but never task words ("ok fix it" must not
// match: task verbs aren't in the repetition set). ️ rides the tail for
// direct callers passing un-sanitized text (emoji variant selectors).
const STRONG_CHATTER =
  /^\s*(thanks?|thank you|ty|nice|cool|great|awesome|lol|lmao|ok|okay|got it|haha+|heh|wow|rip|gg|👋|👍|🎉|🔥|💀|❤️)(?:[\s!.,\uFE0F]*(?:thanks?|ty|nice|cool|great|lol|lmao|ok|okay|got it|haha+|heh|wow|rip|gg))*[\s!.,\uFE0F]*$/i;

export function heuristicBand(text: string): { band: "t0" | "t1"; reason: string } {
  if (STRONG_CHATTER.test(text)) return { band: "t0", reason: "heuristic:chatter-shape" };
  if (STRONG_TASK.test(text)) return { band: "t1", reason: "heuristic:task-verb" };
  return { band: "t1", reason: "heuristic:inconclusive-fail-safe" };
}

// --- sidecar client -------------------------------------------------------------

export interface LayaProbe {
  probs: number[]; // aligned with the options array sent
  took_ms: number;
}

/** One NDJSON round-trip to the sidecar. Throws on connect/parse/timeout.
 * Default 5s: observed p95 1.7s under load (backtest 2026-10-05) — 2s was one
 * CPU spike from flap-failing to t1. Still trivially cheap next to a spawn. */
export function layaAsk(
  sockPath: string,
  payload: { text: string; question: string; options: string[] },
  timeoutMs = 5_000,
): Promise<LayaProbe> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sidecarAddress(sockPath));
    const id = Math.random().toString(36).slice(2);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("laya sidecar timeout"));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ id, ...payload }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const res = JSON.parse(buf.slice(0, nl));
        if (res.id !== id) return reject(new Error("laya sidecar id mismatch"));
        if (res.error) return reject(new Error(`laya sidecar: ${res.error}`));
        if (!Array.isArray(res.probs)) return reject(new Error("laya sidecar: no probs"));
        resolve({ probs: res.probs, took_ms: Number(res.took_ms) || 0 });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --- the decision ---------------------------------------------------------------

export const TAU_HI = 0.65; // ≥ → tier-1 (research round-3 bands; backtest tunes)
export const TAU_LO = 0.30; // < → "confident chatter" marker (reported, not routed differently)
// Disagreement veto floor (live-smoke justified 2026-10-05): the shipped ONNX
// checkpoint separates VERBOSE work orders (p≈0.88) from chatter (p≈0.07-0.22)
// well but scores SHORT imperative work orders in the chat half ("fix the
// build error" p≈0.52, "investigate X and patch it" p≈0.27). A strong-task-
// verb heuristic hit therefore vetoes t0 routing unless Laya puts the message
// DEEP in chat territory (p < TAU_LO). Veto cost = a spawn we made anyway
// pre-cascade; veto miss = Groq's scrutinizer redirect (soft). Shadow-ledger
// observations on real traffic tune this; known-soft: sub-τ_lo short work
// orders still ride t0-with-context and get redirected, not misanswered.
// Input budget = the REAL bound of the only ONNX bundle that exists (verified
// 2026-10-05 from the repo's own laya_config.json): max_len 512 tokens, state
// SILENTLY truncated past it. The question+options head eats ~75 of those
// tokens (observed in_tok=85 on a short message), leaving ≈437 for state —
// ~1600 chars keeps trigger + newest context inside with margin. The round-3
// "8192-token multilingual" claim is PyTorch-upstream-only — no ONNX export
// exists; when one ships, raise this and flip LAYA_SUBFOLDER in the sidecar.
const CLASSIFIER_INPUT_MAX = 1_600;

export interface Tier0Input {
  text: string;
  history?: string[]; // rendered context lines, oldest first
  owner?: boolean;
  listen?: boolean;
  isBot?: boolean;
  deliveryClass?: boolean;
}

export interface Tier0Decision {
  band: "t0" | "t1";
  reason: string;
  source: "forced-rule" | "authority" | "laya" | "fail-safe";
  pTask?: number;
  confident?: boolean; // τ_lo marker for the ledger
  latencyMs?: number;
  hint?: string; // heuristic band, logged even when Laya decides
}

export const TIER0_QUESTION =
  "Does properly answering this message require code changes, repository work, running tools or commands, or system operations? Or is a plain conversational answer enough?";
export const TIER0_OPTIONS = ["needs code, repo, tool, or system work", "plain conversational answer is enough"];

export async function decideTier0(i: Tier0Input, opts: { sockPath: string }): Promise<Tier0Decision> {
  const clean = sanitizeClassifierInput(i.text ?? "");
  const hint = heuristicBand(clean).reason;

  const auth = authorityReason(i);
  if (auth) return { band: "t1", reason: `authority:${auth}`, source: "authority", hint };

  const forced = forcedEscalationReason(clean);
  if (forced) return { band: "t1", reason: `forced:${forced}`, source: "forced-rule", hint };

  // TRIGGER FIRST, then newest→oldest context, sliced head-first: the trigger
  // always rides whole and the OLDEST context is what gets dropped under the
  // cap. (History arrives oldest-first; the watcher's last history line is the
  // trigger echo, which reversed lands right after the trigger text — harmless
  // emphasis, and it makes the decision robust to history-order drift.)
  const state = [clean, ...(i.history ?? []).slice().reverse()].join("\n").slice(0, CLASSIFIER_INPUT_MAX);
  try {
    const probe = await layaAsk(opts.sockPath, { text: state, question: TIER0_QUESTION, options: TIER0_OPTIONS });
    const pTask = probe.probs[0] ?? 0;
    // Disagreement veto (see TAU_LO comment): a task-verb hint blocks t0
    // unless the classifier is CONFIDENTLY chat. hint is the full heuristic
    // reason; only the task-verb shape vetoes (inconclusive never does).
    const vetoed = hint === "heuristic:task-verb" && pTask >= TAU_LO;
    return {
      band: pTask >= TAU_HI || vetoed ? "t1" : "t0",
      reason: `laya:p=${pTask.toFixed(3)}${vetoed ? "+task-veto" : ""}`,
      source: "laya",
      pTask,
      confident: pTask < TAU_LO,
      latencyMs: probe.took_ms,
      hint,
    };
  } catch {
    const fb = heuristicBand(clean);
    return { band: fb.band, reason: fb.reason, source: "fail-safe", hint };
  }
}
