// Does public signal [0] depend on taskId, salt, or both?
const snarkjs = require("snarkjs");
const { keccak256 } = require("js-sha3");
const fs = require("fs");
const path = require("path");
const WASM = path.join(__dirname, "..", "circuits", "gatekeeper.wasm");
const ZKEY = path.join(__dirname, "..", "circuits", "gatekeeper_final.zkey");
const PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
function hashVk(vkHex) {
  const bytes = Buffer.from(vkHex.replace(/^0x/, ""), "hex");
  return (BigInt("0x" + keccak256(bytes)) % PRIME).toString();
}
function taskIdToField(t) { return BigInt("0x" + Buffer.from(t, "utf8").toString("hex")).toString(); }
const A = "0x7d3a00000000000000000000000000000000f291";
const RECIP = "0xDe42000000000000000000000000000000009f01";
function input(taskId, salt) {
  return {
    minimum: "1000", publicBalance: "1460", expiryBlock: "19842201", currentBlock: "19832000",
    recipient: BigInt(RECIP).toString(), conditionRecipient: BigInt(RECIP).toString(),
    amount: "500", maxTransfer: "1000", taskId: taskIdToField(taskId), decision: "1",
    registeredVkHash: hashVk(A), proofVkHash: hashVk(A), salt: String(salt),
  };
}
(async () => {
  for (const [t, s] of [["gk_24_9d1", 0], ["gk_24_9d2", 0], ["gk_24_9d1", 7], ["other_task", 0]]) {
    const { publicSignals } = await snarkjs.groth16.fullProve(input(t, s), WASM, ZKEY);
    console.log(`taskId=${t} salt=${s} -> public[0]=${publicSignals[0]} public[12]=${publicSignals[12]}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
