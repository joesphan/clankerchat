// companion-qr — renders the two QRs Joe's phone needs onto one local page.
// Nothing leaves the machine: PNGs are generated here and the page opens on
// the local display (enrollment binds to physical presence by design).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import qrcode from "qrcode";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAN = "192.168.0.12";
const COMPANION_PORT = 47423;

const { defaultCompanionStore, issueEnrollToken } = await import(pathToFileURL(path.join(ROOT, "dist/companion.js")).href);
const { fingerprintOfPublicKey } = await import(pathToFileURL(path.join(ROOT, "dist/botlink.js")).href);

const store = defaultCompanionStore(path.join(ROOT, "botlink-keys"));
const { token, expiresAt } = issueEnrollToken(store);
const hostPub = fs.readFileSync(path.join(ROOT, "botlink-keys/host_key.pub"), "utf8");
const fp = fingerprintOfPublicKey(hostPub);
const payload = { v: 1, kind: "clanker-companion-enroll", host: LAN, port: COMPANION_PORT, fp, tkn: token };

const expUrl = `exp://${LAN}:8082`;
const outDir = path.join(ROOT, "botlink-keys");
await qrcode.toFile(path.join(outDir, "qr-exp.png"), expUrl, { width: 420, margin: 2 });
await qrcode.toFile(path.join(outDir, "qr-enroll.png"), JSON.stringify(payload), { width: 420, margin: 2 });

const html = `<!doctype html><meta charset=utf-8><title>companion QRs</title>
<style>body{font:15px/1.5 system-ui;background:#111;color:#eee;display:flex;gap:3rem;justify-content:center;padding:2rem}div{text-align:center}img{background:#fff;padding:8px;border-radius:8px}code{color:#7fd}</style>
<div><h2>1 — open the app</h2><img src="qr-exp.png"><p>phone <b>camera</b> → scan → opens Expo Go with the app</p><code>${expUrl}</code></div>
<div><h2>2 — enroll the phone</h2><img src="qr-enroll.png"><p>inside the app → connect → scan this (one-time, expires ${new Date(expiresAt).toLocaleTimeString()})</p><code>machine fp: ${fp}</code></div>`;
fs.writeFileSync(path.join(ROOT, "botlink-keys", "companion-qr.html"), html);
console.log("page ready:", path.join(ROOT, "botlink-keys", "companion-qr.html"));
