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
 *     (the agents-never-relay-SAS law extends to apps; selectable={false}),
 *   - arm pairings, touch the lane, or read anything but pairing state.
 *
 * Protocol (must byte-match src/companion.ts):
 *   signed message = lenDelim("clanker-companion-v1", METHOD, path,
 *                             sha256hex(body), decimal-counter)
 *   headers: x-companion-id (fingerprint of the phone key), x-counter, x-sig
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
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

async function signedFetch(
  machine: Machine,
  seed: Uint8Array,
  phoneId: string,
  method: "GET" | "POST",
  path: string,
  bodyObj?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const counters = (await loadJson<Record<string, number>>(K_COUNTERS)) ?? {};
  const counter = (counters[machine.id] ?? 0) + 1;
  counters[machine.id] = counter;
  await saveJson(K_COUNTERS, counters); // burn optimistically: gaps are fine, repeats never

  const body: Bytes = method === "GET" ? new Uint8Array(0) : utf8(JSON.stringify(bodyObj ?? {}));
  const msg = lenDelim(
    "clanker-companion-v1",
    method,
    path,
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
  const [sasInput, setSasInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [perm, requestPerm] = useCameraPermissions();
  const appState = useRef(AppState.currentState);

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
        const res = await fetch(`http://${payload.host}:${payload.port}/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: payload.tkn, phonePub: pubLine }),
        });
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

      {active && !attempt ? (
        <View style={s.card}>
          {error ? <Text style={s.err}> {error}</Text> : null}
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
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: { backgroundColor: "#7aa2f7", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 22 },
  allow: { backgroundColor: "#9ece6a", flex: 1, alignItems: "center" },
  deny: { backgroundColor: "#f7768e", flex: 1, alignItems: "center" },
  buttonText: { color: "#1a1b26", fontWeight: "700", fontSize: 15 },
  chip: { backgroundColor: "#24283b", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: "#7aa2f7" },
  chipAdd: { borderWidth: 1, borderColor: "#414868" },
  chipText: { color: "#c0caf5", fontSize: 13 },
  ghost: { padding: 8 },
  ghostText: { color: "#7aa2f7", fontSize: 14 },
  camera: { width: "100%", height: 340, borderRadius: 12, overflow: "hidden" },
  err: { color: "#f7768e", fontSize: 13 },
  ok: { color: "#9ece6a", fontSize: 13 },
});
