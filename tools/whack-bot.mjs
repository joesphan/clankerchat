// whack-bot.mjs — aim-bot for SpaceWhack on the Moto G.
// Raw RGBA screencap (no PNG decode: `screencap` without -p = 12-byte header +
// RGBA) → find green blobs → tap centroids. Refuses to tap if the game loses focus.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const ADB = "C:\\Users\\joesp\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "ZY22KVVZPH";
const RUN_MS = Number(process.argv[2] ?? 90_000);
const adbx = (...a) => run(ADB, ["-s", SERIAL, ...a], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });

async function focus() {
  const { stdout } = await run(ADB, ["-s", SERIAL, "shell", "dumpsys window"], { encoding: "utf8" });
  return /mCurrentFocus.*com\.spacewhack/.test(stdout);
}

async function frame() {
  const { stdout } = await adbx("exec-out", "screencap");
  const w = stdout.readUInt32LE(0), h = stdout.readUInt32LE(4);
  return { w, h, px: stdout.subarray(12) };
}

/** Green-bright target detection with coarse cluster bins (~54px cells). */
function targets({ w, h, px }) {
  const CELL = 54, bins = new Map();
  for (let y = 300; y < h - 260; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
      // SpaceWhack aliens are yellow/orange blobs: R+G high, B low.
      if (r > 150 && g > 110 && b < 110 && r > b * 1.7 && g > b * 1.3) {
        const k = `${x >> 6}|${y >> 6}`;
        const bin = bins.get(k) ?? { sx: 0, sy: 0, n: 0 };
        bin.sx += x; bin.sy += y; bin.n++;
        bins.set(k, bin);
      }
    }
  }
  return [...bins.values()].filter((b) => b.n >= 4).map((b) => [Math.round(b.sx / b.n), Math.round(b.sy / b.n)]);
}

const end = Date.now() + RUN_MS;
let hits = 0, focusLost = 0, emptyStreak = 0;
await run(ADB, ["-s", SERIAL, "shell", "svc power stayon usb"]); // keep screen on while plugged
while (Date.now() < end) {
  try {
    if (!(await focus())) {
      focusLost++;
      if (focusLost > 8) break;
      // wake + dismiss swipe lock, then let the loop re-check focus
      await run(ADB, ["-s", SERIAL, "shell", "input keyevent KEYCODE_WAKEUP"]);
      await run(ADB, ["-s", SERIAL, "shell", "input swipe 540 1900 540 500 150"]);
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    focusLost = 0;
    const ts = targets(await frame());
    if (ts.length === 0) {
      // No targets = menu/continue/stats screen — tap through it.
      if (++emptyStreak >= 3) {
        await run(ADB, ["-s", SERIAL, "shell", "input tap 540 1200"]);
        emptyStreak = 0;
      }
    } else {
      emptyStreak = 0;
      for (const [x, y] of ts.slice(0, 4)) {
        await run(ADB, ["-s", SERIAL, "shell", `input tap ${x} ${y}`]);
        hits++;
      }
    }
  } catch { /* transient adb hiccup — next loop */
  }
}
await run(ADB, ["-s", SERIAL, "shell", "svc power stayon false"]);
await adbx("exec-out", "screencap", "-p").then(({ stdout }) =>
  import("node:fs").then(({ writeFileSync }) => writeFileSync("phone-aimbot.png", stdout)),
);
console.log(JSON.stringify({ taps: hits, focusLost }));
