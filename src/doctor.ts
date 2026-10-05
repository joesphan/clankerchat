import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

// companion --doctor (round 5 addendum, 2026-10-04): the metro CI-mode fight
// took two hours because every symptom was device-side ("unexpected
// character e") while the machine held every checkable fact. This command
// puts the machine's facts in one place: signed surface, enrolled phones and
// their poll liveness, spool delivery health, dev-server state + code
// freshness, firewall. Every check is best-effort — a tool that doesn't
// exist (journalctl/ufw on Windows) is SKIP, never a false FAIL.

export interface DoctorLine {
  check: string;
  state: "PASS" | "FAIL" | "SKIP" | "WARN";
  detail: string;
}

/** Current UI marker embedded in the app source — the served dev bundle must
 *  contain it or the phone is being handed STALE CODE (the exact class that
 *  burned an evening: old cached bundle + degraded dev server). Bump this
 *  whenever the app's primary surface changes. Current literal = the
 *  signedFetch header comment (round 19: burn+dispatch fully serialized so
 *  counter arrival order == burn order; also composite history cursor,
 *  live-copy dedupe, sub-fetch error surfacing, double-scan guard) — only
 *  round-19 bundles carry it. */
export const BUNDLE_MARKER = "tok-window-v14";

function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function sh(cmd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export interface DoctorOpts {
  /** keydir (companion-keys) holding pins + counters.json */
  keysDir: string;
  /** signed-surface host:port (the companion serve bind) */
  companionHost: string;
  companionPort: number;
  /** spool dir (asks + phone prompts delivery health) */
  spoolDir: string;
  /** dev-server (metro) host:port serving Expo Go */
  metroHost?: string;
  metroPort?: number;
  /** firewall ports that must be reachable from the LAN */
  fwPorts?: number[];
  /** subsystems to skip outright (tests skip metro/journal/ufw) */
  skip?: string[];
}

export async function runDoctor(opts: DoctorOpts): Promise<DoctorLine[]> {
  const out: DoctorLine[] = [];
  const skip = new Set(opts.skip ?? []);

  // 1. signed surface — the phone's whole world resolves through this port
  const companionUp = await tcpReachable(opts.companionHost, opts.companionPort);
  out.push({
    check: "companion signed surface",
    state: companionUp ? "PASS" : "FAIL",
    detail: companionUp
      ? `${opts.companionHost}:${opts.companionPort} accepting connections`
      : `${opts.companionHost}:${opts.companionPort} NOT reachable — is the companion service running?`,
  });

  // 2. enrolled phones + poll liveness (counters are the observability
  //    signal by design — successful signed polls journal nothing)
  try {
    const pins = fs
      .readdirSync(opts.keysDir)
      .filter((f) => f.endsWith(".pub"));
    out.push({
      check: "enrolled phones",
      state: pins.length > 0 ? "PASS" : "WARN",
      detail: pins.length > 0 ? `${pins.length} pinned (${pins.map((f) => f.replace(".pub", "").slice(0, 18) + "…").join(", ")})` : "no phones enrolled",
    });
    const countersFile = path.join(opts.keysDir, "counters.json");
    if (fs.existsSync(countersFile)) {
      const stat = fs.statSync(countersFile);
      const ageS = Math.round((Date.now() - stat.mtimeMs) / 1000);
      const max = Math.max(...Object.values(JSON.parse(fs.readFileSync(countersFile, "utf8")) as Record<string, number>));
      // A foregrounded phone polls every ~2s; suspended/locked = minutes of
      // age and that is EXPECTED, not a fault — hence WARN, never FAIL.
      out.push({
        check: "phone poll liveness",
        state: ageS < 30 ? "PASS" : "WARN",
        detail: `counters max=${max}, last write ${ageS}s ago${ageS < 30 ? "" : " — phone suspended/locked (normal) or app closed"}`,
      });
    } else {
      out.push({ check: "phone poll liveness", state: "SKIP", detail: "no counters.json yet — phone has never polled" });
    }
  } catch (e) {
    out.push({ check: "enrolled phones", state: "SKIP", detail: `keys dir unreadable: ${(e as Error).message}` });
  }

  // 3. spool delivery health — a pending phone prompt older than a minute
  //    means the watcher's claim sweep is down (that's the exact condition
  //    the 15-min TTL exists to surface, caught 14 minutes earlier here)
  if (!skip.has("spool")) {
    try {
      const promptsDir = path.join(opts.spoolDir, "pending-prompts");
      const stuck = fs.existsSync(promptsDir)
        ? fs.readdirSync(promptsDir).filter((f) => {
            if (!f.endsWith(".json")) return false;
            try {
              const rec = JSON.parse(fs.readFileSync(path.join(promptsDir, f), "utf8"));
              return rec.status === "pending" && Date.now() - rec.createdAt > 60_000;
            } catch {
              return false;
            }
          })
        : [];
      out.push({
        check: "prompt delivery sweep",
        state: stuck.length > 0 ? "FAIL" : "PASS",
        detail:
          stuck.length > 0
            ? `${stuck.length} prompt(s) pending >60s — the watcher claim sweep is down or wedged (records will self-expire at 15m saying so)`
            : "no stuck pending prompts",
      });
      const asksDir = path.join(opts.spoolDir, "pending-asks");
      const decidedUndelivered = fs.existsSync(asksDir)
        ? fs.readdirSync(asksDir).filter((f) => {
            if (!f.endsWith(".json")) return false;
            try {
              const rec = JSON.parse(fs.readFileSync(path.join(asksDir, f), "utf8"));
              return rec.status && rec.status !== "pending" && !rec.enqueuedAt && String(rec.decidedBy ?? "").startsWith("companion:");
            } catch {
              return false;
            }
          })
        : [];
      out.push({
        check: "ask decision delivery",
        state: decidedUndelivered.length > 0 ? "FAIL" : "PASS",
        detail:
          decidedUndelivered.length > 0
            ? `${decidedUndelivered.length} phone-decided ask(s) undelivered >sweep-interval — same sweep, same verdict`
            : "no undelivered phone decisions",
      });
    } catch (e) {
      out.push({ check: "prompt delivery sweep", state: "SKIP", detail: `spool unreadable: ${(e as Error).message}` });
    }
  }

  // 4. dev server (metro) — reachability, CI-mode, and CODE FRESHNESS: the
  //    served bundle must contain the current app marker. A stale bundle
  //    here is the phone-running-old-code class (cache or degraded server).
  if (!skip.has("metro") && opts.metroPort) {
    const mHost = opts.metroHost ?? "127.0.0.1";
    const metroUp = await tcpReachable(mHost, opts.metroPort);
    out.push({
      check: "metro dev server",
      state: metroUp ? "PASS" : "FAIL",
      detail: metroUp ? `${mHost}:${opts.metroPort} accepting connections` : `${mHost}:${opts.metroPort} NOT reachable — Expo Go cannot load`,
    });
    if (metroUp) {
      // NOTE the .bundle suffix — metro 404s the bare entry path (that false
      // FAIL is why this check existed for ten minutes before failing).
      const bundle = sh("curl", ["-s", "--max-time", "45", `http://${mHost}:${opts.metroPort}/index.ts.bundle?platform=ios&dev=true&minify=false`], 50_000);
      if (bundle === null) {
        out.push({ check: "bundle freshness", state: "SKIP", detail: "curl unavailable or bundle fetch timed out" });
      } else if (bundle.startsWith("<!DOCTYPE") || bundle.startsWith("<html")) {
        out.push({ check: "bundle freshness", state: "FAIL", detail: "dev server returned HTML, not a bundle — entry route or metro config wrong" });
      } else if (bundle.includes(BUNDLE_MARKER)) {
        out.push({ check: "bundle freshness", state: "PASS", detail: `served bundle contains the current app marker (${BUNDLE_MARKER})` });
      } else {
        out.push({
          check: "bundle freshness",
          state: "FAIL",
          detail: `served bundle is STALE (no "${BUNDLE_MARKER}") — phone would load old code; restart the dev server with a cache clear`,
        });
      }
    }
  }

  // 5. metro CI-mode — the two-hour killer: CI mode disables watch mode AND
  //    degrades dev-server responses, and metro only ever ANNOUNCES it in
  //    the journal ("Metro is running in CI mode, reloads are disabled")
  if (!skip.has("journal")) {
    const j = sh("journalctl", ["--user", "-u", "clankerchat-metro", "--since", "-6h", "--no-pager"]);
    if (j === null) {
      out.push({ check: "metro watch mode", state: "SKIP", detail: "journalctl unavailable (non-systemd host)" });
    } else {
      // Only the CURRENT process's announcements count: slice after the last
      // service start so a pre-fix CI-mode process doesn't linger as a FAIL
      // for six hours after the restart that fixed it (this exact false
      // positive fired on the doctor's very first live run).
      const lastStart = j.lastIndexOf("Started clankerchat");
      const current = lastStart >= 0 ? j.slice(lastStart) : j;
      if (/Metro is running in CI mode/.test(current)) {
        out.push({
          check: "metro watch mode",
          state: "FAIL",
          detail: 'current process announced "Metro is running in CI mode" — reloads disabled + degraded responses; remove CI=1 from the service and restart',
        });
      } else {
        out.push({ check: "metro watch mode", state: "PASS", detail: "current metro process is not in CI mode" });
      }
    }
  }

  // 6. firewall — the ports the phone needs from the LAN
  if (!skip.has("ufw") && opts.fwPorts?.length) {
    const ufw = sh("ufw", ["status"]);
    if (ufw === null) {
      out.push({ check: "firewall (ufw)", state: "SKIP", detail: "ufw unavailable (Windows peer / no ufw)" });
    } else {
      const missing = opts.fwPorts.filter((p) => !new RegExp(`\\b${p}\\b`).test(ufw));
      out.push({
        check: "firewall (ufw)",
        state: missing.length === 0 ? "PASS" : "FAIL",
        detail: missing.length === 0 ? `rules present for ${opts.fwPorts.join(", ")}` : `no rule for ${missing.join(", ")} — phone cannot reach it from the LAN`,
      });
    }
  }

  return out;
}
