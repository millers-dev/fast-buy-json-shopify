import { pathToFileURL } from "node:url";

import {
  customerAccountsEnabled,
  loadConfig,
  loadShopifyAuth,
  orderAddressGateEnabled,
  readCustomerSubSecret,
  readJwtSecret,
  readPort,
  readTrustedProxyHops,
} from "./config.js";
import type { ConnectorDeps } from "./deps.js";
import { DEFAULT_PORT, createConnectorServer, listen } from "./server.js";
import { openConnector } from "./startup.js";
import { readPackageMetadata } from "./version.js";

export function start(env: NodeJS.ProcessEnv = process.env): void {
  const metadata = readPackageMetadata();
  const config = loadConfig(env, metadata.version);
  const port = readPort(env, DEFAULT_PORT);
  readTrustedProxyHops(env.SHOPIFY_TRUSTED_PROXY_HOPS);
  readCustomerSubSecret(env.SHOPIFY_CUSTOMER_SUB_SECRET);
  const auth = loadShopifyAuth(env);
  void boot(config, port, auth, env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed to start");
    process.exit(1);
  });
}

/** Copies `SHOPIFY_ORDER_ADDRESS_GATE` onto deps. `boot` calls this after the token store opens. */
export function applyOrderAddressGate(deps: ConnectorDeps, env: NodeJS.ProcessEnv): void {
  deps.orderAddressGate = orderAddressGateEnabled(env.SHOPIFY_ORDER_ADDRESS_GATE);
}

/**
 * Copies customer-login settings onto deps. Orders and `/detect` stay as they
 * are while `SHOPIFY_CUSTOMER_ACCOUNTS` is off. Ownership is a later change.
 */
export function applyCustomerAccounts(deps: ConnectorDeps, env: NodeJS.ProcessEnv): void {
  deps.customerAccounts = customerAccountsEnabled(env.SHOPIFY_CUSTOMER_ACCOUNTS);
  deps.trustedProxyHops = readTrustedProxyHops(env.SHOPIFY_TRUSTED_PROXY_HOPS);
  const subSecret = readCustomerSubSecret(env.SHOPIFY_CUSTOMER_SUB_SECRET);
  if (subSecret !== undefined) {
    deps.customerSubSecret = subSecret;
  }
  const jwtSecret = readJwtSecret(env.JWT_SECRET);
  if (jwtSecret !== undefined) {
    deps.jwtSecret = jwtSecret;
  }
}

async function boot(
  config: ReturnType<typeof loadConfig>,
  port: number,
  auth: ReturnType<typeof loadShopifyAuth>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const deps = auth === undefined ? undefined : await openConnector(auth);
  if (deps !== undefined) {
    applyOrderAddressGate(deps, env);
    applyCustomerAccounts(deps, env);
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
