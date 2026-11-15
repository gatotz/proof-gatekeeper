import fs from "node:fs";
import path from "node:path";
import { groth16, type Groth16Proof } from "snarkjs";
import { hashVk, hexToField, taskIdToField } from "./field";
import type { TaskEnvelope } from "./decision";

export type { Groth16Proof };

export interface ProveResult {
  proof: Groth16Proof;
  publicSignals: string[];
}

// Proof generation is serialised through a promise chain: snarkjs loads the
// wasm/zkey per call and proving is CPU-heavy; sequential keeps memory
// bounded and behaviour deterministic under concurrent tasks.
let queue: Promise<unknown> = Promise.resolve();

export class Prover {
  private readonly wasmPath: string;
  private readonly zkeyPath: string;
  private readonly vk: unknown;

  constructor(circuitsDir: string) {
    this.wasmPath = path.join(circuitsDir, "gatekeeper.wasm");
    this.zkeyPath = path.join(circuitsDir, "gatekeeper_final.zkey");
    const vkPath = path.join(circuitsDir, "gatekeeper_vk.json");
    for (const [label, p] of [
      ["gatekeeper.wasm", this.wasmPath],
      ["gatekeeper_final.zkey", this.zkeyPath],
      ["gatekeeper_vk.json", vkPath],
    ] as const) {
      if (!fs.existsSync(p)) {
        throw new Error(`circuit artifact missing: ${label} not found at ${p}`);
      }
    }
    this.vk = JSON.parse(fs.readFileSync(vkPath, "utf8"));
  }

  /**
   * Circuit input signals (13), discovered by probing the wasm with FNV-1a
   * hashes of candidate names (scripts/probe-signals*.mjs) and verified
   * empirically (scripts/probe-circuit.cjs):
   *
   *   minimum, publicBalance, expiryBlock, currentBlock, recipient,
   *   conditionRecipient, amount, maxTransfer, taskId, decision,
   *   registeredVkHash, proofVkHash, salt
   *
   * decision: "1" = APPROVE, "0" = REJECT. salt: "0" (deterministic
   * default). Public-signal order in the witness (13):
   *   [0] commitment hash = H(taskId, salt)  (computed by the circuit;
   *       changes with taskId and salt, not with any other input)
   *   [1] registeredVkHash  [2] proofVkHash  [3] minimum
   *   [4] publicBalance     [5] expiryBlock  [6] currentBlock
   *   [7] recipient         [8] conditionRecipient
   *   [9] amount            [10] maxTransfer
   *   [11] decision         [12] taskId
   */
  buildInput(
    task: TaskEnvelope,
    decision: "APPROVE" | "REJECT",
    salt = "0",
  ): Record<string, string> {
    const input = task.input;
    return {
      minimum: BigInt(input.minimum).toString(),
      publicBalance: BigInt(input.public_balance).toString(),
      expiryBlock: String(input.expiry_block),
      currentBlock: String(input.current_block),
      recipient: hexToField(input.recipient).toString(),
      conditionRecipient: hexToField(input.condition_recipient).toString(),
      amount: BigInt(input.amount).toString(),
      maxTransfer: BigInt(input.max_transfer).toString(),
      taskId: taskIdToField(task.task_id).toString(),
      decision: decision === "APPROVE" ? "1" : "0",
      registeredVkHash: hashVk(input.registered_vk).toString(),
      proofVkHash: hashVk(input.proof_vk).toString(),
      salt,
    };
  }

  async prove(
    task: TaskEnvelope,
    decision: "APPROVE" | "REJECT",
    salt = "0",
  ): Promise<ProveResult> {
    const input = this.buildInput(task, decision, salt);
    const run = () => groth16.fullProve(input, this.wasmPath, this.zkeyPath);
    const result = queue.then(run, run) as Promise<ProveResult>;
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async verify(proof: Groth16Proof, publicSignals: string[]): Promise<boolean> {
    return groth16.verify(this.vk, publicSignals, proof);
  }

  /**
   * Startup self-check: prove a fixed dummy VALID task and verify the proof
   * locally. Throws if the proving pipeline is broken — the service refuses
   * to start, because it cannot do its job without proving. (~10s on this VM.)
   */
  async selfCheck(): Promise<{ ms: number }> {
    const dummy: TaskEnvelope = {
      type: "agent-games.proof-gatekeeper.v1",
      task_id: "gk_selfcheck_1",
      mode: "competition",
      issued_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      input: {
        registered_vk: "0x7d3a00000000000000000000000000000000f291",
        proof_vk: "0x7d3a00000000000000000000000000000000f291",
        minimum: "1000",
        public_balance: "1460",
        expiry_block: 19842201,
        current_block: 19832000,
        recipient: "0xDe42000000000000000000000000000000009f01",
        condition_recipient: "0xDe42000000000000000000000000000000009f01",
        amount: "500",
        max_transfer: "1000",
        proof_tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    };
    const started = Date.now();
    const { proof, publicSignals } = await this.prove(dummy, "APPROVE");
    const ok = await this.verify(proof, publicSignals);
    if (!ok) throw new Error("prover self-check: generated proof did not verify");
    return { ms: Date.now() - started };
  }
}
