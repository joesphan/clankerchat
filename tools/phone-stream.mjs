// phone-stream.mjs — spectator stream for the Moto G: screencap loop + HTTP.
// Serves:  /  (auto-refresh page)  /frame.jpg (latest capture)
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const ADB = "C:\\Users\\joesp\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = process.env.PHONE_SERIAL ?? "ZY22KVVZPH";
const PORT = Number(process.env.STREAM_PORT ?? 8790);
const FRAME = path.join(import.meta.dirname ?? ".", "stream-frame.jpg");
const run = promisify(execFile);

const PAGE = `<!doctype html><meta charset=utf-8><title>phone</title>
<body style="margin:0;background:#111;display:grid;place-items:center;height:100vh">
<img src="/frame.jpg" style="max-width:100%;max-height:100vh" id=f>
<script>setInterval(()=>f.src='/frame.jpg?'+Date.now(),1500)</script>`;

async function capture() {
  try {
    const { stdout } = await run(ADB, ["-s", SERIAL, "exec-out", "screencap", "-p"], {
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    fs.writeFileSync(FRAME, stdout);
  } catch {
    /* device asleep/unplugged — keep serving the last frame */
  }
}
capture();
setInterval(() => void capture(), 1500);

http
  .createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    } else if (req.url.startsWith("/frame.jpg")) {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(
        fs.existsSync(FRAME) ? fs.readFileSync(FRAME) : Buffer.alloc(0),
      );
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`phone-stream on 127.0.0.1:${PORT}`));
