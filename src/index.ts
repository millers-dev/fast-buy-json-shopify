import { pathToFileURL } from "node:url";

import { loadConfig, loadShopifyAuth, orderAddressGateEnabled, readPort } from "./config.js";
import { DEFAULT_PORT, createConnectorServer, listen } from "./server.js";
import { openConnector } from "./startup.js";
import { readPackageMetadata } from "./version.js";

export function start(env: NodeJS.ProcessEnv = process.env): void {
  const metadata = readPackageMetadata();
  const config = loadConfig(env, metadata.version);
  const port = readPort(env, DEFAULT_PORT);
  const auth = loadShopifyAuth(env);
  const orderAddressGate = orderAddressGateEnabled(env.SHOPIFY_ORDER_ADDRESS_GATE);
  void boot(config, port, auth, orderAddressGate).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed to start");
    process.exit(1);
  });
}

async function boot(
  config: ReturnType<typeof loadConfig>,
  port: number,
  auth: ReturnType<typeof loadShopifyAuth>,
  orderAddressGate: boolean,
): Promise<void> {
  const deps = auth === undefined ? undefined : await openConnector(auth);
  if (deps !== undefined) {
    deps.orderAddressGate = orderAddressGate;
  }
  const server = createConnectorServer(config, deps);
  const bound = await listen(server, port);
  const shop = config.shopDomain ?? "unset";
  const mode = authMode(auth);
  console.log(
    `FastBuyJSON Shopify connector at http://localhost:${bound}/api/fastbuyjson/detect (shop ${shop}, ${mode})`,
  );
}

function authMode(auth: ReturnType<typeof loadShopifyAuth>): string {
  if (auth === undefined) {
    return "detect-only";
  }
  if (auth.appUrl === undefined) {
    return "client-credentials";
  }
  return "authorization-code";
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  try {
    start();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "invalid configuration";
    console.error(message);
    process.exit(1);
  }
}
