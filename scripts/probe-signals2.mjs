// Round 2: hunt the 3 missing input signals (13 total, 10 found in round 1).
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
  return "0".repeat(16 - shash.length) + shash;
}

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);
const known = new Set(["minimum","publicBalance","expiryBlock","currentBlock","recipient","conditionRecipient","amount","maxTransfer","taskId","decision"]);

const candidates = [
  // VK variants
  "vk","vk1","vk2","vkA","vkB","regVk","reg_vk","registeredVK","registeredVkHash","registered_vk_hash",
  "expectedVk","expected_vk","conditionVk","condition_vk","targetVk","requiredVk","knownVk",
  "givenVk","actualVk","submittedVk","providedVk","proofVK","proofVkHash","proof_vk_hash",
  "vkProof","vk_proof","vkRegistered","vk_registered","vkExpected","vk_expected","vkCondition",
  "vk_condition","vkTarget","vkRequired","verificationKey","verification_key","registeredKey",
  "proofKey","vkReg","vkSub","subVk","condVk","expVk","reqVk","vkHashRegistered","vkHashProof",
  "registeredVkDigest","proofVkDigest","vkDigest","expectedVkHash","actualVkHash",
  "vkRegisteredHash","vkProofHash","conditionVkHash","proofVk_hash","registeredVk_hash",
  "vk1Hash","vk2Hash","vkAHash","vkBHash","firstVk","secondVk","vkOne","vkTwo",
  // reason-code variants
  "reasonNum","reason_num","trapCode","trap_code","errorCode","error_code","rejectReason",
  "reject_reason","decisionReason","decision_reason","rc","status","statusCode","status_code",
  "reasonOut","reason_out","outcomeCode","outcome_code","resultCode","result_code","codeNum",
  "reasonId","reason_id","trapId","trap_id","decisionCode","decision_code","reasonValue",
  "reason_value","rejectCode","reject_code","failReason","fail_reason","verdict","verdictCode",
  "verdict_code","decisionReasonCode","reasonCodeHash","reasonCodeNum","why","whyCode",
  // proof_tx variants
  "proofTxHash","proof_tx_hash","proofRef","proof_ref","proofReference","proof_reference",
  "ref","txHash","tx_hash","proofId","proof_id","tx","txId","tx_id","proofTxId","proofTxRef",
  // arrays / combined
  "vks","keys","vkPair","vk_pair","inputsHash","taskData","task_data","payload","payloadHash",
  "payload_hash","condition","conditionHash","condition_hash","payment","paymentHash",
  // misc
  "nonce","salt","commitment","commitmentHash","stateHash","taskHash2","deadline","deadlineBlock",
  "deadline_block","blockNumber","block_number","now","timestamp","time","expiry","isExpired",
  "reused","isReused","seen","seenProof","seen_proof","proofSeen","proof_seen","used",
  "isUsed","alreadyUsed","already_used","duplicate","isDuplicate","is_duplicate",
  // control: definitely absent
  "zzzzqqqq_nonexistent_12345",
];
const found = [];
for (const name of candidates) {
  const h = fnvHash(name);
  const hMSB = parseInt(h.slice(0, 8), 16);
  const hLSB = parseInt(h.slice(8, 16), 16);
  const size = wc.instance.exports.getInputSignalSize(hMSB, hLSB);
  if (typeof size === "number" && size > 0) {
    found.push({ name, size });
    console.log(`FOUND  ${name}  (array size ${size})`);
  }
}
console.log("\nRound-2 found:", found.length, "new signals.");
console.log("Known 10 + new:", 10 + found.length, "of 13 total input slots.");
