import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Groth16Proof } from "snarkjs";

const execFileAsync = promisify(execFile);

export interface KurierResult {
  httpStatus: number;
  body: unknown;
}

export interface KurierSubmission {
  /** True when the provider answered 2xx AND a job id was found in the body. */
  ok: boolean;
  httpStatus: number;
  jobId: string | null;
  body: unknown;
}

function findJobId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["jobId", "job_id", "id"]) {
    if (typeof b[key] === "string" && (b[key] as string).length > 0) {
      return b[key] as string;
    }
  }
  const job = b.job;
  if (job && typeof job === "object") {
    const j = job as Record<string, unknown>;
    for (const key of ["jobId", "job_id", "id"]) {
      if (typeof j[key] === "string" && (j[key] as string).length > 0) {
        return j[key] as string;
      }
    }
  }
  return null;
}

function extractStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["status", "state"]) {
    if (typeof b[key] === "string") return b[key] as string;
  }
  const job = b.job;
  if (job && typeof job === "object") {
    const j = job as Record<string, unknown>;
    for (const key of ["status", "state"]) {
      if (typeof j[key] === "string") return j[key] as string;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kurier submission through the connector helper.
 *
 * The helper (~/workspace/custom-connectors/custom.kurier/bin/kurier.py)
 * owns the vault credential (custom.kurier). This code NEVER sees, passes,
 * or logs any API key — it only shells out to the helper with file paths,
 * and the helper prints {"http_status": N, "body": ...} to stdout.
 *
 * The helper exits 0 whenever the provider answered, even on 4xx/5xx — so
 * the HTTP status in the printed JSON (not the exit code) decides success.
 * Exit 2 means no HTTP response was received (network / credential setup).
 *
 * NOTE (2026-11-14): the stored key is currently REJECTED by Kurier
 * (401 Unauthorized on submit-proof and job-status). submitProof() surfaces
 * that as httpStatus 401 with ok=false; the caller must NOT retry a 401
 * with the same key — the user is re-entering the mainnet key. Live Kurier
 * submission testing is pending the corrected key.
 */
export class KurierClient {
  private readonly apiKey: string | undefined;

  constructor(
    private readonly helperPath: string,
    private readonly vkHash: string,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    // Direct mode (Fly.io / any host without the vault helper): when
    // KURIER_API_KEY is set, call api.kurier.xyz directly instead of
    // shelling out to kurier.py. The key is never logged.
    const k = process.env.KURIER_API_KEY;
    this.apiKey = k && k.trim().length > 0 ? k.trim() : undefined;
  }

  private async callDirect(method: "GET" | "POST", path: string, payload?: unknown): Promise<KurierResult> {
    const url = `https://api.kurier.xyz/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        // api.kurier.xyz sits behind Cloudflare, which blocks the default
        // Python-urllib UA with error 1010 — same reason kurier.py sends
        // a browser UA.
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(70_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body };
  }

  private async runHelper(args: string[]): Promise<KurierResult> {
    let stdout: string;
    try {
      const { stdout: out } = await execFileAsync("python3", [this.helperPath, ...args], {
        timeout: 70_000,
        maxBuffer: 1024 * 1024,
      });
      stdout = out;
    } catch (e: unknown) {
      const err = e as { stdout?: unknown; message?: unknown };
      if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
        // Helper exited non-zero but still printed its JSON envelope.
        stdout = err.stdout;
      } else {
        throw new Error(`kurier helper failed (no provider answer): ${String(err.message ?? e)}`);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`kurier helper printed non-JSON output: ${stdout.slice(0, 200)}`);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).http_status !== "number"
    ) {
      throw new Error(`kurier helper output missing http_status: ${stdout.slice(0, 200)}`);
    }
    const p = parsed as Record<string, unknown>;
    return { httpStatus: p.http_status as number, body: p.body };
  }

  /** Submit a Groth16 proof to Kurier. Files are temp-only, deleted after. */
  async submitProof(proof: Groth16Proof, publicSignals: string[]): Promise<KurierSubmission> {
    if (this.apiKey) {
      const result = await this.callDirect("POST", `/submit-proof/${this.apiKey}`, {
        proofType: "groth16",
        vkRegistered: true,
        proofOptions: { library: "snarkjs", curve: "bn128" },
        proofData: { proof, publicSignals, vk: this.vkHash },
      });
      const jobId = findJobId(result.body);
      const ok = result.httpStatus >= 200 && result.httpStatus < 300 && jobId !== null;
      return { ok, httpStatus: result.httpStatus, jobId, body: result.body };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-games-kurier-"));
    const proofFile = path.join(dir, "proof.json");
    const signalsFile = path.join(dir, "public.json");
    try {
      fs.writeFileSync(proofFile, JSON.stringify(proof), "utf8");
      fs.writeFileSync(signalsFile, JSON.stringify(publicSignals), "utf8");
      const result = await this.runHelper([
        "submit-proof",
        "--proof",
        proofFile,
        "--public-signals",
        signalsFile,
        "--vk-hash",
        this.vkHash,
      ]);
      const jobId = findJobId(result.body);
      const ok = result.httpStatus >= 200 && result.httpStatus < 300 && jobId !== null;
      return { ok, httpStatus: result.httpStatus, jobId, body: result.body };
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  }

  async jobStatus(jobId: string): Promise<KurierResult> {
    if (this.apiKey) {
      return this.callDirect("GET", `/job-status/${this.apiKey}/${jobId}`);
    }
    return this.runHelper(["job-status", "--job-id", jobId]);
  }

  /**
   * Poll job-status until the job reaches Finalized (or fails / times out).
   * Returns "finalized" | "failed" | "timeout".
   */
  async pollUntilFinalized(
    jobId: string,
    opts: { intervalMs?: number; maxAttempts?: number } = {},
  ): Promise<string> {
    const intervalMs = opts.intervalMs ?? 10_000;
    const maxAttempts = opts.maxAttempts ?? 30;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: KurierResult;
      try {
        res = await this.jobStatus(jobId);
      } catch (e) {
        this.log(`[kurier] job-status attempt ${attempt} transport error: ${String(e)}`);
        await sleep(intervalMs);
        continue;
      }
      const status = extractStatus(res.body);
      this.log(
        `[kurier] job ${jobId} poll ${attempt}: http=${res.httpStatus} ` +
          `status=${status ?? "?"} body=${JSON.stringify(res.body).slice(0, 300)}`,
      );
      if (status && status.toLowerCase() === "finalized") return "finalized";
      if (status && ["failed", "error", "rejected"].includes(status.toLowerCase())) {
        return "failed";
      }
      if (res.httpStatus === 401) return "failed"; // key rejected — do not spin
      await sleep(intervalMs);
    }
    return "timeout";
  }

  /**
   * Fire-and-forget submission after a response was sent: submit, then poll
   * to Finalized. Never throws. A 401 is logged once and not retried.
   */
  async submitAndTrack(
    taskId: string,
    proof: Groth16Proof,
    publicSignals: string[],
  ): Promise<void> {
    try {
      const sub = await this.submitProof(proof, publicSignals);
      if (!sub.ok) {
        if (sub.httpStatus === 401) {
          this.log(
            `[kurier] task ${taskId}: submit rejected (HTTP 401 — stored key ` +
              `is not accepted by Kurier). NOT retrying; the mainnet key ` +
              `needs to be re-entered. body=${JSON.stringify(sub.body).slice(0, 300)}`,
          );
        } else {
          this.log(
            `[kurier] task ${taskId}: submit not accepted (http=${sub.httpStatus}, ` +
              `jobId=${sub.jobId ?? "none"}). body=${JSON.stringify(sub.body).slice(0, 300)}`,
          );
        }
        return;
      }
      this.log(`[kurier] task ${taskId}: submitted, job ${sub.jobId} — polling to Finalized…`);
      const outcome = await this.pollUntilFinalized(sub.jobId as string);
      this.log(`[kurier] task ${taskId}: job ${sub.jobId} -> ${outcome}`);
    } catch (e) {
      this.log(`[kurier] task ${taskId}: submission error: ${String(e)}`);
    }
  }
}
