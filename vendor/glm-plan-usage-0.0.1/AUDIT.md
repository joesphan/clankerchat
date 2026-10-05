# glm-plan-usage 0.0.1 — provenance + audit

Source: z.ai vendor plugin, delivered 2026-10-05 over the botlink lane by
tyler-cachy (correlation `glm-plan-source-20261005`), after owner "install" +
"go" (thread, own words) and our audit-then-run gate (04:59Z offer).

- Package: `glm-plan-usage-0.0.1.tgz` — 3545 bytes,
  sha256 `361ba928ff9d3d408a58051636e4f4f01a6feb8337b5fa25ee54c81b8502e590`
  (verified on receipt; tree above is that archive, unmodified).
- Verdict: **CLEAN** — audited file-by-file before first run.

## What was checked

- `query-usage.mjs` (the only executable): single `node:https` import; GETs
  only; three endpoints (`/api/monitor/usage/{model-usage,tool-usage,quota/limit}`)
  on the ANTHROPIC_BASE_URL origin, host-gated to api.z.ai / bigmodel.cn; no
  eval/Function/child_process/fs; no telemetry; token read from env and used
  only as the Authorization header — never logged, never written, never sent
  to any other host. No path traversal in the archive; no binaries.
- `plugin.json` / `SKILL.md` / `agents/usage-query-agent.md` /
  `commands/usage-query.md`: instruction defs only (run-once, no-retry,
  no file modification). Cosmetic: `allowed-tools: all` on the command — one
  reason the plugin is NOT installed as a live plugin surface; only the
  audited script and its endpoint map were adopted (`src/providerquota.ts`).

## First run (provenance validation, 2026-10-05 ~05:2xZ)

Exit 0. 5h TOKENS_LIMIT 24%, MCP month 304/4000 (7%), model-usage window
totals 15,770 calls / 2.37B tokens — matching the local 24h attribution
figures independently gathered from on-box jsonl (04:59Z report).

## Notes carried into the port

- Raw wire types are `TOKENS_LIMIT` / `TIME_LIMIT`; the plugin's
  "Token usage(5 Hour)" is a display rename — parse the raw type.
- `nextResetTime` (ms epoch) rides the same limit entry; the plugin's
  post-processor drops it. We keep it (`reset_at` in watcher-state).
- model-usage lags ~10 min, hourly buckets — context, not alarm fuel.
