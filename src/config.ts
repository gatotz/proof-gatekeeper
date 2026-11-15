import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEKEEPER_VK_HASH } from "./field";

export interface Config {
  port: number;
  host: string;
  /** Platform HMAC secret (from "Rotate Secret"). REQUIRED — no default. */
  hmacSecret: string;
  circuitsDir: string;
  seenFile: string;
  /** Path to the Kurier connector helper (owns the vault credential). */
  kurierHelperPath: string;
  vkHash: string;
  /** Internal proving budget; the platform deadline is 60s. */
  proveTimeoutMs: number;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Project root. The compiled code runs from dist/src/ (two levels below the
 * root); under ts-node it runs from src/ (one level below). Pick the first
 * candidate that actually contains the circuit artifacts.
 */
function resolveProjectDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, ".."),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "circuits", "gatekeeper.wasm"))) return dir;
  }
  return candidates[0];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hmacSecret = env.AGENT_GAMES_HMAC_SECRET;
  if (!hmacSecret) {
    throw new Error(
      "AGENT_GAMES_HMAC_SECRET is not set — refusing to start without the " +
        "platform HMAC secret (set it in .env; never commit it).",
    );
  }
  const projectDir = resolveProjectDir();
  return {
    port: parseInt(env.PORT ?? "3000", 10),
    host: env.HOST ?? "127.0.0.1",
    hmacSecret,
    circuitsDir: env.CIRCUITS_DIR
      ? expandHome(env.CIRCUITS_DIR)
      : path.join(projectDir, "circuits"),
    seenFile: env.SEEN_FILE
      ? expandHome(env.SEEN_FILE)
      : path.join(projectDir, "data", "seen.json"),
    kurierHelperPath: env.KURIER_HELPER_PATH
      ? expandHome(env.KURIER_HELPER_PATH)
      : expandHome("~/workspace/custom-connectors/custom.kurier/bin/kurier.py"),
    vkHash: env.GATEKEEPER_VK_HASH ?? GATEKEEPER_VK_HASH,
    proveTimeoutMs: parseInt(env.PROVE_TIMEOUT_MS ?? "50000", 10),
  };
}
