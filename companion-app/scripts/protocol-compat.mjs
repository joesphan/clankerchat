/**
 * protocol-compat — proves the APP's byte-math matches the SERVER's.
 *
 * This script re-implements App.tsx's client construction EXACTLY (manual
 * UTF-8, manual base64, 4-byte-BE lenDelim, OpenSSH ed25519 line format,
 * SHA256 fingerprint of the wire blob, noble sign → base64) and runs it
 * against the REAL built server (../dist/companion.js): enroll → signed
 * GET /attempts → signed allow. If any byte of the construction diverged,
 * verification fails here — not on someone's phone.
 *
 * Run after `npm run build` in the repo root:  node scripts/protocol-compat.mjs
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ed25519 from "@noble/ed25519";

// noble v3 ships without a hash backend — inject Node's sha512 (sync slot,
// because the sync sign()/getPublicKey() read the sync provider).
ed25519.hashes.sha512 = (msg) => new Uint8Array(crypto.createHash("sha512").update(msg).digest());

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { generateBotKey, fingerprintOfPublicKey } = await import(path.join(REPO, "dist/botlink.js"));
const {
  defaultCompanionStore,
  issueEnrollToken,
  startCompanionServer,
} = await import(path.join(REPO, "dist/companion.js"));
const {
  attemptIdOfState,
  commitOf,
  freshNonce,
  keydirPaths,
  sasOfState,
  savePairingState,
} = await import(path.join(REPO, "dist/pairing.js"));

// ---- App.tsx's helpers, transcribed verbatim (no Node niceties) ----
const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64C[b0 >> 2] + B64C[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64C[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64C[b2 & 63] : "=";
  }
  return out;
}
function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
function lenDelim(...parts) {
  const chunks = [];
  let total = 0;
  for (const p of parts) {
    const b = utf8(p);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length);
    chunks.push(len, b);
    total += 4 + b.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
function sshEd25519Line(pub) {
  const name = utf8("ssh-ed25519");
  const blob = new Uint8Array(4 + name.length + 4 + 32);
  new DataView(blob.buffer).setUint32(0, name.length);
  blob.set(name, 4);
  new DataView(blob.buffer).setUint32(4 + name.length, 32);
  blob.set(pub, 8 + name.length);
  return `ssh-ed25519 ${bytesToB64(blob)} clankerchat-phone`;
}
const sha256hex = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// ---- scenario ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compat-"));
const keydir = path.join(dir, "keys");
const p = keydirPaths(keydir);
fs.mkdirSync(keydir, { recursive: true });
const host = generateBotKey("m host");
const bot = generateBotKey("m bot");
fs.writeFileSync(p.hostKey + ".pub", host.publicLine + "\n");
fs.writeFileSync(p.botKey + ".pub", bot.publicLine + "\n");
const peerBot = generateBotKey("p bot");
const peerHost = generateBotKey("p host");
const peerNonce = freshNonce();
const state = {
  v: 1,
  mode: "first",
  status: "exchanged",
  armedAt: Date.now(),
  role: "initiator",
  self: { name: "m", hostkeyFp: fingerprintOfPublicKey(host.publicLine), botPub: bot.publicLine },
  nonce: freshNonce(),
  peer: {
    name: "p",
    hostkeyFp: fingerprintOfPublicKey(peerHost.publicLine),
    botPub: peerBot.publicLine,
    commit: commitOf(peerNonce),
    nonce: peerNonce,
  },
};
savePairingState(p, state);

const store = defaultCompanionStore(keydir);
const spool = path.join(dir, "spool");
const listener = startCompanionServer({
  bind: "127.0.0.1",
  port: 0,
  paths: p,
  spoolDir: spool,
  store,
  log: () => {},
});
await new Promise((r) => setTimeout(r, 50));
const base = `http://127.0.0.1:${listener.port}`;

// phone: noble seed → keypair → OpenSSH line → fingerprint (app's math)
const seed = crypto.randomBytes(32);
const pub = await ed25519.getPublicKey(seed);
const line = sshEd25519Line(pub);
const appFp = "SHA256:" + crypto.createHash("sha256").update(Buffer.from(line.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "");
const serverFp = fingerprintOfPublicKey(line);
if (appFp !== serverFp) throw new Error(`fingerprint mismatch: app ${appFp} vs server ${serverFp}`);
console.log("fingerprint formulas agree:", appFp);

const { token } = issueEnrollToken(store);
let res = await fetch(base + "/enroll", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, phonePub: line }),
});
if (res.status !== 200) throw new Error(`enroll failed: ${res.status}`);
console.log("enrolled; server id === app fingerprint:", (await res.json()).id === appFp);

let counter = 0;
const signed = async (method, urlPath, bodyObj) => {
  counter += 1;
  const body = method === "GET" ? new Uint8Array(0) : utf8(JSON.stringify(bodyObj ?? {}));
  const msg = lenDelim("clanker-companion-v1", method, urlPath, sha256hex(body), String(counter));
  const sig = await ed25519.sign(msg, seed);
  const headers = { "x-companion-id": appFp, "x-counter": String(counter), "x-sig": bytesToB64(sig) };
  if (method !== "GET") headers["content-type"] = "application/json";
  return fetch(base + urlPath, { method, headers, body: method === "GET" ? undefined : body });
};

res = await signed("GET", "/attempts");
const view = await res.json();
if (res.status !== 200 || view.sas !== sasOfState(state) || view.attemptId !== attemptIdOfState(state)) {
  throw new Error(`attempts mismatch: ${JSON.stringify(view)}`);
}
console.log("signed GET verified (noble sign ↔ ssh2 verify):", view.sas);

res = await signed("POST", `/attempts/${view.attemptId}/allow`, { sas: view.sas.replace("-", "").toLowerCase() });
const out = await res.json();
if (res.status !== 200) throw new Error(`allow failed: ${JSON.stringify(out)}`);
const pinned = fs.readFileSync(p.authorizedKeys, "utf8");
if (!pinned.includes(peerBot.publicLine.trim())) throw new Error("peer line not pinned");
if (fs.existsSync(p.state)) throw new Error("state not cleared");
const audit = fs.readFileSync(path.join(spool, "inject.log"), "utf8");
if (!audit.includes(`via=companion:${appFp}`)) throw new Error("audit missing phone");
listener.close();
console.log("allow committed via the app's exact byte path — pins, audit, single-use all good.");
