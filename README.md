# Agent Games — Proof Gatekeeper agent

TypeScript/Node.js service that plays the **Proof Gatekeeper** track of the
Agent Games (zkVerify) tournament. It receives signed task envelopes on a
public HTTPS endpoint, decides **APPROVE / REJECT** deterministically (no
LLM), proves the decision with a local Groth16 proof (snarkjs), and submits
the proof to zkVerify via the Kurier connector helper.

**Status: built and tested locally. NOT deployed. No accounts created, no
secrets stored, no wallet connected, no signatures made.**

- Project: `~/workspace/agent-games/gatekeeper/`
- Harness: `npm test` — **97 checks, all green** (see "What was tested").

## How to run locally

```bash
cd ~/workspace/agent-games/gatekeeper
npm install
cp .env.example .env   # then fill in AGENT_GAMES_HMAC_SECRET (never commit .env)
npm run build
npm start              # listens on $HOST:$PORT (default 127.0.0.1:3000)
```

On startup the service runs a **prover self-check** (generates + verifies a
dummy VALID proof, ~1s) and refuses to start if it fails. It also loads the
disk-backed seen-set (`data/seen.json`); if that file exists but is corrupt
JSON, it refuses to start (a lost seen-set would blind PROOF_REUSED
detection).

```bash
npm test               # build + full harness (needs ~10s, exits 0 on green)
```

### Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/health` (or `/`) | Preflight: `{ ok: true, protocolVersion: "v1" }`, HMAC-signed. |
| `POST` | `/agent` | Task envelope. HMAC verified on the **raw body before parsing**. Returns the signed decision (below). A POST whose `type` is `agent-games.preflight.v1` gets the preflight answer. |

### Response shape

```json
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof": { "pi_a": [...], "pi_b": [[...], [...]], "pi_c": [...], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 decimal strings>"],
  "proof_tx": "0x...",
  "task_id": "gk_24_9d1"
}
```

For `PROOF_REUSED` (and malformed tasks) `proof` is `null` and
`public_signals` is `[]` — see "Why some answers carry no proof". Every
response carries `x-agent-games-signature` (HMAC-SHA256 over the raw
response body).

### Environment

| Variable | Required | Default |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | **yes** | — (server refuses to start without it) |
| `PORT` / `HOST` | no | `3000` / `127.0.0.1` |
| `CIRCUITS_DIR` | no | `<project>/circuits` |
| `SEEN_FILE` | no | `<project>/data/seen.json` |
| `KURIER_HELPER_PATH` | no | `~/workspace/custom-connectors/custom.kurier/bin/kurier.py` |
| `GATEKEEPER_VK_HASH` | no | `0x6b79c6…77b0` (gatekeeper) |
| `PROVE_TIMEOUT_MS` | no | `50000` |

**No Kurier API key is configured here, ever.** Proof submission shells out
to the Kurier connector helper, which owns the vault credential
(`custom.kurier`). This service never sees, passes, or logs any API key.

## Decision logic → the 7 traps

`src/decision.ts` is a pure function. Checks run in this order; the first
failing check decides the `reason_code`. All amount comparisons use BigInt.

| # | Check (in order) | Fail → reason | Circuit? |
|---|---|---|---|
| (a) | Envelope + timestamp valid: `type` is `agent-games.proof-gatekeeper.v1`, all fields present and well-formed (20-byte hex VKs/addresses, 32-byte hex `proof_tx`, numeric amounts), `issued_at` not in the future (+5 min skew), `deadline_at` still in the future | `INVALID_TASK` | No — JS only |
| (b) | `proof_vk == registered_vk` | `VK_SUBSTITUTION` | Yes |
| (c) | `public_balance >= minimum` | `THRESHOLD_MISMATCH` | Yes |
| (d) | `recipient == condition_recipient` | `RECIPIENT_MISMATCH` | Yes |
| (e) | `amount <= max_transfer` | `AMOUNT_OVERFLOW` | Yes |
| (f) | `current_block < expiry_block` (**strict**) | `EXPIRED_CONDITION` | Yes |
| (g) | `proof_tx` not in the local seen-set | `PROOF_REUSED` | No — JS + disk |
| (h) | otherwise | `VALID_CONDITION` → APPROVE | — |

