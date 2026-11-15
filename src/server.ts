import http from "node:http";
import type { Config } from "./config";
import { canProve, decide, type ReasonCode, type TaskEnvelope } from "./decision";
import { SIGNATURE_HEADER, signBody, verifySignature } from "./hmac";
import { KurierClient } from "./kurier";
import type { Prover } from "./prover";
import type { SeenStore } from "./seenStore";

export interface AgentResponse {
  decision: "APPROVE" | "REJECT";
  reason_code: ReasonCode | "PROOF_FAILED";
  /** Groth16 proof (snarkjs shape), or null when no proof can be submitted. */
  proof: unknown | null;
  public_signals: string[];
  proof_tx: string | null;
  task_id: string | null;
}

const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
  prover: Prover;
  seen: SeenStore;
  kurier: KurierClient;
  log?: (msg: string) => void;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createServer(config: Config, deps: ServerDeps): http.Server {
  const { prover, seen, kurier } = deps;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  function sendSigned(
    res: http.ServerResponse,
    status: number,
    obj: unknown,
  ): void {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      [SIGNATURE_HEADER]: signBody(config.hmacSecret, body),
    });
    res.end(body);
  }

  function preflightBody(): Record<string, unknown> {
    return { ok: true, protocolVersion: "v1" };
  }

  async function handleTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawBody: Buffer,
  ): Promise<void> {
    // 1. HMAC verification of the RAW body, BEFORE parsing JSON.
    if (!verifySignature(config.hmacSecret, rawBody, req.headers[SIGNATURE_HEADER] as string | undefined)) {
      sendSigned(res, 401, { error: "invalid_signature" });
      return;
    }
    let envelope: TaskEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString("utf8")) as TaskEnvelope;
    } catch {
      sendSigned(res, 400, { error: "invalid_json" });
      return;
    }
    // Preflight sent as a POST envelope.
    if (
      (envelope as unknown as Record<string, unknown>).type === "agent-games.preflight.v1"
    ) {
      sendSigned(res, 200, preflightBody());
      return;
    }

    // 2. Deterministic decision (pure function, no I/O).
    const outcome = decide(envelope, (tx) => seen.has(tx));
    const proofTx =
      envelope && envelope.input && typeof envelope.input.proof_tx === "string"
        ? envelope.input.proof_tx
        : null;
    const taskId =
      envelope && typeof envelope.task_id === "string" ? envelope.task_id : null;

    const noProofResponse = (
      decision: "APPROVE" | "REJECT",
      reason: ReasonCode | "PROOF_FAILED",
    ): AgentResponse => ({
      decision,
      reason_code: reason,
      proof: null,
      public_signals: [],
      proof_tx: proofTx,
      task_id: taskId,
    });

    // 3. No proof can be generated for this outcome (PROOF_REUSED — the
    //    platform expects no proof — or a malformed task). Fail closed.
    if (!canProve(outcome)) {
      log(`[task ${taskId ?? "?"}] ${outcome.decision} ${outcome.reason} (no proof)`);
      sendSigned(res, 200, noProofResponse(outcome.decision, outcome.reason));
      return;
    }

    // 4. Record an APPROVE in the seen-set synchronously, BEFORE the await
    //    below: decide()+add() run in the same tick, so a concurrent duplicate
    //    task is caught by the seen check instead of double-approving.
    //    If proving then fails, the entry is removed again (we never approved).
    let recorded = false;
    if (outcome.decision === "APPROVE" && proofTx) {
      seen.add(proofTx);
      recorded = true;
    }

    // 5. Generate the Groth16 proof, inside the internal budget (platform
    //    deadline is 60s; proving takes ~10s on this VM).
    let proveResult: Awaited<ReturnType<Prover["prove"]>>;
    try {
      proveResult = await withTimeout(
        prover.prove(envelope, outcome.decision),
        config.proveTimeoutMs,
      );
    } catch (e) {
      if (recorded && proofTx) seen.remove(proofTx);
      log(`[task ${taskId ?? "?"}] proving failed (${String(e)}) — fail closed to REJECT`);
      sendSigned(res, 200, noProofResponse("REJECT", "PROOF_FAILED"));
      return;
    }

    // 6. Respond within the deadline. Kurier submission happens AFTER the
    //    response, asynchronously — finalisation cannot fit inside 60s.
    const response: AgentResponse = {
      decision: outcome.decision,
      reason_code: outcome.reason,
      proof: proveResult.proof,
      public_signals: proveResult.publicSignals,
      proof_tx: proofTx,
      task_id: taskId,
    };
    sendSigned(res, 200, response);
    log(
      `[task ${taskId ?? "?"}] ${outcome.decision} ${outcome.reason} ` +
        `(proof generated, ${proveResult.publicSignals.length} public signals) — submitting to Kurier async`,
    );
    void kurier.submitAndTrack(
      taskId ?? "unknown",
      proveResult.proof,
      proveResult.publicSignals,
    );
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    void (async () => {
      try {
        const url = req.url ?? "/";
        if (req.method === "GET" && (url === "/health" || url === "/")) {
          sendSigned(res, 200, preflightBody());
          return;
        }
        if (req.method === "POST" && (url === "/agent" || url === "/")) {
          let rawBody: Buffer;
          try {
            rawBody = await readBody(req);
          } catch {
            sendSigned(res, 413, { error: "body_too_large" });
            return;
          }
          await handleTask(req, res, rawBody);
          return;
        }
        sendSigned(res, 404, { error: "not_found" });
      } catch (e) {
        log(`[server] unhandled error: ${String(e)}`);
        if (!res.headersSent) {
          sendSigned(res, 500, { error: "internal_error" });
        }
      } finally {
        log(`[server] ${req.method} ${req.url} -> ${res.statusCode} in ${Date.now() - started}ms`);
      }
    })();
  });

  return server;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
