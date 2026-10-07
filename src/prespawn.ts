// Pre-spawn gate classifier — the layer BELOW tier-0.
//
// Tier-0 already answers "conversational" triggers without a session (Groq
// probe, ~258 tokens). This layer catches the shapes that need NO model at
// all: bare acknowledgments (a reaction is the whole correct response) and
// status pings (answerable from watcher-local state). Pure regex + shape
// caps, zero I/O — the SEMANTIC veto stays with the tier cascade: the
// watcher only deflects when prespawnClass() matches AND decideTier0()
// independently bands the same trigger t0. Two unrelated systems must agree
// before a trigger is consumed without a session; either one alone blocks
// it. Authority-class, forced-escalation, image, phone-prompt and routed
// triggers never reach the deflect condition in the watcher.
//
// The shapes are deliberately NARROW: single acknowledgment phrases, emoji
// clusters, bare status requests. Anything with a second clause, a URL, a
// code fence, or a directive verb falls through to the normal cascade and
// gets a real answer. A false negative costs a Groq probe; a false positive
// swallows a message — so every ambiguous word (yes/no/sure/fine/done) is
// excluded on purpose.

export type PrespawnKind = "ack" | "status";

export interface PrespawnMatch {
  kind: PrespawnKind;
  reason: string; // short shape note for the ledger
  remainder: string; // the matched text after mention-stripping (audit trail)
}

// How triggers actually arrive: "<@botid> ok", sometimes two mentions, and
// Discord pads with stray leading whitespace after the autocomplete chip.
const LEADING_MENTION = /^\s*(?:<@!?\d+>\s*)+/;

// Skin tones, ZWJ, variation selectors ride an emoji cluster; digits are
// deliberately NOT in here (they are Emoji_Components but "42" is not an ack).
const EMOJI_CLUSTER = "\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u200D\\uFE0F";

// Trailing punctuation run permitted after an ack word ("ok!", "thanks."),
// and the short trailing-emoji run permitted after it ("ok 👍🔥").
const TRAILING = `[\\s!.,!?~…]*`;

const ACK_WORDS = [
  "ok", "okay", "okays", "k", "kk", "kewl",
  "thanks", "thank you", "thankyou", "thx", "ty", "tyty",
  "nice", "good", "good stuff", "great", "cool", "cool cool", "perfect",
  "awesome", "excellent", "lovely", "beautiful", "clean",
  "fire", "lit", "np", "no problem", "no worries",
  "sounds good", "sounds great", "sounds good to me", "got it", "gotcha",
  "roger", "roger that", "ack", "understood", "understood perfectly",
  "lol", "lmao", "lmfao", "haha", "hahaha", "heh", "hehe",
  "same", "gg", "gz", "wg", "f", "rip", "based", "real", "mood", "w", "flex",
  "alright", "alrighty", "o7",
].sort((a, b) => b.length - a.length); // longest-first so "sounds good" wins over "sounds"

const ACK_RE = new RegExp(
  `^(?:${ACK_WORDS.map(escapeRe).join("|")})(?:\\s+[${EMOJI_CLUSTER}]+)*${TRAILING}$`,
  "iu",
);
const EMOJI_ONLY_RE = new RegExp(`^[${EMOJI_CLUSTER}\\s]{1,24}$`, "u");
const STATUS_RE =
  /^(?:status|state|stat|what'?s (?:the |your )?(?:status|state)|any status)[\\s?!.]*$/i;

// Anything containing these is not a zero-token shape, whatever the words.
const DISQUALIFIERS = [/https?:\/\//i, /www\./i, /```/, /`/, /\n/, /\r/, /[<>]/, /@\w+/, /\d{4,}/];

const MAX_ACK_CHARS = 48;
const MAX_STATUS_CHARS = 60;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMentions(text: string): string {
  return text.replace(LEADING_MENTION, "").replace(/\s+/g, " ").trim();
}

function disqualified(text: string): boolean {
  // "@"word catches leftover user @handles; "<" ">" catch any residual
  // Discord markup (channels, roles, custom emoji); 4+ digits catch ids.
  return DISQUALIFIERS.some((re) => re.test(text));
}

/**
 * Classify a trigger as a zero-API shape ("ack" — reaction is the response;
 * "status" — answer from watcher-local state) or null (fall through to the
 * normal tier cascade). Never throws, never does I/O.
 */
export function prespawnClass(input: string | null | undefined): PrespawnMatch | null {
  const raw = String(input ?? "");
  if (!raw) return null;
  const text = stripMentions(raw);
  if (!text) return null; // mention-only message: not ours to consume cheaply
  if (disqualified(text)) return null;

  if (text.length <= MAX_STATUS_CHARS && STATUS_RE.test(text)) {
    return { kind: "status", reason: "shape:status", remainder: text };
  }
  if (text.length <= MAX_ACK_CHARS) {
    if (EMOJI_ONLY_RE.test(text) && /\p{Extended_Pictographic}/u.test(text)) {
      return { kind: "ack", reason: "shape:emoji-only", remainder: text };
    }
    if (ACK_RE.test(text)) {
      return { kind: "ack", reason: `shape:ack:${text.split(" ")[0].toLowerCase()}`, remainder: text };
    }
  }
  return null;
}
