# Sync state — clankerchat forks

Updated 2026-10-04 (both-green, post audit round — fully synced, zero cites outstanding).

- origin/main (joesphan): `ee584bd` — peer acked ALL FOUR outstanding cites:
  9f5af5a + 7e2305a + 42f3627 (bb068ec merge + a699b26 watcher port) and
  1856fc1 (9f52d5b merge + ee584bd daemon port). Held ancestors 086a47b +
  092ea4d came home in the merge ancestry. Their port moved the V2-text
  join into leaks.ts as scanTextOfPost — shared, recursive, unit-tested —
  and mirrored both watcher-local audit fixes (card-aware posted-check,
  canary scan reads TextDisplays) in src/daemon.ts. 125/125 their side.
- fork main (tjbtiller): fast-forward to ee584bd + flake fix. Our add this
  round: createPendingAsk single-stamps the clock (createdAt/expiresAt
  differ by EXACTLY ttl — two Date.now() calls drifted ±ms on a scheduler
  tick and flaked the asks suite; test asserts exactness now honestly).
  Watcher rewired to scanTextOfPost (drift law: one implementation of
  "all text of a post"; the recursive walk also catches TextDisplays
  nested deeper than one container level). 125/125, watcher restarted.
- Live proofs stand: V2 post + countdown tick + expiry edit (receipts
  1556269420500746261 + 1556270343260213339, botlink thread).
- Open TODO: phone-prompt history nav (needs usage signal). Parked ideas
  are owner decisions.
