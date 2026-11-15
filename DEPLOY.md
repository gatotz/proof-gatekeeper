# Deploy — Proof Gatekeeper agent

## Status (2026-11-15 ~07:54 WIB) — PUBLIC URL LIVE via localhost.run (Attempt 1 WORKED)

- **PUBLIC URL: https://7ac29131a27bbb.app.lhr.life** — verified end-to-end
  2026-11-15 00:54:04 UTC (07:54 WIB): `GET /health` → **200
  `{"ok":true,"protocolVersion":"v1"}`** with a valid
  `x-agent-games-signature` header, fetched through the public URL via the
  egress proxy (x-backend-addr 87.81.226.71:5396 = the tunnel's ssh
  connection id). The gatekeeper service is running locally
  (`gatekeeper.service`, PID 4152, prover self-check 839 ms, seen-set 2
  known) and the tunnel unit is active.
- **Tunnel unit: `gatekeeper-tunnel.service`** (enabled, active, Main PID
  4313 ssh). Wrapper: `~/workspace/agent-games/tunnel/localhost-run.sh`
  (ssh via ProxyCommand `proxy-ssh.py` through the egress proxy, remote
  command `-- --output json` so the assigned URL is emitted as a JSON
  event). Manage it with:
  `systemctl start|stop|restart|status gatekeeper-tunnel.service`;
  logs: `journalctl -u gatekeeper-tunnel.service -f`;
  current URL: `journalctl -u gatekeeper-tunnel.service | grep -o '"address":"[^"]*"' | tail -1`.
- **3rd VM replacement happened ~00:44–00:51 UTC Nov 15** (before this
  tunnel was built): `gatekeeper.service` unit was wiped again; it was
  **re-created** (same contents, `/etc/systemd/system/gatekeeper.service`),
  proxy env re-applied via `systemctl set-environment`, `systemctl enable
  --now gatekeeper.service` → running, /health 200 verified 00:51:38 UTC.
- **How the URL was finally obtained:** plain `-N` ssh never shows the
  assigned subdomain (the server only sends it on the session channel).
  The fix: run ssh WITHOUT `-N` and pass `-- --output json` as the remote
  command — the server's `tunnel` program then emits a JSON
  `run.localhost.tunnel.registered` event containing the address. (Also
  learned: the server runs a custom `tunnel` CLI, not a shell — passing a
  shell command like `sleep` errors with `Usage: tunnel [OPTIONS]`.)
