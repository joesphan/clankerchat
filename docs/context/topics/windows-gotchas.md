---
title: Windows gotchas (joesp-desktop)
tags: [windows, portability, crlf, paths, process-control]
updated: 2026-10-04
owner: joesp-desktop
---

Platform traps hit on the Windows side of this codebase, each verified
live (not theorized). Cross-machine rule: peers on POSIX can't reproduce
these — treat a Windows-only test failure as a portability bug first,
not flakiness.

## CRLF checkouts break LF-fenced parsing

`core.autocrlf=true` (this machine) materializes repo text as CRLF on
checkout. Any parser that fences on exact bytes — `---\n` front-matter,
`\n---\n` closers, line-split counters — silently degrades: titles fell
back to slugs, meta rode the body (context store, 2026-10-04). Fix
pattern: normalize `\r\n` → `\n` at ONE read point per store
(`readStoreText` in src/context.ts), never per call site. Git stores LF;
only the working tree is CRLF.

## URL pathname is not a Windows path

`new URL(".", import.meta.url).pathname` yields `/C:/Users/...` — win32
`path.resolve` mangles it into a nonexistent `C:\C:\...` root. Repo
idiom (botlink/guards/e2e tests):

```js
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```

## Filenames from fingerprints

SHA256 fingerprints contain `:` and `+` — both illegal in NTFS path
segments. Never derive a filename straight from a hash or key id
(adb095e fixed this class once; third strike applies).

## Process control law (owner directive 2026-10-03)

- Kill by PID tree only: `taskkill /PID <n> /T /F` — never `/IM name`
  sweeps (they reap unrelated node.exe: MCP servers, expo, companion).
- `taskkill` runs from PowerShell, not Git Bash (arg parsing differs).
- Verify the protected stack after any restart: rdpjoe Cloudflare tunnel
  (untouchable prod), botlink lane server, companion/phone stream.
- Restart currency check first: `git diff <restart-era-commit>..HEAD
  --stat -- <modules the process loads>` — if empty, the running process
  already executes current code; restarting again is ceremony plus risk.

## Shell split

POSIX tooling runs Git Bash; PowerShell 5.1 wraps native stderr in
ErrorRecords (`2>&1` flips `$?` even on exit 0) and lacks `&&`. Node
launch lines mix `/` and `\` separators harmlessly; quote paths with
spaces in `.cmd` wrappers.

## npm

`npm install` warns `ssh2` install-script is pending allow-scripts
approval — expected on this machine, not a broken dep.
