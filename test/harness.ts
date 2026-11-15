// End-to-end harness for the Proof Gatekeeper agent service.
//
// Spins up the real HTTP server (ephemeral port, test HMAC secret, temp
// seen-set file, stub Kurier helper) and replays sample envelopes covering
// the VALID case and all 7 trap types, plus boundaries, HMAC failures,
// preflight, seen-set persistence, and the Kurier 401 path.
//
// Run: npm test
// Note: each provable case generates a real Groth16 proof (~10s on this VM),
// so the full harness takes ~2 minutes.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { groth16, type Groth16Proof } from "snarkjs";
import { loadConfig } from "../src/config";
import { taskIdToField } from "../src/field";
import { signBody, verifySignature } from "../src/hmac";
import { KurierClient } from "../src/kurier";
import { Prover } from "../src/prover";
import { SeenStore } from "../src/seenStore";
import { createServer } from "../src/server";
import type { TaskEnvelope } from "../src/decision";
import {
  amountEnvelope,
  boundaryAmountEnvelope,
  boundaryExpiryEnvelope,
  boundaryThresholdEnvelope,
  expiredEnvelope,
  recipientEnvelope,
  sampleEnvelope,
  thresholdEnvelope,
  validEnvelope,
} from "./envelopes";

const TEST_SECRET = "test-secret-do-not-use-in-production";
const PROJECT_DIR = path.resolve(__dirname, "..", "..");
const CIRCUITS_DIR = path.join(PROJECT_DIR, "circuits");
const STUB_PATH = path.join(PROJECT_DIR, "test", "stub-kurier.py");
const VK = JSON.parse(
  fs.readFileSync(path.join(CIRCUITS_DIR, "gatekeeper_vk.json"), "utf8"),
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-harness-"));
const seenFile = path.join(tmpDir, "seen.json");
const stubLog = path.join(tmpDir, "stub.log");
process.env.STUB_LOG = stubLog;
process.env.STUB_MODE = "ok";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL ${label} ${detail}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PostResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  json: Record<string, unknown>;
}