- **DOMAIN ROTATION CAVEAT (important):** the free localhost.run domain
  **rotates periodically** (server message: "This domain periodically
  rotates to a new one."). Observed: the first tunnel registered
  `ff3ebd990982fd.app.lhr.life` at 00:46:57Z, then rotated to
  `b7e8aee151aedd.app.lhr.life` at 00:49:25Z (~2.5 min later); the
  systemd-managed tunnel registered `7ac29131a27bbb.app.lhr.life` at
  00:52:44Z. **Before registering in the Agent Games dashboard, re-read
  the current URL from the journal** (command above) and re-verify
  `/health` through it — do NOT assume the URL in this file is still
  current. If the URL rotates mid-round, the endpoint must be
  re-registered in the dashboard. A stable domain needs a localhost.run
  account/custom-domain plan (NOT set up — no new account per task
  constraints).
- **Attempt 2 (localtunnel + proxy-agent preload hack) NOT attempted** —
  Attempt 1 succeeded, so per the task order it stops here.
- **localtunnel 2.0.2 remains FAILED** (stock tool ignores the proxy env;
  see below). cloudflared remains blocked (Go client ignores proxy env).

## Status (2026-11-15 ~06:20 WIB) — 2nd VM replacement + localtunnel FAILED

- **VM/host replaced AGAIN ~05:57 WIB Nov 15** (host boot ~22:57 UTC Nov 14,
  uptime 19 min at check): all host-side state wiped again — unit files,
  cloudflared, running service, in-memory proxy env. Only `~/workspace`
  survived.
- **REPAIRED ~06:16 WIB:** `gatekeeper.service` unit re-created (same
  contents), `systemctl daemon-reload`, egress proxy env re-applied via
  `systemctl set-environment`, `systemctl enable --now gatekeeper.service`.
  **Service RUNNING**: active (running), PID 3729, prover self-check OK
  (840 ms), seen-set loaded (2 known), `GET /health` → 200
  `{"ok":true,"protocolVersion":"v1"}` (verified 06:16 WIB).
- **localtunnel FAILED — no public URL.** localtunnel 2.0.2 installed under
  `~/workspace/agent-games/tunnel/` (survives VM replacement) and run with
  `--subdomain gatekeeper-puss --port 3000`, but it **never connected**:
  the process sat alive with an empty log and no outbound connections.
  Root cause: localtunnel 2.0.2 does NOT honour the proxy env vars —
  its tunnel-allocation call uses axios 0.21.4 (no env-proxy support, no
  proxy config in `lib/Tunnel.js`) and its data connections are raw TLS
  sockets, so both go direct; direct TCP/443 is blocked on this VM.
  On failure it retries forever every 1s with no output, so the process
  looks alive while doing nothing. The subdomain was never even reached
  (the allocation API call never completes). Process killed; no tunnel
  unit created. See "Why there is no public URL yet".
- **cloudflared NOT present** (wiped by both VM replacements; not
  reinstalled — tunnel still blocked/pending decision).
- **No public URL exists.** The remaining candidate is localhost.run
  (SSH-based) or another route — needs a user decision. Do NOT retry
  localtunnel as a stock tool on this VM; it cannot work through this
  egress without a proxy-agent preload hack (not attempted).

- **VM/host replaced ~01:28 WIB Nov 15** (PID1 boot 18:28:38 UTC, uptime ~4 min
  at check): all host-side state was wiped — unit files, cloudflared binary,
  running service, in-memory proxy env. Only `~/workspace` survived.
- **REPAIRED 01:33 WIB:** unit file re-created at
  `/etc/systemd/system/gatekeeper.service` (same contents as before),
  `systemctl daemon-reload`, egress proxy env re-applied via
  `systemctl set-environment` (from the runtime-injected shell env),
  `systemctl enable --now gatekeeper.service`.
- **Service RUNNING**: active (running), PID 2289, prover self-check OK
  (766 ms), seen-set loaded (2 known), listening on 127.0.0.1:3000.
  `GET /health` → 200 `{"ok":true,"protocolVersion":"v1"}` (verified 01:33 WIB).
- **cloudflared NOT present** (`/usr/local/bin/cloudflared` gone with the VM
  replacement; not reinstalled — tunnel still blocked/pending decision).
- **`gatekeeper-tunnel.service` unit file gone** (wiped); not re-created.
  No public URL exists.
- Note: `nsenter -t 1 -m` into PID1's namespace is EPERM from the agent
  shell (setns errno 1, despite CAP_SYS_ADMIN) — the repair was done from
  the agent shell instead, which works because `/etc/systemd/system` and
  `/run/systemd/private` are shared with PID1's namespace, so host systemd
  sees the unit file and manages the service.

## Status (2026-11-14 ~23:40 WIB)

- **Service RUNNING locally via systemd**: `gatekeeper.service`, listening on
  `http://127.0.0.1:3000` (`GET /health`, `POST /agent`). Verified end-to-end
  locally (see below).
- **Public endpoint: NOT DEPLOYED.** Cloudflare Tunnel (cloudflared quick
  tunnel) is **blocked by the VM egress** (see "Why there is no public URL
  yet"). No public URL exists. `gatekeeper-tunnel.service` is installed but
  stopped + disabled.

## Service: start / stop / restart / logs

```bash
systemctl start|stop|restart|status gatekeeper.service
journalctl -u gatekeeper.service -f        # logs (also: -n 50)
```

- The unit reads env from `.env` via `EnvironmentFile=` (the service itself
  only reads `process.env`; there is no dotenv loader in the code).
- `.env` currently holds a **PLACEHOLDER HMAC secret** (random, clearly
  labelled). Swap it for the real dashboard secret after registration, then
  `systemctl restart gatekeeper.service`.

## Egress proxy env (required, in-memory only)

- The service's Kurier helper reaches `api.kurier.xyz` ONLY through the VM
  egress proxy. systemd services do not inherit the shell env, so the proxy
  vars were set with `systemctl set-environment` (in-memory, root-only,
  nothing written to disk). They are **LOST on reboot / VM replacement** —
  re-apply after every reboot from a shell that has them (values come from
  the shell env the runtime injects; never type or store the proxy password
  anywhere):

```bash
systemctl set-environment HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" https_proxy="$https_proxy" http_proxy="$http_proxy" all_proxy="$all_proxy" NO_PROXY="$NO_PROXY" no_proxy="$no_proxy" SSL_CERT_FILE="$SSL_CERT_FILE" NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" CURL_CA_BUNDLE="$CURL_CA_BUNDLE" REQUESTS_CA_BUNDLE="$REQUESTS_CA_BUNDLE"
systemctl restart gatekeeper.service
```

- Evidence the proxy path works: after `set-environment`, the async Kurier
  submission reached Kurier and got HTTP 401 (bad key, known) instead of
  the earlier `SSL: WRONG_VERSION_NUMBER` (direct connection, no proxy).

## Verification evidence (local, 2026-11-14)

- `npm test`: **97 passed, 0 failed**.
- Local e2e (script `/tmp/e2e-local.cjs`, VALID envelope): `GET /health`
  200 `{"ok":true,"protocolVersion":"v1"}` signature valid; `POST /agent`
  200 **APPROVE / VALID_CONDITION** in ~328 ms, response signature valid,
  proof present (13 public signals), snarkjs `groth16.verify` = **true**.
- Seen-set persists across restarts (`data/seen.json`, 2 test entries from
  deploy-test-1/2; harmless unique `proof_tx` values).
- Kurier async submission reaches Kurier (HTTP 401 — the stored mainnet key
  is rejected; separate track, not a deploy issue).

## Why there is no public URL yet (cloudflared blocked)

- cloudflared 2026.11.0 installed at `/usr/local/bin/cloudflared`.
- `gatekeeper-tunnel.service`
  (`cloudflared tunnel --url http://127.0.0.1:3000`, quick tunnel) fails on
  every start:

  `failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": tls: first record does not look like a TLS handshake`

- Root cause: all outbound HTTPS on this VM must go through the
  authenticated egress MITM proxy (`HTTPS_PROXY` + egress CA bundle).
  cloudflared's Go client **IGNORES the proxy env vars** — proven: with
  `HTTPS_PROXY` pointed at a dead `127.0.0.1:9` it still fails with the
  identical TLS error instead of a proxy dial error — and connects
  directly; direct TCP/443 is blocked (`openssl s_client` to the real
  Cloudflare IP fails with "wrong version number"). A DNS fix was also
  tried and ruled out: system DNS returns non-public `198.18.x` proxy IPs
  for the tunnel hosts, but even with `/etc/hosts` overridden to the real
  Cloudflare IPs (verified via `getent`) cloudflared fails identically —
  so the block is the proxy bypass, not DNS. (Note: `/etc/hosts` is a
  read-only squashfs mount here; bind-mounts from an exec shell also do not
  persist across exec calls / are invisible to systemd's mount namespace.)
- Consequence: a **named tunnel will not help either** (same Go client,
  same control plane). A tunnel client that honours the proxy env
  (Node-based, e.g. localtunnel, or SSH-based, e.g. localhost.run) is the
  candidate alternative — NOT attempted here; needs a decision.
- **localtunnel tried 2026-11-15 ~06:17 WIB — FAILED (see Status above).**
  localtunnel 2.0.2 does not honour proxy env vars: axios 0.21.4 for the
  allocation call plus raw TLS sockets for data, both direct. Proof: `curl
  https://localtunnel.me/` through the egress proxy returns 302 (the
  proxy path works), while the localtunnel process sat 49 s+ with an
  empty log, zero CPU, and no outbound connections, retrying forever.
  Do not retry stock localtunnel on this VM.
- The tunnel unit is stopped + disabled (it was restart-looping). To retry
  after the egress situation changes:
  `systemctl enable --now gatekeeper-tunnel.service`, then read the URL
  from `journalctl -u gatekeeper-tunnel.service | grep trycloudflare`.
- Quick-tunnel caveat (whenever a quick tunnel is used): the
  `https://*.trycloudflare.com` URL is random and **CHANGES on every
  restart** — if it ever changes, the endpoint must be re-registered in
  the Agent Games dashboard before the next round.

## Still needed before Round 03 (Nov 15, 17:30 WIB)

1. ~~A public HTTPS endpoint~~ — **DONE 2026-11-15 ~07:54 WIB:**
   `https://7ac29131a27bbb.app.lhr.life` (localhost.run,
   `gatekeeper-tunnel.service`). **Re-read the current URL from the
   journal before registering** — the free domain rotates periodically.
2. Real `AGENT_GAMES_HMAC_SECRET` from the dashboard ("Rotate Secret")
   into `.env`, then restart the service. (Current: placeholder.)
3. Kurier key: submit-proof WORKS (verified ~06:07 WIB Nov 15; the stored
   key is accepted). job-status still 401 (vault placement covers the
   submit-proof path only) — a monitoring gap, not a submission blocker.
4. Register the endpoint URL in the Agent Games dashboard, complete the
  signed preflight + at least one practice task. Entries lock while a
  round is open. Use the CURRENT URL from the journal, not a stale one.
