/**
 * clankerchat companion — allow/deny botlink pairing confirmations from
 * the owner's phone (docs/companion-app.md).
 *
 * What this app is allowed to be:
 *   - a DISPLAY for this machine's live pairing attempt (SAS, fingerprints),
 *   - a gesture surface: ALLOW (typed-SAS transcription check, identical to
 *     the terminal confirm) or DENY,
 *   - the holder of exactly one secret: its own per-machine Ed25519 keypair,
 *     generated ON the phone at enrollment; the machine pins only the public
 *     line. No machine keys ever live here; revocation is deleting the pin.
 *
 * What it must never do (by design, not by omission):
 *   - transmit the SAS anywhere — no copy, no share sheet, no notifications
 *     of pairing state (the agents-never-relay-SAS law extends to apps;
 *     selectable={false}). Local notifications for PROMPT OUTCOMES are a
 *     separate owner-green-lit surface (2026-10-04) and carry answer text
 *     only — never pairing/SAS material.
 *   - arm pairings, touch the lane, or read anything but pairing state.
 *
 * Protocol (must byte-match src/companion.ts):
 *   signed message = lenDelim("clanker-companion-v1", METHOD, path,
 *                             sha256hex(body), decimal-counter)
 *   headers: x-companion-id (fingerprint of the phone key), x-counter, x-sig
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Battery from "expo-battery";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import * as ScreenCapture from "expo-screen-capture";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import * as ed25519 from "@noble/ed25519";
import { StatusBar } from "expo-status-bar";

// ---------------------------------------------------------------------------
// Byte helpers — Hermes has no TextEncoder/btoa guarantees, so everything
// protocol-visible is implemented locally and byte-exact. `Bytes` pins the
// TS 5.7+ ArrayBuffer-backed flavor that noble/expo/fetch all demand.
// ---------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

/** Proper UTF-8 (handles multi-byte even though protocol strings are ASCII). */
function utf8(s: string): Bytes {
  const out: number[] = [];
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

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Bytes {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// noble v3 ships without a hash backend — feed it expo-crypto's SHA-512 via
// the ASYNC provider slots (expo-crypto's byte digest returns an ArrayBuffer
// and has no sync variant), and use the Async sign/keygen paths everywhere.
ed25519.hashes.sha512Async = async (msg: Uint8Array): Promise<Bytes> =>
  // noble's abytes() guarantees an ArrayBuffer-backed view at runtime; the
  // cast only reconciles its loose param type with expo's BufferSource.
  new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA512, msg as Bytes));

/** 4-byte big-endian length prefix per part — mirrors pairing.ts lenDelim. */
function lenDelim(...parts: string[]): Bytes {
  const chunks: Uint8Array[] = [];
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

async function sha256hex(bytes: Bytes): Promise<string> {
  return bytesToHex(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)));
}

/** OpenSSH wire format for an ed25519 public key → the public LINE. */
function sshEd25519Line(pub: Uint8Array): string {
  const name = utf8("ssh-ed25519");
  const blob = new Uint8Array(4 + name.length + 4 + 32);
  new DataView(blob.buffer).setUint32(0, name.length);
  blob.set(name, 4);
  new DataView(blob.buffer).setUint32(4 + name.length, 32);
  blob.set(pub, 8 + name.length);
  return `ssh-ed25519 ${bytesToB64(blob)} clankerchat-phone`;
}

/** Same fingerprint formula the machine uses (ssh2 fingerprintOfPublicKey):
 *  unpadded base64 of the sha256 over the DECODED public-key blob. */
async function fingerprintOfLine(line: string): Promise<string> {
  const b64 = line.split(" ")[1];
  const bin = atobLike(b64);
  return "SHA256:" + bytesToB64(hexToBytes(await sha256hex(bin))).replace(/=+$/, "");
}

