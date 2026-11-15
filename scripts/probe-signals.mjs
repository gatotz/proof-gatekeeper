// Dev tool: discover the gatekeeper circuit's input signal names by probing
// the wasm with FNV-1a hashes of candidate names.
// getInputSignalSize(hash) returns -1 when the signal does not exist,
// otherwise the array size of that input signal.
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt("0xCBF29CE484222325");
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= BigInt("0x100000001B3");
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  shash = "0".repeat(16 - shash.length) + shash;
  return shash;
}

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);
console.log("circom version:", wc.circom_version());
console.log("witness size:", wc.witnessSize);
console.log("total input signals (getInputSize):", wc.instance.exports.getInputSize());

const candidates = [
  // task fields, snake_case (as in the event-page payload)
  "registered_vk","proof_vk","minimum","public_balance","expiry_block","current_block",
  "recipient","condition_recipient","amount","max_transfer","proof_tx","task_id",
  "issued_at","deadline_at","type","mode",
  // task fields, camelCase
  "registeredVk","proofVk","publicBalance","expiryBlock","currentBlock",
  "conditionRecipient","maxTransfer","proofTx","taskId","issuedAt","deadlineAt",
  // decision / outcome
  "decision","reason_code","reasonCode","reason","approved","isApproved","approve",
  "reject","valid","isValid","is_valid","outcome","result","flag","check","passed",
  // hashes
  "task_hash","taskHash","input_hash","inputHash","public_inputs_hash","publicInputsHash",
  "vk_hash","vkHash","proof_hash","proofHash","hash",
  // boolean check flags
  "vkMatch","vk_match","thresholdOk","threshold_ok","recipientMatch","recipient_match",
  "amountOk","amount_ok","notExpired","not_expired","notReused","not_reused",
  "is_reused","is_expired","is_valid_condition","validCondition","valid_condition",
  // generic / numbered
  "in","inputs","input","a","b","c","x","y","out","main","signal","value",
  ...Array.from({length: 20}, (_, i) => `in${i}`),
  ...Array.from({length: 14}, (_, i) => `input${i}`),
  ...Array.from({length: 14}, (_, i) => `signal${i}`),
  "gatekeeper","gatekeeperDecision","decisionValid","decision_out","code","trap","trapType",
];

const found = [];
for (const name of candidates) {
  const h = fnvHash(name);
  const hMSB = parseInt(h.slice(0, 8), 16);
  const hLSB = parseInt(h.slice(8, 16), 16);
  let size;
  try {
    size = wc.instance.exports.getInputSignalSize(hMSB, hLSB);
  } catch (e) {
    size = "ERR:" + e.message;
  }
  if (typeof size === "number" && size >= 0) {
    found.push({ name, size });
    console.log(`FOUND  ${name}  (array size ${size})`);
  }
}
console.log("\nFound", found.length, "of", candidates.length, "candidates.");
console.log("Total input slots expected:", wc.instance.exports.getInputSize());
console.log("Sum of found array sizes:", found.reduce((s, f) => s + f.size, 0));