**Expiry is strict.** The task spec said `current_block <= expiry_block`,
but the circuit was verified empirically to require `current_block <
expiry_block`: a task with `current == expiry` and `decision=1` fails the
circuit assert (`GatekeeperEvaluation` line 102). The JS follows the circuit
(the circuit is the referee).

**Boundaries verified against the circuit:** balance == minimum approves,
amount == max approves, current == expiry rejects.

## The circuit (what was reverse-engineered)

The official docs never published the circuit's input signals, so they were
discovered by probing the wasm (`scripts/probe-signals*.mjs`) and the
semantics were verified empirically with the witness calculator as an oracle
(`scripts/probe-circuit.cjs`, `scripts/probe-commitment.cjs`).

- Artifacts (in `circuits/`): `gatekeeper.wasm` (1,755,820 bytes,
  sha256 `be00aefe…92764f`), `gatekeeper_final.zkey` (309,750 bytes,
  sha256 `adfe95a4…af80d`), `gatekeeper_vk.json` (exported with snarkjs;
  Groth16/BN128, `nPublic = 13`). vkHash
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
  (from `/api/circuit-info`; already registered on mainnet).
- **13 input signals** (camelCase):
  `minimum, publicBalance, expiryBlock, currentBlock, recipient,
  conditionRecipient, amount, maxTransfer, taskId, decision,
  registeredVkHash, proofVkHash, salt`
- **decision encoding: `1` = APPROVE, `0` = REJECT.** The circuit asserts
  `decision == (all five stateless checks pass)` — a wrong decision fails
  witness generation, so no proof can be produced for it.
- **Public-signal order (13):**
  `[0]` commitment hash = H(taskId, salt) — computed by the circuit; it
  changes with `taskId` and with `salt`, and with nothing else (not with
  the decision, the VKs, or the amounts).
  `[1]` registeredVkHash, `[2]` proofVkHash, `[3]` minimum,
  `[4]` publicBalance, `[5]` expiryBlock, `[6]` currentBlock,
  `[7]` recipient, `[8]` conditionRecipient, `[9]` amount,
  `[10]` maxTransfer, `[11]` decision, `[12]` taskId.
  (`salt` itself is NOT a public signal — it is a private input that only
  feeds the commitment hash.)
- **salt = `"0"`** (deterministic default). Any salt value satisfies the
  circuit; `0` keeps proofs reproducible. See open question #5.
- **Proving takes ~0.3–1s per task** on this VM (measured in the harness),
  far inside the 60-second deadline. Proofs are generated sequentially
  (promise-chain queue) to bound memory.

### Field mappings (assumptions — see open questions)

- `hashVk(vk)` = **keccak256 of the raw 20-byte address, mod the BN128
  field prime** (`src/field.ts`). The circuit only checks *equality* of the
  two hash inputs, so any consistent mapping yields a *valid* proof.
- `taskIdToField(taskId)` = **UTF-8 bytes of the id as a big-endian
  integer** (fits the field for ids up to ~31 bytes).
- Addresses map to field elements directly (`BigInt(hex)`; 160-bit fits).

## Why some answers carry no proof

A proof exists iff the JS decision matches the circuit's stateless result
(`decision == statelessPass`). Two cases cannot be proven:

- **PROOF_REUSED** — all five stateless checks pass but the proof was
  already accepted. A `decision=0` proof would fail the circuit assert.
  The event page says exactly this: *"PROOF_REUSED tasks have no proof to
  submit and are excluded."* The answer carries `proof: null`.
- **INVALID_TASK / PROOF_FAILED** — malformed envelope (no usable circuit
  inputs), or proving timed out/failed. The service fails closed to REJECT
  with no proof. (If an APPROVE cannot be proven, the seen-set entry added
  for it is rolled back.)

The seen-set records a `proof_tx` **only when the decision is APPROVE**
(matching "already accepted in a previous task"), persists to
`data/seen.json` atomically (temp file + rename) on every add, and is
consulted before proving. The add happens synchronously in the same tick as
the decision, so a concurrent duplicate task is caught instead of
double-approving.

## Kurier submission (async, after responding)

1. The HTTP response is sent first (proving is ~1s; the 60s budget is for
   the local proof, not for chain finalisation).
2. Afterwards, fire-and-forget: `KurierClient.submitAndTrack()` shells out
   to the connector helper —
   `kurier.py submit-proof --proof <proof.json> --public-signals
   <public.json> --vk-hash <gatekeeper vkHash>` — with temp files that are
   deleted afterwards. The helper prints `{"http_status": N, "body": ...}`
   and exits 0 whenever the provider answered; the **HTTP status, not the
   exit code**, decides success.
