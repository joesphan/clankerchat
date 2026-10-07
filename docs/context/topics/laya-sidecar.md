---
title: Laya tier-0 sidecar (tyler-cachy reference install)
tags: [laya, tier0, onnx, sidecar, routing, lexical-blend]
updated: 2026-10-07
owner: tyler-cachy
---

The tier-0 classifier runs as a machine-local ONNX sidecar so native
runtime code never shares a process with the watcher (blast radius of a
segfault/OOM = "decisions degrade to fail-safe t1", the shape tier0.ts
was designed around). This file is the reference install from
tyler-cachy — everything here was verified on the live machine.

## Layout (all outside the repo, by law)

- `~/tools/laya-sidecar/` — `sidecar.mjs` (the service), `preload.mjs`
  (one-shot cache warmer), `package.json` with a single dependency
  `@receptron/laya ^0.1.2` (pulls onnxruntime-node; win32-x64 prebuilts
  exist, no build tools needed).
- Model: **HF `receptron/laya-onnx`, root bundle only** (verified
  2026-10-05: no subfolders exist; the "multilingual" variant is
  PyTorch-upstream-only). `ensureBundle()` auto-fetches to
  `~/.cache/receptron-laya/receptron--laya-onnx/main/` (Windows:
  `%USERPROFILE%\.cache\...`): `laya.onnx` + `laya.onnx.data` +
  `laya_config.json` (max_len 512, head_max_len 192) + `tokenizer/`.
  ~1.6 GB RSS under the CPU arena; budget ~4 GB for the service.
- Service: systemd `--user` unit `laya-sidecar.service`
  (Restart=always, RestartSec=5, TimeoutStartSec=30, MemoryMax=4G).
  Boot ≈ 4.5 s (mmap). Windows needs a service wrapper with the same
  shape (NSSM / node-windows / sc.exe): restart-always + memory cap.

## Install steps (POSIX; Windows deltas at the end)

1. `mkdir ~/tools/laya-sidecar` — copy in `sidecar.mjs`, `preload.mjs`,
   `package.json` (attached to the 2026-10-07 lane inject; identical
   copies live in this repo's history of that inject).
2. `npm install` (Node LTS x64).
3. `node preload.mjs` once — downloads/verifies the bundle into the HF
   cache so the service never downloads on first boot.
4. Install the unit (drop-in dir for env overrides), then
   `systemctl --user enable --now laya-sidecar`.

## Socket contract (NDJSON, one line each way)

The sidecar listens on `LAYA_SOCK` (ours: `<repo>/botlink-spool/laya.sock`).
Requests: `{"id","text","question","options":[a,b]}` →
`{"id","probs":[pA,pB],"took_ms"}`; `{"id","ping":true}` →
`{"id","pong":true,...limits}`; errors → `{"id","error"}`. Decision pass
~140–500 ms observed end-to-end (single forward + blend math).

**Windows delta (the one real trap):** `src/tier0.ts sidecarAddress()`
rewrites any path to `\\.\pipe\cc-laya-<sanitized-basename>-<sha256(path)[0:8]>`
on win32, and `layaAsk` connects THERE. The standalone sidecar listens on
its raw `LAYA_SOCK` value — so on Windows the SIDECAR's `LAYA_SOCK` must
be set to the derived pipe name, not the plain path:

```
node -e "const c=require('crypto'),p=require('path');const s='C:\\\\path\\\\to\\\\spool\\\\laya.sock';console.log('\\\\\\\\.\\\\pipe\\\\cc-laya-'+p.basename(s).replace(/[^a-zA-Z0-9_-]/g,'')+'-'+c.createHash('sha256').update(s).digest('hex').slice(0,8))"
```

…run with your spool path, put the printed pipe into the sidecar's
`LAYA_SOCK`, and give the WATCHER the plain path (`LAYA_SOCK` there too —
`clankerchat-watch.mjs:204` defaults to `<spool>/laya.sock`). The repo
derives the identical pipe from its side. POSIX passes through untouched.

## tier-0 wiring (repo side — identical on both machines)

`decideTier0()` sanitizes the trigger (invisible-unicode strip + NFC +
label-injection strip — classifier view only), builds
`state = trigger + reversed history` capped at `CLASSIFIER_INPUT_MAX`,
then `layaAsk(sockPath, {text: state, question: TIER0_QUESTION,
options: TIER0_OPTIONS})` — 5 s timeout, id-match guard, any error →
fail-safe t1. Decision: `p ≥ 0.65` → t1; task-verb veto
(`STRONG_TASK ∧ p ∈ [0.3, 0.65)`) → t1; else t0. `CLANKER_LAYA_TEMP`
rescaling exists but stays OFF pending its backtest law. Health check =
tier0-ledger entries: `source:"laya"` with p values = healthy;
`source:"fail-safe"` = sidecar down.

## Lexical blend (2026-10-07, tyler-cachy only for now)

`sidecar.mjs` accepts an optional `LAYA_LEXICON=<lexicon.json>` env:
a veto-preserving blend `σ(α·logit(p_laya) + β·(platt·s_lex) + c)` where
`s_lex` is an FNV-1a hashed bag-of-words over the input. Trained on this
machine's thread corpus (1,031 outcome-labeled messages): honest nested-OOF
AUC 0.6013 → 0.7408 through the deployed path; task-verb texts return
`p_laya` verbatim so the veto is never disabled. Weights are corpus-derived
(machine-specific) — leave unset unless you train your own; the flag-off
path is byte-identical to the pre-blend sidecar.