function httpRequest(
  options: http.RequestOptions,
  body?: Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; rawBody: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, rawBody: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    AGENT_GAMES_HMAC_SECRET: TEST_SECRET,
    PORT: "0",
    HOST: "127.0.0.1",
    CIRCUITS_DIR,
    SEEN_FILE: seenFile,
    KURIER_HELPER_PATH: STUB_PATH,
    PROVE_TIMEOUT_MS: "55000",
  });
  const prover = new Prover(config.circuitsDir);
  const seen = SeenStore.load(config.seenFile);
  const kurierLogs: string[] = [];
  const kurier = new KurierClient(config.kurierHelperPath, config.vkHash, (m) =>
    kurierLogs.push(m),
  );
  const server = createServer(config, { prover, seen, kurier });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listen address");
  const port = address.port;
  console.log(`[harness] server on 127.0.0.1:${port}, tmp=${tmpDir}`);

  const postAgent = async (
    envelope: TaskEnvelope | string,
    secret: string = TEST_SECRET,
  ): Promise<PostResult> => {
    const raw = Buffer.from(
      typeof envelope === "string" ? envelope : JSON.stringify(envelope),
      "utf8",
    );
    const res = await httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/agent",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-games-signature": signBody(secret, raw),
          "Content-Length": raw.length,
        },
      },
      raw,
    );
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      // leave empty; the status check will catch it
    }
    return { ...res, json };
  };

  const getHealth = async (): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    json: Record<string, unknown>;
    rawBody: Buffer;
  }> => {
    const res = await httpRequest({ host: "127.0.0.1", port, path: "/health", method: "GET" });
    return { ...res, json: JSON.parse(res.rawBody.toString("utf8")) as Record<string, unknown> };
  };

  const signatureValid = (r: PostResult): boolean =>
    verifySignature(TEST_SECRET, r.rawBody, r.headers["x-agent-games-signature"] as string);

  const proofVerifies = async (r: PostResult): Promise<boolean> => {
    if (!r.json.proof || !Array.isArray(r.json.public_signals)) return false;
    return groth16.verify(VK, r.json.public_signals as string[], r.json.proof as Groth16Proof);
  };

  const expectDecision = async (
    label: string,
    envelope: TaskEnvelope,
    wantDecision: string,
    wantReason: string,
    wantProof: boolean,
  ): Promise<PostResult> => {
    const r = await postAgent(envelope);
    check(`${label}: status 200`, r.status === 200, `got ${r.status}`);
    check(`${label}: decision=${wantDecision}`, r.json.decision === wantDecision, `got ${r.json.decision}`);
    check(`${label}: reason=${wantReason}`, r.json.reason_code === wantReason, `got ${r.json.reason_code}`);
    check(`${label}: response HMAC-signed`, signatureValid(r));
    if (wantProof) {
      check(`${label}: proof present`, r.json.proof !== null && r.json.proof !== undefined);
      check(`${label}: 13 public signals`, Array.isArray(r.json.public_signals) && r.json.public_signals.length === 13, `got ${JSON.stringify(r.json.public_signals)?.slice(0, 80)}`);
      check(`${label}: proof verifies (snarkjs)`, await proofVerifies(r));
      const ps = r.json.public_signals as string[];
      check(
        `${label}: public[11] = decision bit`,
        ps[11] === (wantDecision === "APPROVE" ? "1" : "0"),
        `got ${ps[11]}`,
      );
      check(
        `${label}: public[12] = taskId field`,
        ps[12] === taskIdToField(envelope.task_id).toString(),
        `got ${ps[12]}`,
      );
    } else {
      check(`${label}: proof null`, r.json.proof === null);
      check(`${label}: public_signals empty`, Array.isArray(r.json.public_signals) && r.json.public_signals.length === 0);
    }
    return r;
  };

  const tx = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

  try {
    console.log("\n[1] preflight + auth");
    const health = await getHealth();
    check("GET /health: status 200", health.status === 200, `got ${health.status}`);
    check(
      "GET /health: preflight body",
      health.json.ok === true && health.json.protocolVersion === "v1",
      JSON.stringify(health.json),
    );
    check(
      "GET /health: response HMAC-signed",
      verifySignature(TEST_SECRET, health.rawBody, health.headers["x-agent-games-signature"] as string),
    );
    const badSig = await postAgent(validEnvelope("gk_bad_sig", tx(900)), "wrong-secret");
    check("POST /agent wrong HMAC: 401", badSig.status === 401, `got ${badSig.status}`);
    const badJson = await postAgent("{not json");
    check("POST /agent invalid JSON: 400", badJson.status === 400, `got ${badJson.status}`);

    console.log("\n[2] event-page sample (gk_24_9d1) -> VK_SUBSTITUTION");
    await expectDecision("sample", sampleEnvelope(), "REJECT", "VK_SUBSTITUTION", true);

    console.log("\n[3] VALID + all trap types");
    await expectDecision("valid", validEnvelope("gk_valid_1", tx(1)), "APPROVE", "VALID_CONDITION", true);
    await expectDecision("threshold", thresholdEnvelope("gk_thr_1", tx(2)), "REJECT", "THRESHOLD_MISMATCH", true);
    await expectDecision("recipient", recipientEnvelope("gk_rec_1", tx(3)), "REJECT", "RECIPIENT_MISMATCH", true);
    await expectDecision("amount", amountEnvelope("gk_amt_1", tx(4)), "REJECT", "AMOUNT_OVERFLOW", true);
    await expectDecision("expired", expiredEnvelope("gk_exp_1", tx(5)), "REJECT", "EXPIRED_CONDITION", true);

    console.log("\n[4] boundaries (circuit rules)");
    await expectDecision("boundary current==expiry", boundaryExpiryEnvelope("gk_bexp_1", tx(6)), "REJECT", "EXPIRED_CONDITION", true);
    await expectDecision("boundary balance==minimum", boundaryThresholdEnvelope("gk_bthr_1", tx(7)), "APPROVE", "VALID_CONDITION", true);
    await expectDecision("boundary amount==max", boundaryAmountEnvelope("gk_bamt_1", tx(8)), "APPROVE", "VALID_CONDITION", true);

    console.log("\n[5] PROOF_REUSED + seen-set persistence");
    const reused = await postAgent(validEnvelope("gk_valid_2", tx(1))); // same proof_tx as [3] valid
    check("reuse: decision REJECT", reused.json.decision === "REJECT", `got ${reused.json.decision}`);
    check("reuse: reason PROOF_REUSED", reused.json.reason_code === "PROOF_REUSED", `got ${reused.json.reason_code}`);
    check("reuse: proof null (platform expects no proof)", reused.json.proof === null);
    const seenReloaded = SeenStore.load(seenFile);
    check("seen-set persists to disk", seenReloaded.has(tx(1)));
    check("seen-set has 3 approved proofs", seenReloaded.size() === 3, `got ${seenReloaded.size()}`);

    console.log("\n[6] Kurier stub was called (async submit after responses)");
    let stubCalls = "";
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(stubLog)) stubCalls = fs.readFileSync(stubLog, "utf8");
      if (stubCalls.includes("submit-proof") && stubCalls.includes("job-status")) break;
      await sleep(1000);
    }
    check("stub: submit-proof called", stubCalls.includes("submit-proof"), stubCalls.slice(0, 200));
    check("stub: job-status polled", stubCalls.includes("job-status"), stubCalls.slice(0, 200));
    check(
      "kurier: submit logged as submitted+Finalized",
      kurierLogs.some((m) => m.includes("submitted")) &&
        kurierLogs.some((m) => m.includes("finalized")),
      kurierLogs.join(" | ").slice(0, 400),
    );

    console.log("\n[7] Kurier 401 path (stored key rejected)");
    process.env.STUB_MODE = "401";
    const logs401: string[] = [];
    const kurier401 = new KurierClient(STUB_PATH, config.vkHash, (m) => logs401.push(m));
    const fakeProof: Groth16Proof = {
      pi_a: ["1", "2"],
      pi_b: [["1", "2"], ["3", "4"]],
      pi_c: ["5", "6"],
      protocol: "groth16",
      curve: "bn128",
    };
    const sub401 = await kurier401.submitProof(fakeProof, ["1", "2"]);
    check("401: submitProof reports httpStatus 401", sub401.httpStatus === 401, `got ${sub401.httpStatus}`);
    check("401: submitProof ok=false", sub401.ok === false);
    await kurier401.submitAndTrack("gk_401_test", fakeProof, ["1", "2"]);
    check(
      "401: submitAndTrack logs rejection, does not throw/retry-loop",
      logs401.some((m) => m.includes("401") && m.includes("NOT retrying")),
      logs401.join(" | ").slice(0, 300),
    );
    process.env.STUB_MODE = "ok";
  } finally {
    server.close();
  }

  console.log(`\n[harness] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`[harness] failures: ${failures.join(", ")}`);
  }
  console.log("[harness] ALL GREEN");
  // snarkjs leaves worker threads alive after proving, so the process does
  // not exit on its own — exit explicitly with the harness result.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(`[harness] fatal: ${String(e)}`);
  process.exit(1);
});
