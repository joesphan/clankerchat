/**
 * Shared .env loader — used by both the MCP server (index.ts) and the
 * dispatcher daemon (daemon.ts) so they read the same config file.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Compiled output lives in dist/, directly under the project root.
export const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");

/**
 * Loads .env from the project root so the token never has to live in the MCP
 * client config. Existing environment variables win over .env values.
 */
export function loadEnvFile(): void {
  const envPath = path.join(PROJECT_ROOT, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env file — env vars may still provide config
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined || process.env[match[1]] === "") {
      process.env[match[1]] = value;
    }
  }
}
