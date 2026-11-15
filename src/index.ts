import { loadConfig } from "./config";
import { KurierClient } from "./kurier";
import { Prover } from "./prover";
import { SeenStore } from "./seenStore";
import { createServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const prover = new Prover(config.circuitsDir);
  const seen = SeenStore.load(config.seenFile);
  const kurier = new KurierClient(config.kurierHelperPath, config.vkHash, (m) =>
    console.log(m),
  );

  console.log(
    `[gatekeeper] starting — circuits=${config.circuitsDir} ` +
      `seen=${config.seenFile} (${seen.size()} known) kurier=${config.kurierHelperPath}`,
  );
  console.log("[gatekeeper] prover self-check (generating a dummy proof)...");
  const { ms } = await prover.selfCheck();
  console.log(`[gatekeeper] prover self-check OK in ${ms}ms`);

  const server = createServer(config, { prover, seen, kurier });
  server.listen(config.port, config.host, () => {
    console.log(
      `[gatekeeper] listening on http://${config.host}:${config.port} ` +
        `(POST /agent, GET /health)`,
    );
  });
}

main().catch((e: unknown) => {
  console.error(`[gatekeeper] fatal: ${String(e)}`);
  process.exit(1);
});