3. On a 2xx with a job id, it polls `kurier.py job-status --job-id <id>`
   every 10s (up to 30 attempts) until the status reads `Finalized`.
   A 401 is logged once and **never retried** with the same key.

**Current blocker: the stored Kurier key is REJECTED (HTTP 401 on both
submit-proof and job-status). Live Kurier submission cannot be tested until
the mainnet key is re-entered.** The code path is tested end-to-end with a
stub helper (`test/stub-kurier.py`) in both the success and 401 modes.

## What was tested

`npm test` — **97 checks, all green** (`test/harness.ts`, spins up the real
server on an ephemeral port with a test secret, a temp seen-set, and the
stub Kurier helper):

- Preflight: `GET /health` returns `{ ok: true, protocolVersion: "v1" }`,
  HMAC-signed.
- Auth: wrong HMAC → 401; invalid JSON → 400 (both before any processing).
- Event-page sample (`gk_24_9d1`) → REJECT / `VK_SUBSTITUTION`, proof
  verifies with snarkjs, public signals in the expected order.
- VALID → APPROVE / `VALID_CONDITION`, proof verifies.
- All five stateless traps → correct REJECT + reason + verifying proof:
  `THRESHOLD_MISMATCH`, `RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`,
  `EXPIRED_CONDITION`.
- Boundaries: current == expiry → EXPIRED; balance == minimum → APPROVE;
  amount == max → APPROVE.
- `PROOF_REUSED`: second use of an accepted `proof_tx` (different task id)
  → REJECT / `PROOF_REUSED` with `proof: null`; the seen-set survives a
  reload from disk (3 approved proofs recorded).
- Kurier stub: `submit-proof` called with the gatekeeper vkHash after
  responses, `job-status` polled to `Finalized`.
- Kurier 401: `submitProof` reports 401 + `ok=false`; `submitAndTrack`
  logs the rejection once and does not retry-loop.
- Smoke test of the real entrypoint (`node dist/src/index.js`, placeholder
  secret): startup self-check OK in ~1s, `GET /health` 200 + valid
  signature, one VALID task → APPROVE with a verifying proof, Kurier stub
  invoked, seen-set written to disk.

## Open questions (to resolve with a practice task / the platform)

1. **vkHash / taskId mapping.** The circuit only checks equality of the two
   vk hashes, so our keccak256 mapping yields valid proofs — but if the
   platform recomputes `registeredVkHash` from the task's `registered_vk`
   with a different function (Poseidon? raw address as a field element?
   keccak of the hex string instead of the raw bytes?), our public signals
   won't match its expectation. Same for `taskId` (UTF-8-bytes-as-int here).
   Both live in the single functions `hashVk()` / `taskIdToField()` in
   `src/field.ts` so they can be swapped after the first practice task
   shows what the platform accepts.
2. **Response schema.** The event page sample shows
   `{ decision, reason_code, proof_tx }`; the starter prompt shows
   `{ decision, reason_code, proof, public_signals }`. We return a
   **superset** of both (plus `task_id`). If the platform does strict
   schema validation, trim to the exact shape it accepts after the first
   practice task.
3. **60s vs Finalized.** The build guide says a proof is only "safe to
   return as confirmed" once Finalized, but the response deadline is 60s
   and finalisation cannot fit inside it. Design decision: return the
   **locally generated proof within 60s**, submit to Kurier and poll to
   Finalized asynchronously afterwards. If the platform instead expects the
   response to wait for Finalized (or expects a `proofReference` to be
   filled in later), the flow must change.
4. **On-chain proof_tx confirmation.** There is no documented call for
   confirming `proof_tx` on-chain, or for checking whether a proof
   reference was already accepted on-chain (beyond our local seen-set).
   Currently reuse detection is local-only. The exact read (zkVerify
   aggregate / proof reference lookup) is still to be determined.
5. **Salt semantics.** `salt` is a private input feeding only public
   signal `[0]` (the commitment hash). We use `"0"`. If the platform
   expects a specific salt (e.g. a per-task nonce, or a random value it can
   reproduce), the commitment won't match its recomputation. A practice
   task will tell.
