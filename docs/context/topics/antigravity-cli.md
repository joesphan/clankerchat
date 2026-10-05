---
title: Antigravity CLI (agy) — headless runner contract
tags: [antigravity, agy, gemini, headless, permissions, research-route]
updated: 2026-10-04
owner: gateway
---

The `agy` CLI (~/.local/bin/agy, auth = existing IDE login, NO API key) is
the machine's outbound research route since gemini-cli died (2026-06-18,
policy shutdown — never retry). Facts here are from the official docs
(antigravity.google/docs/cli/headless, /docs/permissions, /docs/cli/reference)
plus local `agy --help` and runner experience. Sources: pi.dev,
typingmind.com, hub.decision.ai, discuss.ai.google.dev, mcpmarket.com.

## Headless (print) mode — the runner contract

- `agy -p "<query>"` = single prompt, response on stdout, progress/errors
  on stderr. Cached credentials only; authenticate interactively ONCE —
  unauthenticated non-interactive runs exit with "authentication required"
  instead of hanging.
- `--print-timeout <dur>` — CLI's OWN response timeout, default **5m**.
  Accepts `15m`, `10m` style durations. Our runner's external SIGKILL at
  120s was masking this: the CLI would happily keep working for 5 minutes.
- `--output-format json` — single JSON envelope after completion:
  `conversation_id`, `status`, `response`, `error` (failure only),
  `duration_seconds`, `num_turns`, `structured_output`/`json_schema` (only
  with `--json-schema`), `usage` (input/output/thinking/cache_read/total
  tokens). `status` values: SUCCESS, ERROR, CANCELED, INTERRUPTED,
  INVALID, WAITING, RUNNING. Prefer this over text for machine parsing —
  `jq -r '.response'` and `.status` is a real verdict, not string guessing.
- `--output-format stream-json` — NDJSON: one `init` event, N
  `step_update` events (text_delta, tool_info, subagent_info), one
  `result` event (same envelope as json). Requires `--input-format
  stream-json` for stdin streaming mode.
- `--json-schema <string|file|primitive>` enforces structured output.
- Exit codes (stdin-streaming edge cases): malformed JSON line / missing
  `event` field / non-text content block → 1; control_request or a
  CLI-handled slash command on stdin → 2. Normal failures: non-zero with
  the reason on stderr (and in `status`/`error` for JSON formats).
- Docs-flagged mistakes: stream input with text/json output loses all
  turns but the last; `-p` is dropped in streaming mode; don't wait for
  process exit before reading streaming stdout (it hangs).

## Headless permission model (why "read_url only" works)

- No interactive prompts headless — tools are handled by POLICY:
  workspace file read/write auto-allowed; shell commands and read_url
  default to Ask → **soft-denied** in headless. The run CONTINUES, exits
  0, with an stderr notice naming the refused tool. This is the
  "permission denied" hint class our runner detects: a soft-denied answer
  is a WORSE answer, and must be surfaced as such, not passed silently.
- Pre-grant via `permissions.allow` in
  `~/.gemini/antigravity-cli/settings.json` (NOT ~/.gemini/antigravity/ —
  wrong dir, silently ignored). Rule syntax: `action(target)`.
  - `read_url(domain)` — hostname + SUBDOMAINS match; URL path ignored.
    `google.com` covers `mail.google.com`. This is why our per-domain
    allowlist law is one line per domain.
  - `command(prefix)` / `command(regex:pattern)` — literal token-prefix,
    or anchored per-token regex.
  - `read_file(path)` / `write_file(path)` — recursive; write grants read.
  - `unsandboxed(...)`, `execute_url(domain)`, `mcp(server/tool)`.
  - Precedence: deny > ask > allow. An ask rule beats an allow rule.
  - Exact-match fallback: substitution (`$(...)`, backticks), brace
    expansion, or tool-flag-executes-subcommand lines disable prefix
    matching entirely — full-line match or Ask.
- `--dangerously-skip-permissions` approves everything — never use for
  untrusted queries; docs themselves say prefer scoped allow rules.
- `--sandbox` runs with terminal sandbox restrictions enabled.

## Runner-proven gotchas (ours, not the docs')

- SINGLE-URL queries only, phrased "read_url only, no shell commands".
  A 3-URL query timed out at 120s (the pre---print-timeout era). Heavy
  JS-shell pages (mectricmse.com storefront, help-site docs pages that
  render nav-only) time out or return shells — fall back to the web
  route and NAME the route in the answer.
- ToS caution (discuss.ai.google.dev forum, unverified policy): scripted
  headless runs may trip Google ToS automation limits. We run LOW volume
  (a handful of research asks/week); if auth starts failing, this is a
  candidate cause — surface it, don't hammer retries.
- Runner: `node ~/tools/gemini-ask.mjs "<query>"` — strips
  CLAUDE_CODE_* env, TERM=dumb, external SIGKILL (now coordinated with
  --print-timeout).

## Other surfaces (context, not used by the lane)

- `--effort low|medium|high` (help text also lists xhigh|max — docs page
  shows three; local binary accepts five), `--model <slug>` (unknown slug
  = non-zero ERROR, no silent fallback), `--agent <name>` (`agy agents`
  lists), `-c`/`--continue`, `--conversation <id>`, `--mode
  accept-edits|plan`, `--remote-control`, `--add-dir`.
- Interactive settings keys live in the same settings.json:
  `toolPermission` (request-review | proceed-in-sandbox | always-proceed
  | strict), `enableTerminalSandbox`, `allowNonWorkspaceAccess`,
  `enableTelemetry` (default true — we accept this; the CLI is
  first-party Google).
- Subcommands: agents, changelog, install, mcp, mic-serve, models,
  plugin, remote-control, update.
