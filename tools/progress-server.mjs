// progress-server.mjs — one-file status page for joesp-desktop (no deps).
// Serves lane + mesh + daemon state at http://100.64.0.4:8788/ (mesh-only bind).
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInjectLog, deriveInjectMetrics } from "../dist/botlink.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPOOL = path.join(ROOT, "botlink-spool");
const TS = "C:\\Program Files\\Tailscale\\tailscale.exe";
const run = promisify(execFile);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function snapshot() {
  const parts = [];
  let ts = "unavailable";
  try { ts = (await run(TS, ["status"])).stdout.trim(); } catch (e) { ts = "tailscale status failed: " + e.message; }
  parts.push(["Mesh (tailscale)", ts]);
  try {
    const entries = verifyInjectLog(SPOOL);
    const m = deriveInjectMetrics(entries);
    parts.push(["Lane report", [
      `injects=${m.injects}  median received→consumed=${m.medianReceivedToConsumedMs ?? "-"}ms`,
      `by source: ${JSON.stringify(m.bySource)}  by target: ${JSON.stringify(m.byTarget)}`,
      `completed=${m.completed.length}  rework rounds=${m.reworkRounds}  (chain verified)`,
    ].join("\n")]);
  } catch (e) {
    parts.push(["Lane report", e.message.includes("ENOENT") ? "no inject.log yet — lane idle" : "chain verify FAILED: " + e.message]);
  }
  try {
    const log = fs.readFileSync(path.join(ROOT, "daemon.log"), "utf8").split(/\r?\n/).filter(Boolean).slice(-15);
    parts.push(["daemon.log tail", log.join("\n")]);
  } catch { /* no log */ }
  return parts;
}

const server = http.createServer(async (_req, res) => {
  const parts = await snapshot();
  const body = `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=10><title>joesp-desktop</title>
<style>body{font:13px/1.45 Consolas,monospace;background:#111;color:#ddd;margin:2rem}h2{color:#7fd;margin:1.4rem 0 .4rem}pre{background:#181818;border:1px solid #333;padding:.7rem;white-space:pre-wrap}</style>
<h1>joesp-desktop — lane &amp; mesh status</h1><i>auto-refresh 10s</i>
${parts.map(([t, c]) => `<h2>${esc(t)}</h2><pre>${esc(c)}</pre>`).join("")}`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
server.listen(8788, "100.64.0.4", () => console.log("progress page: http://100.64.0.4:8788/"));
