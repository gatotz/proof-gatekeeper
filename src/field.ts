import { keccak256 } from "js-sha3";

// BN128 (alt_bn128) scalar-field prime — the field of the Groth16 circuit.
export const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

// Gatekeeper circuit vkHash (public value, registered on zkVerify mainnet).
// Source: https://agentgames.zkverify.io/api/circuit-info
export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

/** Hex string (0x-prefixed or bare) -> field element. Throws if it does not fit. */
export function hexToField(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error(`not hex: ${hex}`);
  const v = BigInt("0x" + h);
  if (v >= FIELD_PRIME) throw new Error(`value exceeds BN128 field: ${hex}`);
  return v;
}

/**
 * Verification-key -> vkHash.
 *
 * ASSUMPTION (see README, open question #1): keccak256 of the raw 20-byte
 * address, reduced mod the field prime. The circuit only checks EQUALITY of
 * the two hash inputs (registeredVkHash vs proofVkHash), so ANY consistent
 * mapping yields a *valid* Groth16 proof. What depends on this choice is the
 * platform's cross-check: if it recomputes the hash from the task's vk with
 * a different function, our public signals won't match its expectation.
 * Keep this function the single place the mapping lives so it can be swapped
 * (e.g. to Poseidon or to the raw address as a field element) after the
 * first practice task tells us what the platform expects.
 */
export function hashVk(vkHex: string): bigint {
  const bytes = Buffer.from(vkHex.replace(/^0x/, ""), "hex");
  if (bytes.length === 0) {
    throw new Error(`vk must be non-empty hex: ${vkHex}`);
  }
  return BigInt("0x" + keccak256(bytes)) % FIELD_PRIME;
}

/**
 * task_id string -> field element.
 *
 * ASSUMPTION (see README): the UTF-8 bytes of the task id, read as a
 * big-endian integer. Fits the field for ids up to ~31 bytes. As with
 * hashVk, the proof stays valid for any injective mapping; only a platform
 * cross-check could depend on the choice.
 */
export function taskIdToField(taskId: string): bigint {
  const v = BigInt("0x" + Buffer.from(taskId, "utf8").toString("hex"));
  if (v >= FIELD_PRIME) {
    throw new Error(`task_id too long to fit the field: ${taskId}`);
  }
  return v;
}
