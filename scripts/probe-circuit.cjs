// Empirical probe of the gatekeeper circuit semantics.
// The witness calculation SUCCEEDS iff the inputs satisfy the circuit's
// constraints, so we use it as an oracle to learn:
//   - the decision encoding (0/1 = approve/reject?)
//   - whether each trap check is actually enforced by the circuit
//   - whether `salt` is constrained
//   - the order of the 13 public signals in the witness
const snarkjs = require("snarkjs");
const { keccak256 } = require("js-sha3");
const fs = require("fs");
const path = require("path");

const WASM = path.join(__dirname, "..", "circuits", "gatekeeper.wasm");
const ZKEY = path.join(__dirname, "..", "circuits", "gatekeeper_final.zkey");
const VK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "circuits", "gatekeeper_vk.json"), "utf8"));

// BN128 field prime (snarkjs / circom bn128)
const PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

function hexToBigInt(hex) {
  return BigInt(hex.startsWith("0x") ? hex : "0x" + hex);
}
// vkHash hypothesis: keccak256 of the raw 20-byte address, reduced mod p.
function hashVk(vkHex) {
  const bytes = Buffer.from(vkHex.replace(/^0x/, ""), "hex");
  const digest = keccak256(bytes); // hex string
  return (BigInt("0x" + digest) % PRIME).toString();
}
// taskId hypothesis: UTF-8 bytes of the task id string as a big-endian integer.
function taskIdToField(taskId) {
  return BigInt("0x" + Buffer.from(taskId, "utf8").toString("hex")).toString();
}

const A = "0x7d3a00000000000000000000000000000000f291";
const B = "0xa4c100000000000000000000000000000000b8ff";
const RECIP = "0xDe42000000000000000000000000000000009f01";
const OTHER = "0x1111000000000000000000000000000000002222";

function baseInput() {
  return {
    minimum: "1000",
    publicBalance: "1460",
    expiryBlock: "19842201",
    currentBlock: "19832000",
    recipient: hexToBigInt(RECIP).toString(),
    conditionRecipient: hexToBigInt(RECIP).toString(),
    amount: "500",
    maxTransfer: "1000",
    taskId: taskIdToField("gk_24_9d1"),
    decision: "1",
    registeredVkHash: hashVk(A),
    proofVkHash: hashVk(A),
    salt: "0",
  };
}

async function tryProve(label, input) {
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
    console.log(`[PASS witness] ${label} | groth16.verify=${ok} | publicSignals=${JSON.stringify(publicSignals)}`);
    return { ok: true, publicSignals, proof };
  } catch (e) {
    console.log(`[FAIL witness] ${label} | ${String(e.message || e).split("\n")[0]}`);
    return { ok: false };
  }
}

(async () => {
  console.log("--- public-signal order probe (VALID case, decision=1, salt=0) ---");
  const valid = baseInput();
  const r = await tryProve("VALID decision=1 salt=0", valid);
  if (r.ok) {
    console.log("input values for reference:");
    for (const [k, v] of Object.entries(valid)) console.log(`  ${k} = ${v}`);
  }
  console.log("--- decision encoding ---");
  await tryProve("VALID decision=0 salt=0", { ...baseInput(), decision: "0" });
  console.log("--- salt ---");
  await tryProve("VALID decision=1 salt=12345", { ...baseInput(), salt: "12345" });
  await tryProve("VALID decision=1 salt=999999999", { ...baseInput(), salt: "999999999" });
  console.log("--- traps (decision=0 expected to satisfy, decision=1 expected to fail) ---");
  await tryProve("VK_SUBSTITUTION decision=0", { ...baseInput(), proofVkHash: hashVk(B), decision: "0" });
  await tryProve("VK_SUBSTITUTION decision=1", { ...baseInput(), proofVkHash: hashVk(B), decision: "1" });
  await tryProve("THRESHOLD decision=0", { ...baseInput(), publicBalance: "999", decision: "0" });
  await tryProve("THRESHOLD decision=1", { ...baseInput(), publicBalance: "999", decision: "1" });
  await tryProve("RECIPIENT decision=0", { ...baseInput(), recipient: hexToBigInt(OTHER).toString(), decision: "0" });
  await tryProve("AMOUNT decision=0", { ...baseInput(), amount: "1001", decision: "0" });
  await tryProve("EXPIRED decision=0", { ...baseInput(), currentBlock: "19842202", decision: "0" });
  await tryProve("EXPIRED boundary current==expiry decision=1", { ...baseInput(), currentBlock: "19842201", decision: "1" });
  await tryProve("THRESHOLD boundary balance==minimum decision=1", { ...baseInput(), publicBalance: "1000", decision: "1" });
  await tryProve("AMOUNT boundary amount==max decision=1", { ...baseInput(), amount: "1000", decision: "1" });
})().catch((e) => { console.error(e); process.exit(1); });