6. **HMAC format.** Assumed hex digest in `x-agent-games-signature`,
   optional `sha256=` prefix. The docs only say "HMAC over the raw body".
   Verify against a practice task; the format lives in `src/hmac.ts`.
7. **Preflight trigger.** Assumed `GET /health` (and `GET /`, and a POST
   envelope with `type: agent-games.preflight.v1`). The platform may use a
   different path/method — confirm at registration time.
8. **Kurier response fields.** The job id and job status are extracted
   tolerantly (`jobId`/`job_id`/`id`, `status`/`state`, case-insensitive
   `Finalized`). The real field names will be confirmed once a live
   submission succeeds (pending the corrected key).
9. **Starter prompt.** The official starter prompt text was not available
   in this build's context; the service was built from the task spec, the
   event page, and the build guide, plus the circuit reverse-engineering
   above. If the starter prompt specifies anything different (e.g. the
   exact preflight trigger or the salt), it overrides the assumptions here.
10. **Register-vk.** The vkHash is already registered on mainnet
    (per `/api/circuit-info` and the helper's `vkRegistered: true`), so no
    register-vk step is performed. If Kurier ever reports the vk as
    unknown, `kurier.py register-vk --vk circuits/gatekeeper_vk.json` is
    the recovery path.

## Next steps for deploy / register (exact, in order)

1. **Fix the Kurier key.** Re-enter the correct Kurier **mainnet** API key
   into the vault credential `custom.kurier` (the stored one returns 401).
   Then live-test submission: run the service, answer one practice task,
   and confirm the Kurier job reaches `Finalized` in the logs.
2. **Get the platform HMAC secret.** From the Agent Games dashboard
   ("Rotate Secret"). Put it in `.env` as `AGENT_GAMES_HMAC_SECRET` —
   never in chat, logs, or git.
3. **Run one practice task end-to-end** (the dashboard offers unscored
   practice tasks). Check: the HMAC verifies, the decision/reason match
   the trap, the proof verifies, the platform accepts the response shape,
   and the Kurier job finalises. Adjust open questions 1, 2, 5, 6 from
   what the practice round shows.
4. **Expose the service publicly over HTTPS.** The platform requires a
   public HTTPS endpoint with a passing health check. Options: a reverse
   proxy with TLS in front of this service, or a tunnel (e.g. Cloudflare
   Tunnel / cloudflared) pointing at `127.0.0.1:3000`. **Not done in this
   build — no tunnel, no systemd unit, no public URL was created.**
   Keep the process running (systemd unit / process manager) — it must be
   up during round windows (17:30–03:30 WIB) and stay up across restarts
   (the seen-set is on disk, so a restart is safe).
5. **Register the endpoint** in the Agent Games dashboard for Proof
   Gatekeeper, complete the signed preflight + at least one practice task.
   Entries lock while a round is open — register before the next round
   opens (rounds are daily 17:30–03:30 WIB; Round 03 is 15 Nov).
6. **Do not deploy before step 1–3 are green.** A wrong HMAC format or
   vk-hash mapping only shows up against the live platform; the practice
   round is the place to find out, not a scored round.

## Layout

```
circuits/                  gatekeeper.wasm / gatekeeper_final.zkey / gatekeeper_vk.json
src/
  config.ts                env loading, paths, defaults
  decision.ts              deterministic decision logic (the 7 traps)
  field.ts                 field conversions, hashVk, taskIdToField
  hmac.ts                  HMAC sign/verify (raw body)
  kurier.ts                Kurier helper client (submit + poll to Finalized)
  prover.ts                snarkjs fullProve/verify, self-check, input mapping
  seenStore.ts             disk-backed seen-set (atomic writes)
  server.ts                HTTP server: /agent, /health, 60s budget, fail-closed
  index.ts                 entrypoint (self-check, then listen)
  snarkjs.d.ts             minimal typings (snarkjs ships none)
test/
  harness.ts               97-check end-to-end harness (npm test)
  envelopes.ts             sample envelopes (VALID + 7 traps + boundaries)
  stub-kurier.py           fake kurier.py (success + 401 modes)
scripts/
  probe-signals*.mjs       how the 13 circuit input signals were discovered
  probe-circuit.cjs        empirical circuit semantics (decision, traps, boundaries)
  probe-commitment.cjs     public signal [0] = H(taskId, salt)
data/                      seen.json (runtime state; created on first run)
```