/** Base64-decode without atob (Hermes). */
function atobLike(b64: string): Bytes {
  const clean = b64.replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let val = 0;
  for (const ch of clean) {
    val = (val << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Identity + storage
// ---------------------------------------------------------------------------

interface Machine {
  id: string; // phone-key fingerprint == X-Companion-Id
  host: string;
  port: number;
  fp: string; // MACHINE hostkey fingerprint (enrollment eyeball check)
  addedAt: number;
}

interface AttemptView {
  attemptId: string;
  mode: string;
  peer: { name: string; hostkeyFp: string; botPub: string } | null;
  sas: string;
  expiresAt: number;
}

/** A pending ask (GET /asks) — approve/deny gates from the pocket. */
interface AskView {
  askId: string;
  question: string;
  createdAt: number;
  expiresAt: number;
  lazy: boolean;
}

/** A phone-originated prompt (GET /prompts, round 5 + 5.1) — the lifecycle
 *  pending → enqueued → answered/failed plus, when answered, a short excerpt
 *  of the run's post so the pocket view closes without leaving the app
 *  (Discord stays the record — the excerpt is a preview, rendered as data). */
interface PromptView {
  promptId: string;
  text: string;
  status: "pending" | "enqueued" | "answered" | "failed" | "expired";
  /** "peer" = routed (phase 1): the peer machine ran it, the preview echoed
   *  back over the lane. null/absent = local run (the pre-phase-1 shape). */
  route?: "peer" | null;
  createdAt: number;
  finishedAt: number | null;
  answerExcerpt: string | null;
}

/** A machine→phone report (GET /notices, round 8): free-text FROM the
 *  machine — round summaries, route verdicts — authored by local processes,
 *  never by this surface. Display data only, never instructions. */
interface NoticeView {
  id: string;
  ts: number;
  from: string;
  text: string;
  severity: "info" | "warn";
  acked: boolean;
}

/** The machine's published health (GET /machine, round 6) — pool, queues,
 *  the botlink lane verdict from the watcher's heartbeat, idle time. Facts
 *  rendered as data; a stopped watcher shows stale: true honestly. */
interface MachineView {
  active: number;
  queuedHuman: number;
  queuedBot: number;
  maxConcurrent: number;
  laneOk: boolean | null;
  lanePeer: string | null;
  lanePending: number;
  /** The PEER machine's last-run time (their watcher's state, relayed by our
   *  lane heartbeat) — cross-machine visibility, phase 0 of the multi-machine
   *  prompts design. Null when the lane is down or they never ran. */
  lanePeerLastRunAt: string | null;
  lastRunAt: string | null;
  updated: string | null;
  stale: boolean;
  /** Median received→consumed for injects this machine handled, from the
   *  audit log (chain-verified server-side). Null = no paired events. */
  laneHealthMs: number | null;
  lanePaired: number;
  /** Doctor-subset FAIL lines (delivery health) — rendered in red. */
  alerts: string[];
}

const K_SEED = "cc.seed";
const K_MACHINES = "cc.machines";
const K_COUNTERS = "cc.counters";

async function loadJson<T>(key: string): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(key);
  return raw ? (JSON.parse(raw) as T) : null;
}
async function saveJson(key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Signed transport (mirrors src/companion.ts verifyCompanionRequest)
// ---------------------------------------------------------------------------

// Counter burn is SERIALIZED (audit fix 4): signedFetch is async, so two
// overlapping calls — the 2s poll tick colliding with an Approve tap, or a
// double-tap — could both read counter N from SecureStore, both persist N+1,
// and both SIGN N+1; the server correctly refuses the second as a replay
// (spurious 403 on a legitimate action). A module-level promise chain makes
// the read-modify-write section single-filed; the signing/request itself
// stays concurrent.
let counterChain: Promise<void> = Promise.resolve();

async function signedFetch(
  machine: Machine,
  seed: Uint8Array,
  phoneId: string,
  method: "GET" | "POST",
  path: string,
  bodyObj?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let counter = 0;
  const gate = counterChain.then(async () => {
    const counters = (await loadJson<Record<string, number>>(K_COUNTERS)) ?? {};
    counter = (counters[machine.id] ?? 0) + 1;
    counters[machine.id] = counter;
    await saveJson(K_COUNTERS, counters); // burn optimistically: gaps are fine, repeats never
  });
  counterChain = gate.catch(() => {}); // storage failure must not poison later calls
  await gate;

  const body: Bytes = method === "GET" ? new Uint8Array(0) : utf8(JSON.stringify(bodyObj ?? {}));
  // The server signs the PATHNAME only — a query string (GET /prompts?q=…)
  // must never enter the signed message.
  const msg = lenDelim(
    "clanker-companion-v1",
    method,
    path.split("?")[0],
    await sha256hex(body),
    String(counter),
  );
  const sig = await ed25519.signAsync(msg, seed);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`http://${machine.host}:${machine.port}${path}`, {
      method,
      headers: {
        "x-companion-id": phoneId,
        "x-counter": String(counter),
        "x-sig": bytesToB64(sig),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "GET" ? undefined : body,
      signal: ctrl.signal,
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON (413 close etc.) — status still reported */
    }
    return { status: res.status, json: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Presence gate (biometric — TODO round 2026-10-04)
// ---------------------------------------------------------------------------
// The enrolled key is the trust ROOT (possession); biometrics add PRESENCE
// on top for owner-commit actions (rotation Allow, ask Approve/Deny).
// Deliberate fail-open shape, decided explicitly in docs/TODO.md: no
// hardware / nothing enrolled / API error → the action proceeds — the key
// still authenticates, and a device with no biometrics enrolled must not
// lose its only confirmation surface. The one hard refusal is a real prompt
// the user FAILED or CANCELED (success:false): that is the owner declining
// to be present, so nothing is sent. Rotation-Deny stays ungated on
// purpose — rejecting a pairing must stay friction-free even mid-attack.
// SDK note: FaceID on iOS needs a development build (Expo Go limitation);
// there the API errors and we degrade to key-possession.
async function requirePresence(reason: string): Promise<boolean> {
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) return true;
    if (!(await LocalAuthentication.isEnrolledAsync())) return true;
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: "Cancel",
    });
    return Boolean(res.success);
  } catch {
    return true; // best-effort presence — the key remains the trust root
  }
}

// ---------------------------------------------------------------------------
// Local notifications (owner green-lit 2026-10-04) — prompt outcomes only
// ---------------------------------------------------------------------------
// Fired ONLY on a poll-observed transition into answered/failed: the first
// poll after the app opens SEEDS the status map without notifying, so an
// answer that landed while the app was closed never spams a stale banner on
// reopen. NO PUSH anywhere (push was rejected for pairing; this stays local):
// the app process must be alive — foreground, or Android's brief
// post-background window — for a notification to fire; iOS suspension
// honestly means silence until the app is reopened. Banner text is the
// answer excerpt / prompt text (display data, same as the SENT card).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Haptics (owner's "use the expo features" directive): the FEEL layer for
// the moments this surface exists for — an ask arriving (warning pattern),
// an answer landing (success/error), a notice landing (light), a decision
// committing (medium tap). Always fire-and-forget: a device without a
// taptic engine (simulator, desktop web preview) no-ops and the flow moves
// on — feedback must never gate the action it decorates.
function haptic(pattern: "light" | "medium" | "warning" | "success" | "error"): void {
  const fire =
    pattern === "light" || pattern === "medium"
      ? Haptics.impactAsync(
          pattern === "light" ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium,
        )
      : Haptics.notificationAsync(
          pattern === "warning"
            ? Haptics.NotificationFeedbackType.Warning
            : pattern === "success"
              ? Haptics.NotificationFeedbackType.Success
              : Haptics.NotificationFeedbackType.Error,
        );
  void fire.catch(() => {});
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export default function App() {
  const [seed, setSeed] = useState<Bytes | null>(null);
  const [phoneId, setPhoneId] = useState<string>("");
  const [pubLine, setPubLine] = useState<string>("");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [active, setActive] = useState<Machine | null>(null);
  const [scanning, setScanning] = useState(false);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [asks, setAsks] = useState<AskView[]>([]);
  const [prompts, setPrompts] = useState<PromptView[]>([]);
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [notices, setNotices] = useState<NoticeView[]>([]);
  const [unacked, setUnacked] = useState(0);
  // Notices window width (round 9): the poll fetches the newest 10 by
  // default; "Show older notices" widens to the whole 50-record registry.
  // Kept in a ref so flipping it re-renders the toggle WITHOUT re-arming the
  // poll effect — the next 2s tick simply fetches the wider window.
  const [noticesLimit, setNoticesLimit] = useState(10);
  const noticesLimitRef = useRef(10);
  const [promptText, setPromptText] = useState("");
  // Route toggle (multi-machine phase 1): false = this machine runs it (the
  // only behavior before phase 1); true = route:"peer" — the peer machine
  // runs it, the outcome echoes back over the lane, and this surface
  // previews the excerpt like a local answer.
  const [routePeer, setRoutePeer] = useState(false);
  const [sasInput, setSasInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<PromptView[] | null>(null);
  // History navigation (round 7): the SENT card ships the newest 20 from the
  // server; "Load older" walks backward by createdAt cursor. `history` holds
  // ONLY rows older than the live window (deduped against it at render).
  const [history, setHistory] = useState<PromptView[]>([]);
  const [sentMore, setSentMore] = useState(false);
  // Expanded SENT/search rows (tap to read the full text + excerpt + stamps).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [perm, requestPerm] = useCameraPermissions();
  const appState = useRef(AppState.currentState);
  // PromptId → last status SEEN by this app session (notification transitions).
  const seenPromptStatus = useRef<Map<string, string>>(new Map());
  // machine:askId keys for ask-arrival banners — one banner per ask per app
  // session, surviving machine switches (a flip must not re-spam old asks).
  const seenAsks = useRef<Set<string>>(new Set());
  // Same shape for notices (round 8): an UNACKED notice banners once per app
  // session — unacked means Tyler never saw it, so a reopen re-banner is
  // correct, a flip within the session is not.
  const seenNotices = useRef<Set<string>>(new Set());
  // The pocket's own health (S-tier #3): the phone IS the approval surface,
  // so its battery belongs beside the machine's health on the machine card.
  const [battery, setBattery] = useState<{ level: number; charging: boolean } | null>(null);

  const deriveIdentity = useCallback(async (theSeed: Uint8Array) => {
    const pub = await ed25519.getPublicKeyAsync(theSeed);
    const line = sshEd25519Line(pub);
    setPubLine(line);
    setPhoneId(await fingerprintOfLine(line));
  }, []);

  useEffect(() => {
    void (async () => {
      const storedSeed = await loadJson<string>(K_SEED);
      if (storedSeed) {
        const s = hexToBytes(storedSeed);
        setSeed(s);
        await deriveIdentity(s);
      }
      setMachines(((await loadJson<Machine[]>(K_MACHINES)) ?? []).slice());
    })();
  }, [deriveIdentity]);

  const createIdentity = useCallback(async () => {
    const s = Crypto.getRandomBytes(32) as Bytes;
    await saveJson(K_SEED, bytesToHex(s));
    setSeed(s);
    await deriveIdentity(s);
  }, [deriveIdentity]);

  // Poll the active machine's attempts while the app is foregrounded.
  useEffect(() => {
    if (!active || !seed || !phoneId) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || AppState.currentState !== "active") return;
      try {
        const { status, json } = await signedFetch(active, seed, phoneId, "GET", "/attempts");
        if (stopped) return;
        if (status === 200) {
          setAttempt(Object.keys(json).length ? (json as unknown as AttemptView) : null);
          setError("");
        } else {
          setError(String(json.error ?? `HTTP ${status}`));
        }
        const askRes = await signedFetch(active, seed, phoneId, "GET", "/asks");
        if (!stopped && askRes.status === 200) {
          setAsks(Array.isArray(askRes.json.asks) ? (askRes.json.asks as unknown as AskView[]) : []);
        }
        const promptRes = await signedFetch(active, seed, phoneId, "GET", "/prompts");
        if (!stopped && promptRes.status === 200) {
          setPrompts(Array.isArray(promptRes.json.prompts) ? (promptRes.json.prompts as unknown as PromptView[]) : []);
          setSentMore(promptRes.json.more === true);
        }
        const machineRes = await signedFetch(active, seed, phoneId, "GET", "/machine");
        if (!stopped && machineRes.status === 200 && machineRes.json?.machine) {
          setMachine(machineRes.json.machine as unknown as MachineView);
        }
        const noticeRes = await signedFetch(
          active,
          seed,
          phoneId,
          "GET",
          noticesLimitRef.current > 10 ? `/notices?limit=${noticesLimitRef.current}` : "/notices",
        );
        if (!stopped && noticeRes.status === 200) {
          setNotices(Array.isArray(noticeRes.json.notices) ? (noticeRes.json.notices as unknown as NoticeView[]) : []);
          setUnacked(Number(noticeRes.json.unacked ?? 0));
        }
      } catch (e) {
        if (!stopped) setError(`unreachable: ${(e as Error).message}`);
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 2000);
    const sub = AppState.addEventListener("change", (s) => {
      appState.current = s;
      if (s === "active") void tick();
    });
    return () => {
      stopped = true;
      clearInterval(iv);
      sub.remove();
    };
  }, [active, seed, phoneId]);

  // Screenshot prevention (S-tier #2, owner 2026-10-04 "use the expo features
  // to the best of your abilities"): FLAG_SECURE on Android blocks screenshots
  // AND app-switcher previews for the whole app — it only ever displays
  // pairing/approval material, so always-on is the correct posture. iOS cannot
  // prevent captures (detect only): the listener WARNS that a capture landed,
  // because a photo-library copy of an on-screen SAS is exactly the leak class
  // the never-transmit-SAS law exists to prevent.
  useEffect(() => {
    let on = true;
    void ScreenCapture.preventScreenCaptureAsync().catch(() => {
      /* Expo Go / platform without the surface — detection still armed */
    });
    const sub = ScreenCapture.addScreenshotListener(() => {
      if (on) {
        setError("screenshot captured — if an SAS was on screen it is now in your photo library; deny and re-pair if this wasn't you");
      }
    });
    return () => {
      on = false;
      sub.remove();
      void ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, []);

  // Phone battery (S-tier #3): level + charging state, refreshed by listener
  // events. Rendered on the machine card; <20% while unplugged escalates to a
  // warning — a dead approval surface silently strands asks.
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const level = await Battery.getBatteryLevelAsync();
        const state = await Battery.getBatteryStateAsync();
        if (on) {
          setBattery({
            level,
            charging: state === Battery.BatteryState.CHARGING,
          });
        }
      } catch {
        /* simulator / no battery surface — card just omits the line */
      }
    })();
    const lvl = Battery.addBatteryLevelListener((e) => {
      if (on) setBattery((prev) => ({ level: e.batteryLevel, charging: prev?.charging ?? false }));
    });
    const st = Battery.addBatteryStateListener((e) => {
      if (on) {
        const charging = e.batteryState === Battery.BatteryState.CHARGING;
        setBattery((prev) => ({ level: prev?.level ?? 0, charging }));
      }
    });
    return () => {
      on = false;
      lvl.remove();
      st.remove();
    };
  }, []);

  // Ask-arrival banners (same green-lit display-data class as prompt-outcome
  // banners, 2026-10-04): a pending ask that goes unseen expires silently.
  // Banner ONCE per ask per app session, question text only — never pairing or
  // SAS material. Keyed machine:askId so switching machines neither re-spams
  // nor cross-fires.
  useEffect(() => {
    if (!active) return;
    for (const a of asks) {
      const key = `${active.id}:${a.askId}`;
      if (seenAsks.current.has(key)) continue;
      seenAsks.current.add(key);
      haptic("warning");
      void Notifications.scheduleNotificationAsync({
        content: {
          title: "Ask needs your decision",
          body: String(a.question).slice(0, 140),
        },
        trigger: null, // local, immediate
      }).catch((e) => setError(`notification failed: ${(e as Error).message}`));
    }
  }, [asks, active]);

  // Notice-arrival banners (round 8): same display-data class as ask banners.
  // One banner per notice per app session, unacked only — unacked means the
  // owner never saw it (acks come from THIS phone), so a reopen re-banners.
  useEffect(() => {
    if (!active) return;
    for (const n of notices) {
      if (n.acked) continue;
      const key = `${active.id}:${n.id}`;
      if (seenNotices.current.has(key)) continue;
      seenNotices.current.add(key);
      haptic(n.severity === "warn" ? "warning" : "light");
      void Notifications.scheduleNotificationAsync({
        content: {
          title: n.severity === "warn" ? `⚠ machine notice (${n.from})` : `machine notice (${n.from})`,
          body: String(n.text).slice(0, 140),
        },
        trigger: null, // local, immediate
      }).catch((e) => setError(`notification failed: ${(e as Error).message}`));
    }
  }, [notices, active]);

  // Notification permission: ask once on mount. A denial is SURFACED (quiet
  // notice line) rather than swallowed — "no banner" with no reason is
  // undebuggable from the phone; "notifications denied" is actionable.
  useEffect(() => {
    void (async () => {
      try {
        const p = await Notifications.requestPermissionsAsync();
        if (!p.granted) setNotice("notifications not permitted — banners won't show (check OS settings)");
      } catch {
        /* no notification surface (desktop web preview) — fine */
      }
    })();
  }, []);

  // Answer notifications: fire when a KNOWN non-terminal prompt flips to
  // answered/failed between two polls. First sight of an id only seeds the
  // map (no banner) — stale answers from before the app opened stay quiet.
  useEffect(() => {
    for (const p of prompts) {
      const before = seenPromptStatus.current.get(p.promptId);
      if (
        before !== undefined &&
        before !== p.status &&
        (p.status === "answered" || p.status === "failed")
      ) {
        haptic(p.status === "answered" ? "success" : "error");
        void Notifications.scheduleNotificationAsync({
          content: {
            title: p.status === "answered" ? "Prompt answered" : "Prompt failed",
            body: String(p.answerExcerpt ?? p.text ?? "").slice(0, 140),
          },
          trigger: null, // local, immediate
          // surfaced, not swallowed: a silent catch here means "no banner"
          // with zero signal, which cost us a debugging round once already
        }).catch((e) => setError(`notification failed: ${(e as Error).message}`));
      }
      seenPromptStatus.current.set(p.promptId, p.status);
    }
  }, [prompts]);

  const onScanned = useCallback(
    async (data: string) => {
      setScanning(false);
      if (!seed || !phoneId) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const payload = JSON.parse(data) as {
          v?: number; kind?: string; host?: string; port?: number; fp?: string; tkn?: string;
        };
        if (payload.kind !== "clanker-companion-enroll" || payload.v !== 1 || !payload.host || !payload.port) {
          throw new Error("not a clankerchat enrollment QR");
        }
        // Eyeball gate: the human must confirm the machine fingerprint shown
        // in the QR matches the machine's terminal (printed by --enroll).
        // Here we simply carry it into the stored record + render it.
        // AbortController (audit fix 6): a scanned host that's a black hole
        // (wrong network, machine gone) hung this fetch forever — busy stayed
        // true and the enroll screen was bricked until app restart.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        let res: Response;
        try {
          res = await fetch(`http://${payload.host}:${payload.port}/enroll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: payload.tkn, phonePub: pubLine }),
            signal: ctrl.signal,
          });
        } catch (e) {
          throw new Error(`enroll unreachable: ${(e as Error).message} — check you're on the same network`);
        } finally {
          clearTimeout(timer);
        }
        const out = (await res.json()) as { id?: string; error?: string };
        if (res.status !== 200 || out.id !== phoneId) {
          throw new Error(String(out.error ?? `enroll failed (${res.status})`));
        }
        const machine: Machine = {
          id: out.id,
          host: payload.host,
          port: payload.port,
          fp: payload.fp ?? "(unknown)",
          addedAt: Date.now(),
        };
        const next = [...machines.filter((m) => m.id !== machine.id), machine];
        setMachines(next);
        await saveJson(K_MACHINES, next);
        setActive(machine);
        setNotice(`Enrolled ${machine.host} — verify its fingerprint on the machine's terminal.`);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [machines, phoneId, pubLine, seed],
  );

  const doAllow = useCallback(async () => {
    if (!active || !seed || !phoneId || !attempt) return;
    if (!(await requirePresence("Allow this key rotation"))) {
      setError("presence declined — nothing sent");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { status, json } = await signedFetch(
        active, seed, phoneId, "POST",
        `/attempts/${attempt.attemptId}/allow`,
        { sas: sasInput },
      );
      if (status === 200) {
        const changes = Array.isArray(json.changes) ? (json.changes as string[]).join(", ") : "nothing to change";
        setNotice(`Committed: ${changes}. Restart botlink services to load the new pins.`);
        setSasInput("");
        setAttempt(null);
      } else {
        setError(String(json.error ?? `HTTP ${status}`));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [active, attempt, phoneId, sasInput, seed]);

  const doDeny = useCallback(async () => {
    if (!active || !seed || !phoneId || !attempt) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { status, json } = await signedFetch(
        active, seed, phoneId, "POST",
        `/attempts/${attempt.attemptId}/deny`,
        {},
      );
      if (status === 200) {
        setNotice("Denied — nothing was written.");
        setAttempt(null);
      } else {
        setError(String(json.error ?? `HTTP ${status}`));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [active, attempt, phoneId, seed]);

  // Approve/deny a pending ask from the pocket — same signed transport, and
  // the machine's registry records provenance (companion:<phone fp>).
  const doSearch = useCallback(
    async () => {
      if (!active || !seed || !phoneId) return;
      const q = searchQ.trim();
      if (!q) {
        setSearchResults(null);
        return;
      }
      setBusy(true);
      setError("");
      try {
        const { status, json } = await signedFetch(
          active,
          seed,
          phoneId,
          "GET",
          `/prompts?q=${encodeURIComponent(q)}`,
        );
        if (status === 200) {
          setSearchResults(Array.isArray(json.prompts) ? (json.prompts as unknown as PromptView[]) : []);
        } else {
          setError(String(json.error ?? `HTTP ${status}`));
        }
      } catch (e) {
        setError(`unreachable: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [active, seed, phoneId, searchQ],
  );

  const doAskDecision = useCallback(
    async (askId: string, verb: "approve" | "deny") => {
      if (!active || !seed || !phoneId) return;
      if (!(await requirePresence(verb === "approve" ? "Approve this ask" : "Deny this ask"))) {
        setError("presence declined — nothing sent");
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const { status, json } = await signedFetch(active, seed, phoneId, "POST", `/asks/${askId}/${verb}`);
        if (status === 200) {
          haptic("medium");
          setNotice(`Ask ${String(json.status ?? verb)} — recorded`);
          setAsks((prev) => prev.filter((a) => a.askId !== askId));
        } else if (status === 409) {
          setNotice(`Ask already ${String(json.status ?? "decided")} — nothing changed`);
          setAsks((prev) => prev.filter((a) => a.askId !== askId));
        } else {
          setError(String(json.error ?? `HTTP ${status}`));
        }
      } catch (e) {
        setError(`unreachable: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [active, phoneId, seed],
  );

  // Dismiss notices (round 8): mark seen — the record stays for history,
  // dimmed; only the unread badge and banner eligibility go away. The server
  // is source of truth; the 2s poll repaints ack state, no local surgery.
  const doAckNotice = useCallback(
    async (id: string) => {
      if (!active || !seed || !phoneId) return;
      try {
        const { status, json } = await signedFetch(active, seed, phoneId, "POST", `/notices/${id}/ack`);
        if (status !== 200) setError(String(json.error ?? `HTTP ${status}`));
      } catch (e) {
        setError(`unreachable: ${(e as Error).message}`);
      }
    },
    [active, phoneId, seed],
  );

  const doAckAllNotices = useCallback(async () => {
    if (!active || !seed || !phoneId) return;
    try {
      const { status, json } = await signedFetch(active, seed, phoneId, "POST", "/notices/ack-all");
      if (status !== 200) setError(String(json.error ?? `HTTP ${status}`));
    } catch (e) {
      setError(`unreachable: ${(e as Error).message}`);
    }
  }, [active, phoneId, seed]);

  // Send an owner prompt to the active machine (round 5): the machine's
  // watcher sweep turns it into an owner-priority run whose answer posts in
  // Discord — this surface tracks the lifecycle, it is not the inbox.
  // routePeer (phase 1) asks the ACTIVE machine to forward the prompt to its
  // peer over the lane instead of running it locally; the peer's venue gets
  // the answer and this surface previews the echoed excerpt.
  const doSendPrompt = useCallback(async () => {
    if (!active || !seed || !phoneId) return;
    const text = promptText.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { status, json } = await signedFetch(active, seed, phoneId, "POST", "/prompt", {
        text,
        ...(routePeer ? { route: "peer" as const } : {}),
      });
      if (status === 200) {
        setNotice(
          routePeer
            ? "Sent to the peer machine — it runs there (30-min window) and the preview lands here."
            : "Sent — the machine picks it up within ~15s; the answer posts in Discord.",
        );
        setPromptText("");
        setRoutePeer(false); // deliberate per-send: casual asks stay local by default
      } else {
        setError(String(json.error ?? `HTTP ${status}`));
      }
    } catch (e) {
      setError(`unreachable: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [active, phoneId, promptText, routePeer, seed]);

  // Walk the history one page older (round 7). The cursor is the OLDEST
  // createdAt currently rendered; the server answers strictly-older records
  // plus `more` for the next button. History never re-polls — it is frozen
  // record, unlike the live window above it.
  const loadOlder = useCallback(async () => {
    if (!active || !seed || !phoneId) return;
    const rows = [...history, ...prompts];
    if (rows.length === 0) return;
    const oldest = Math.min(...rows.map((p) => p.createdAt));
    setBusy(true);
    setError("");
    try {
      const { status, json } = await signedFetch(
        active,
        seed,
        phoneId,
        "GET",
        `/prompts?before=${oldest}`,
      );
      if (status === 200) {
        const page = Array.isArray(json.prompts) ? (json.prompts as unknown as PromptView[]) : [];
        setHistory((prev) => {
          const seen = new Set(prev.map((p) => p.promptId));
          return [...prev, ...page.filter((p) => !seen.has(p.promptId))];
        });
        setSentMore(json.more === true);
      } else {
        setError(String(json.error ?? `HTTP ${status}`));
      }
    } catch (e) {
      setError(`unreachable: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [active, history, phoneId, prompts, seed]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // One prompt row: collapsed = 2-line preview (today's card), expanded =
  // full text, full excerpt, both stamps — the excerpt is capped server-side
  // already, so "expanded" is a layout change, not a data change.
  const renderPromptRow = (p: PromptView) => {
    const open = expanded.has(p.promptId);
    return (
      <Pressable key={p.promptId} style={s.promptRow} onPress={() => toggleExpanded(p.promptId)}>
        <Text style={s.muted} numberOfLines={open ? undefined : 2}>
          {p.text}
        </Text>
        <Text style={p.status === "failed" || p.status === "expired" ? s.err : s.ok}>
          {promptStatusLine(p)}
        </Text>
        {p.status === "answered" && p.answerExcerpt ? (
          <Text style={s.excerpt} numberOfLines={open ? undefined : 6}>
            {p.answerExcerpt}
          </Text>
        ) : null}
        {open ? (
          <Text style={s.stamp}>
            sent {new Date(p.createdAt).toLocaleString()}
            {p.finishedAt ? ` · ${p.status} ${new Date(p.finishedAt).toLocaleString()}` : ""}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  const promptStatusLine = (p: PromptView): string => {
    const where = p.route === "peer" ? "peer machine" : "this machine";
    switch (p.status) {
      case "pending":
        return `queued — waiting for the machine's sweep`;
      case "enqueued":
        return p.route === "peer"
          ? `routed — running on the peer (30-min window); preview lands here`
          : "running — answer posts in Discord when done";
      case "answered":
        return p.answerExcerpt
          ? `answered on ${where} — preview below; full answer in Discord`
          : `answered on ${where} — check Discord`;
      case "failed":
        return `run failed on ${where} — ask again or from Discord`;
      case "expired":
        return "never picked up — machine's delivery sweep was down";
    }
  };

  const secondsLeft = attempt ? Math.max(0, Math.floor((attempt.expiresAt - Date.now()) / 1000)) : 0;

  // ---- render ----

  if (!seed || !phoneId) {
    return (
      <View style={s.page}>
        <StatusBar style="light" />
        <Text style={s.h1}>clankerchat companion</Text>
        <Text style={s.muted}>
          First run: this phone generates its own signing key. The private half never leaves the
          device (OS secure storage); machines pin only the public line.
        </Text>
        <Pressable style={s.button} onPress={() => void createIdentity()}>
          <Text style={s.buttonText}>Generate phone key</Text>
        </Pressable>
      </View>
    );
  }

  if (scanning) {
    return (
      <View style={s.page}>
        <StatusBar style="light" />
        <Text style={s.h1}>Enroll a machine</Text>
        <Text style={s.muted}>
          Scan the QR printed by `botlink companion --enroll` on the machine's terminal, then
          verify the machine fingerprint it shows matches this record.
        </Text>
        {perm?.granted ? (
          <CameraView
            style={s.camera}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (!busy) void onScanned(data);
            }}
          />
        ) : (
          <Pressable style={s.button} onPress={() => void requestPerm()}>
            <Text style={s.buttonText}>Grant camera permission</Text>
          </Pressable>
        )}
        <Pressable style={s.ghost} onPress={() => setScanning(false)}>
          <Text style={s.ghostText}>Cancel</Text>
        </Pressable>
        {busy ? <ActivityIndicator color="#7aa2f7" /> : null}
        <Msg error={error} notice={notice} />
      </View>
    );
  }

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.page}>
      <StatusBar style="light" />
      <Text style={s.h1}>clankerchat companion</Text>

      {machines.length === 0 ? (
        <Text style={s.muted}>
          No machines enrolled. Run `npm run botlink -- companion --enroll` on the machine, then
          scan its QR here.
        </Text>
      ) : (
        <View style={s.row}>
          {machines.map((m) => (
            <Pressable
              key={m.id}
              style={[s.chip, active?.id === m.id && s.chipActive]}
              onPress={() => {
                setActive(m);
                setAttempt(null);
                setAsks([]);
                setPrompts([]);
                setMachine(null);
                setSearchResults(null); // results belong to the machine they came from
                setHistory([]); // history pages are per-machine too — walk each machine's own past
                setSentMore(false);
                setNotices([]); // notices are per-machine reports — clear, repoll repopulates
                setUnacked(0);
                noticesLimitRef.current = 10; // window width is a view preference per machine view
                setNoticesLimit(10);
                setExpanded(new Set());
                seenPromptStatus.current.clear(); // notification transitions are per-machine:
                // a stale status from machine A must never look like a
                // "transition" for a colliding promptId on machine B
                setNotice("");
                setError("");
              }}
            >
              <Text style={s.chipText} selectable={false}>
                {m.host}:{m.port}
              </Text>
            </Pressable>
          ))}
          <Pressable style={[s.chip, s.chipAdd]} onPress={() => setScanning(true)}>
            <Text style={s.chipText}>+ enroll</Text>
          </Pressable>
        </View>
      )}
      {machines.length === 0 ? (
        <Pressable style={s.button} onPress={() => setScanning(true)}>
          <Text style={s.buttonText}>Scan enrollment QR</Text>
        </Pressable>
      ) : null}

      {active ? (
        <Text style={s.fp} selectable={false}>
          machine fingerprint: {active.fp}
        </Text>
      ) : null}

      {active && machine ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>MACHINE</Text>
          {machine.alerts?.length
            ? machine.alerts.map((a, i) => (
                <Text key={`alert-${i}`} style={s.err}>
                  ⚠ {a}
                </Text>
              ))
            : null}
          {battery ? (
            <Text style={battery.level < 0.2 && !battery.charging ? s.err : s.muted}>
              phone battery {Math.round(battery.level * 100)}%{battery.charging ? " · charging" : ""}
              {battery.level < 0.2 && !battery.charging ? " — approval surface may die soon" : ""}
            </Text>
          ) : null}
          {machine.lanePaired > 0 && machine.laneHealthMs !== null ? (
            <Text style={s.muted}>
              injects: {(machine.laneHealthMs / 1000).toFixed(1)}s median · {machine.lanePaired} paired
            </Text>
          ) : null}
          {machine.stale ? (
            <Text style={s.err}>state stale — watcher stopped writing?</Text>
          ) : (
            <>
              <Text style={s.muted}>
                pool {machine.active}/{machine.maxConcurrent} · queue {machine.queuedHuman + machine.queuedBot}
                {machine.lastRunAt
                  ? ` · ran ${Math.max(0, Math.round((Date.now() - Date.parse(machine.lastRunAt)) / 60000))}m ago`
                  : " · no runs yet"}
              </Text>
              <Text style={machine.laneOk === false ? s.err : s.ok}>
                {machine.laneOk === null
                  ? "lane: not probed yet"
                  : `lane ${machine.lanePeer ?? "peer"} ${machine.laneOk ? "✓" : "✗"}${
                      machine.lanePending > 0 ? ` · ${machine.lanePending} queued on peer` : ""
                    }`}
              </Text>
              {machine.lanePeerLastRunAt && machine.laneOk ? (
                <Text style={s.muted}>
                  peer ran {Math.max(0, Math.round((Date.now() - Date.parse(machine.lanePeerLastRunAt)) / 60000))}m ago
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {active && notices.length > 0 ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>NOTICES{unacked > 0 ? ` · ${unacked} unread` : ""}</Text>
          {notices
            .slice()
            .reverse()
            .map((n) => {
              const open = expanded.has(n.id);
              return (
                <Pressable key={n.id} style={s.promptRow} onPress={() => toggleExpanded(n.id)}>
                  <Text style={n.severity === "warn" && !n.acked ? s.err : s.muted} numberOfLines={1}>
                    {n.severity === "warn" ? "⚠ " : ""}
                    {n.from} · {new Date(n.ts).toLocaleString()}
                    {n.acked ? " · read" : ""}
                  </Text>
                  <Text style={n.acked ? s.stamp : s.noticeText} numberOfLines={open ? undefined : 4}>
                    {n.text}
                  </Text>
                  {!n.acked ? (
                    <Pressable style={[s.button, s.buttonDim]} onPress={() => void doAckNotice(n.id)}>
                      <Text style={s.buttonText}>Dismiss</Text>
                    </Pressable>
                  ) : null}
                </Pressable>
              );
            })}
          {unacked > 1 ? (
            <Pressable style={[s.button, s.buttonDim]} onPress={() => void doAckAllNotices()}>
              <Text style={s.buttonText}>Dismiss all ({unacked})</Text>
            </Pressable>
          ) : null}
          {/* Window toggle: only offered when the window is FULL (exactly
              `limit` rows) — a short list proves the registry has nothing
              older to reveal. The flip takes effect on the next 2s poll. */}
          {noticesLimit === 10 && notices.length >= 10 ? (
            <Pressable
              style={[s.button, s.buttonDim]}
              onPress={() => {
                noticesLimitRef.current = 50;
                setNoticesLimit(50);
              }}
            >
              <Text style={s.buttonText}>Show older notices</Text>
            </Pressable>
          ) : noticesLimit === 50 ? (
            <Pressable
              style={[s.button, s.buttonDim]}
              onPress={() => {
                noticesLimitRef.current = 10;
                setNoticesLimit(10);
              }}
            >
              <Text style={s.buttonText}>Recent only</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {active && asks.length > 0
        ? asks.map((a) => (
            <View key={a.askId} style={s.card}>
              <Text style={s.cardTitle}>
                ASK · {Math.max(0, Math.round((a.expiresAt - Date.now()) / 60000))}m left
                {a.lazy ? " · silence = yes" : ""}
              </Text>
              <Text style={s.muted}>{a.question}</Text>
              <View style={s.row}>
                <Pressable
                  style={[s.button, s.allow]}
                  disabled={busy}
                  onPress={() => void doAskDecision(a.askId, "approve")}
                >
                  <Text style={s.buttonText}>Approve</Text>
                </Pressable>
                <Pressable
                  style={[s.button, s.deny]}
                  disabled={busy}
                  onPress={() => void doAskDecision(a.askId, "deny")}
                >
                  <Text style={s.buttonText}>Deny</Text>
                </Pressable>
              </View>
            </View>
          ))
        : null}

      {active ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>PROMPT THIS MACHINE</Text>
          <TextInput
            style={s.promptInput}
            value={promptText}
            onChangeText={setPromptText}
            multiline
            placeholder="What should the machine work on?"
            placeholderTextColor="#565f89"
          />
          <View style={s.row}>
            <Text style={s.muted}>run on:</Text>
            <Pressable
              style={[s.routeChip, !routePeer ? s.routeChipOn : null]}
              onPress={() => setRoutePeer(false)}
            >
              <Text style={[s.routeChipText, !routePeer ? s.routeChipTextOn : null]}>this machine</Text>
            </Pressable>
            <Pressable
              style={[s.routeChip, routePeer ? s.routeChipOn : null]}
              onPress={() => setRoutePeer(true)}
            >
              <Text style={[s.routeChipText, routePeer ? s.routeChipTextOn : null]}>peer machine</Text>
            </Pressable>
          </View>
          <Pressable
            style={[s.button, (!promptText.trim() || busy) ? s.buttonDim : null]}
            disabled={!promptText.trim() || busy}
            onPress={() => void doSendPrompt()}
          >
            <Text style={s.buttonText}>Send</Text>
          </Pressable>
          <Text style={s.muted}>
            {routePeer
              ? "Routed (phase 1): the peer machine runs it and answers in its own venue; the preview echoes back here within 30 min."
              : "Same trust as Approve up there — the machine runs it as an owner request and answers in Discord (your app pings you)."}
          </Text>
        </View>
      ) : null}

      {active ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>FIND</Text>
          <TextInput
            style={s.input}
            value={searchQ}
            onChangeText={setSearchQ}
            placeholder="text or promptId"
            placeholderTextColor="#7a8a99"
            returnKeyType="search"
            onSubmitEditing={() => void doSearch()}
          />
          <View style={s.row}>
            <Pressable style={[s.button, s.allow]} disabled={busy} onPress={() => void doSearch()}>
              <Text style={s.buttonText}>Search</Text>
            </Pressable>
            {searchResults !== null ? (
              <Pressable
                style={[s.button, s.deny]}
                onPress={() => {
                  setSearchResults(null);
                  setSearchQ("");
                }}
              >
                <Text style={s.buttonText}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
          {searchResults !== null ? (
            searchResults.length === 0 ? (
              <Text style={s.muted}>no matches</Text>
            ) : (
              searchResults
                .slice()
                .reverse()
                .map(renderPromptRow)
            )
          ) : null}
        </View>
      ) : null}

      {active && prompts.length > 0 ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>SENT</Text>
          {/* newest first: live window on top, frozen history pages under it,
              deduped (a still-eligible answer can sit in both windows) */}
          {[...history, ...prompts]
            .filter((p, i, all) => all.findIndex((q) => q.promptId === p.promptId) === i)
            .slice()
            .reverse()
            .map(renderPromptRow)}
          <Pressable style={[s.button, s.buttonDim]} disabled={busy || !sentMore} onPress={() => void loadOlder()}>
            <Text style={s.buttonText}>{sentMore ? "Load older" : "start of history"}</Text>
          </Pressable>
        </View>
      ) : null}

      {active && !attempt ? (
        <View style={s.card}>
          <Text style={s.muted}>No live pairing attempt. This screen updates automatically.</Text>
        </View>
      ) : null}

      {active && attempt ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>
            {attempt.mode === "rotate" ? "ROTATION" : "FIRST PAIRING"} — {attempt.peer?.name ?? "?"}
          </Text>
          <Text style={s.fp} selectable={false}>
            peer hostkey: {attempt.peer?.hostkeyFp ?? "?"}
          </Text>
          <Text style={s.label}>Your machine's SAS (post YOUR value; never share from here):</Text>
          <Text style={s.sas} selectable={false}>
            {attempt.sas}
          </Text>
          <Text style={s.muted}>expires in {secondsLeft}s — compare BOTH owners' values first</Text>
          <Text style={s.label}>Type the PEER's SAS exactly as shown on the peer's screen:</Text>
          <TextInput
            style={s.input}
            value={sasInput}
            onChangeText={setSasInput}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="XXXX-XXXX"
            placeholderTextColor="#565f89"
          />
          <View style={s.row}>
            <Pressable style={[s.button, s.allow]} disabled={busy} onPress={() => void doAllow()}>
              <Text style={s.buttonText}>Allow</Text>
            </Pressable>
            <Pressable style={[s.button, s.deny]} disabled={busy} onPress={() => void doDeny()}>
              <Text style={s.buttonText}>Deny</Text>
            </Pressable>
          </View>
          <Text style={s.muted}>
            If the two SAS values differ, DENY — that is a possible man-in-the-middle.
          </Text>
        </View>
      ) : null}

      {busy ? <ActivityIndicator color="#7aa2f7" /> : null}
      <Msg error={error} notice={notice} />
    </ScrollView>
  );
}

function Msg({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error ? <Text style={s.err}> {error}</Text> : null}
      {notice ? <Text style={s.ok}> {notice}</Text> : null}
    </>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#1a1b26" },
  page: { padding: 20, paddingTop: 60, gap: 14 },
  h1: { color: "#c0caf5", fontSize: 22, fontWeight: "700" },
  muted: { color: "#a9b1d6", fontSize: 13, lineHeight: 19 },
  label: { color: "#7aa2f7", fontSize: 12, marginTop: 6 },
  fp: { color: "#9ece6a", fontSize: 11, fontFamily: "monospace" },
  card: { backgroundColor: "#24283b", borderRadius: 12, padding: 16, gap: 6 },
  cardTitle: { color: "#c0caf5", fontSize: 15, fontWeight: "700" },
  sas: { color: "#ffffff", fontSize: 44, fontWeight: "800", letterSpacing: 2, fontVariant: ["tabular-nums"] },
  input: {
    color: "#c0caf5",
    backgroundColor: "#1f2335",
    borderRadius: 8,
    padding: 12,
    fontSize: 22,
    letterSpacing: 2,
  },
  promptInput: {
    color: "#c0caf5",
    backgroundColor: "#1f2335",
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    minHeight: 72,
    textAlignVertical: "top",
  },
  promptRow: { borderTopWidth: 1, borderTopColor: "#1f2335", paddingTop: 8, gap: 2 },
  noticeText: { color: "#c0caf5", fontSize: 13, lineHeight: 19 },
  stamp: { color: "#565f89", fontSize: 11 },
  excerpt: { color: "#9aa5ce", fontStyle: "italic", fontSize: 13, lineHeight: 18 },
  buttonDim: { opacity: 0.4 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: { backgroundColor: "#7aa2f7", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 22 },
  allow: { backgroundColor: "#9ece6a", flex: 1, alignItems: "center" },
  deny: { backgroundColor: "#f7768e", flex: 1, alignItems: "center" },
  buttonText: { color: "#1a1b26", fontWeight: "700", fontSize: 15 },
  chip: { backgroundColor: "#24283b", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: "#7aa2f7" },
  chipAdd: { borderWidth: 1, borderColor: "#414868" },
  // Route toggle (phase 1): cyan-outline idle, cyan-filled active — visually
  // distinct from the machine-select chips (blue) so "WHERE it runs" never
  // reads as "WHICH machine you're talking to".
  routeChip: { borderWidth: 1, borderColor: "#414868", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  routeChipOn: { borderColor: "#2ac0de", backgroundColor: "#2ac0de" },
  routeChipText: { color: "#c0caf5", fontSize: 12 },
  routeChipTextOn: { color: "#1a1b26", fontWeight: "600" },
  chipText: { color: "#c0caf5", fontSize: 13 },
  ghost: { padding: 8 },
  ghostText: { color: "#7aa2f7", fontSize: 14 },
  camera: { width: "100%", height: 340, borderRadius: 12, overflow: "hidden" },
  err: { color: "#f7768e", fontSize: 13 },
  ok: { color: "#9ece6a", fontSize: 13 },
});
