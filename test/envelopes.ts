// Sample task envelopes for the harness. The event-page sample
// (gk_24_9d1) prints TRUNCATED addresses (0x7d3a...f291); the full 20-byte
// addresses below keep the same distinguishing prefixes/suffixes so the
// expected decision (REJECT / VK_SUBSTITUTION) is preserved.
import type { TaskEnvelope } from "../src/decision";

export const VK_A = "0x7d3a00000000000000000000000000000000f291";
export const VK_B = "0xa4c100000000000000000000000000000000b8ff";
export const RECIP = "0xDe42000000000000000000000000000000009f01";
export const OTHER_ADDR = "0x1111000000000000000000000000000000002222";

function freshTimestamps(): { issued_at: string; deadline_at: string } {
  const now = Date.now();
  return {
    issued_at: new Date(now - 60_000).toISOString(),
    deadline_at: new Date(now + 10 * 60_000).toISOString(),
  };
}

export function baseEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    ...freshTimestamps(),
    input: {
      registered_vk: VK_A,
      proof_vk: VK_A,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 19842201,
      current_block: 19832000,
      recipient: RECIP,
      condition_recipient: RECIP,
      amount: "500",
      max_transfer: "1000",
      proof_tx: proofTx,
    },
  };
}

/** The event-page sample: proof_vk != registered_vk -> VK_SUBSTITUTION. */
export function sampleEnvelope(): TaskEnvelope {
  const env = baseEnvelope(
    "gk_24_9d1",
    "0xa4c1000000000000000000000000000000000000000000000000000000008ff1",
  );
  env.input.proof_vk = VK_B;
  return env;
}

export function validEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  return baseEnvelope(taskId, proofTx);
}

export function thresholdEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.public_balance = "999"; // below minimum 1000
  return env;
}

export function recipientEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.recipient = OTHER_ADDR;
  return env;
}

export function amountEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.amount = "1001"; // above max_transfer 1000
  return env;
}

export function expiredEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.current_block = 19842202; // past expiry_block 19842201
  return env;
}

/** Boundary: current == expiry is EXPIRED per the circuit (strict <). */
export function boundaryExpiryEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.current_block = 19842201;
  return env;
}

/** Boundary: balance == minimum approves. */
export function boundaryThresholdEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.public_balance = "1000";
  return env;
}

/** Boundary: amount == max approves. */
export function boundaryAmountEnvelope(taskId: string, proofTx: string): TaskEnvelope {
  const env = baseEnvelope(taskId, proofTx);
  env.input.amount = "1000";
  return env;
}
