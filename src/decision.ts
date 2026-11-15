// Deterministic decision logic for Proof Gatekeeper.
// Pure function: no I/O, no LLM, no randomness. The order of checks is the
// order in the task spec; the reason_code of the FIRST failing check is
// reported. All numeric comparisons use BigInt (task amounts are strings
// that may exceed Number precision).
//
// Circuit alignment (verified empirically against gatekeeper.wasm/zkey — see
// scripts/probe-circuit.cjs):
//   * decision is binary: APPROVE (1) / REJECT (0). The circuit asserts
//     decision == (all five stateless checks pass). A proof can therefore
//     only be generated when the JS decision matches the stateless result
//     — see canProve().
//   * Expiry is STRICT: the circuit requires current_block < expiry_block.
//     current == expiry is EXPIRED (decision=1 fails the assert). The task
//     spec said "<=", the circuit enforces "<" — the circuit wins.
//   * Threshold is >= (balance == minimum approves), amount is <=
//     (amount == max approves). Both verified against the circuit.
//   * PROOF_REUSED is NOT a circuit check (there is no proof_tx input
//     signal). It is enforced here, in JS, against the disk-backed seen-set.
//     Per the event page, "PROOF_REUSED tasks have no proof to submit and
//     are excluded" — so a PROOF_REUSED answer carries proof: null.

export type Decision = "APPROVE" | "REJECT";

export type ReasonCode =
  | "VALID_CONDITION"
  | "VK_SUBSTITUTION"
  | "THRESHOLD_MISMATCH"
  | "PROOF_REUSED"
  | "EXPIRED_CONDITION"
  | "RECIPIENT_MISMATCH"
  | "AMOUNT_OVERFLOW"
  | "INVALID_TASK"; // envelope/timestamp malformed — no circuit proof possible

export interface TaskInput {
  registered_vk: string;
  proof_vk: string;
  minimum: string;
  public_balance: string;
  expiry_block: number;
  current_block: number;
  recipient: string;
  condition_recipient: string;
  amount: string;
  max_transfer: string;
  proof_tx: string;
}

export interface TaskEnvelope {
  type: string;
  task_id: string;
  mode?: string;
  issued_at?: string;
  deadline_at?: string;
  input: TaskInput;
}

export interface DecisionOutcome {
  decision: Decision;
  reason: ReasonCode;
  /**
   * True when the five stateless circuit checks all pass. The circuit
   * demands decision=1 exactly in this case, decision=0 otherwise.
   */
  statelessPass: boolean;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
// proof_tx is NOT a circuit input (seen-set key only), so accept both the
// 32-byte tx-hash form and the 16-byte UUID form the platform uses for
// practice tasks (0x + 32 hex, i.e. a UUID without dashes).
const HEX16 = /^0x[0-9a-fA-F]{32}$/;
// Verification keys: the platform may send a 20-byte address OR a 32-byte
// hash. The circuit only checks equality of the two vk hashes, so either
// form works as long as the mapping (hashVk) is consistent.
const isAddrOrHash = (v: string): boolean => HEX20.test(v) || HEX32.test(v);

function invalid(): DecisionOutcome {
  return { decision: "REJECT", reason: "INVALID_TASK", statelessPass: false };
}

export function decide(
  task: TaskEnvelope,
  proofSeen: (proofTx: string) => boolean,
  now: Date = new Date(),
): DecisionOutcome {
  // (a) Envelope + timestamp validity. Fail closed on anything malformed.
  if (!task || typeof task !== "object") return invalid();
  if (task.type !== "agent-games.proof-gatekeeper.v1") return invalid();
  if (!task.task_id || typeof task.task_id !== "string") return invalid();
  const input = task.input;
  if (!input || typeof input !== "object") return invalid();
  const strFields = [
    "registered_vk",
    "proof_vk",
    "minimum",
    "public_balance",
    "recipient",
    "condition_recipient",
    "amount",
    "max_transfer",
    "proof_tx",
  ] as const;
  for (const f of strFields) {
    const v = (input as unknown as Record<string, unknown>)[f];
    if (typeof v !== "string" || v.length === 0) return invalid();
  }
  if (!Number.isInteger(input.expiry_block) || !Number.isInteger(input.current_block)) {
    return invalid();
  }
  let minimum: bigint;
  let publicBalance: bigint;
  let amount: bigint;
  let maxTransfer: bigint;
  try {
    minimum = BigInt(input.minimum);
    publicBalance = BigInt(input.public_balance);
    amount = BigInt(input.amount);
    maxTransfer = BigInt(input.max_transfer);
  } catch {
    return invalid();
  }
  if (minimum < 0n || publicBalance < 0n || amount < 0n || maxTransfer < 0n) {
    return invalid();
  }
  if (
    !isAddrOrHash(input.registered_vk) ||
    !isAddrOrHash(input.proof_vk) ||
    !HEX20.test(input.recipient) ||
    !HEX20.test(input.condition_recipient)
  ) {
    return invalid();
  }
  if (!HEX32.test(input.proof_tx) && !HEX16.test(input.proof_tx)) return invalid();
  if (task.issued_at) {
    const issued = new Date(task.issued_at).getTime();
    if (Number.isNaN(issued) || issued > now.getTime() + CLOCK_SKEW_MS) return invalid();
  }
  if (task.deadline_at) {
    const deadline = new Date(task.deadline_at).getTime();
    if (Number.isNaN(deadline) || deadline <= now.getTime()) return invalid();
  }

  // (b) Verification-key substitution.
  if (input.proof_vk.toLowerCase() !== input.registered_vk.toLowerCase()) {
    return { decision: "REJECT", reason: "VK_SUBSTITUTION", statelessPass: false };
  }
  // (c) Threshold mismatch.
  if (publicBalance < minimum) {
    return { decision: "REJECT", reason: "THRESHOLD_MISMATCH", statelessPass: false };
  }
  // (d) Recipient mismatch.
  if (input.recipient.toLowerCase() !== input.condition_recipient.toLowerCase()) {
    return { decision: "REJECT", reason: "RECIPIENT_MISMATCH", statelessPass: false };
  }
  // (e) Amount overflow.
  if (amount > maxTransfer) {
    return { decision: "REJECT", reason: "AMOUNT_OVERFLOW", statelessPass: false };
  }
  // (f) Expired condition — STRICT: current must be < expiry (circuit rule).
  if (input.current_block >= input.expiry_block) {
    return { decision: "REJECT", reason: "EXPIRED_CONDITION", statelessPass: false };
  }
  // (g) Proof reuse — stateful, local seen-set of previously ACCEPTED proofs.
  if (proofSeen(input.proof_tx.toLowerCase())) {
    return { decision: "REJECT", reason: "PROOF_REUSED", statelessPass: true };
  }
  // (h) Valid condition.
  return { decision: "APPROVE", reason: "VALID_CONDITION", statelessPass: true };
}

/**
 * Whether a Groth16 proof can be generated for this outcome. The circuit
 * asserts decision == statelessPass, so a proof exists iff the JS decision
 * matches the stateless result — and the task is well-formed enough to build
 * circuit inputs for (INVALID_TASK has no usable inputs).
 */
export function canProve(outcome: DecisionOutcome): boolean {
  if (outcome.reason === "INVALID_TASK") return false;
  return (outcome.decision === "APPROVE") === outcome.statelessPass;
}
