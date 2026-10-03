import { pathToFileURL } from "node:url";

import { loadConfig, readPort } from "./config.js";
import { DEFAULT_PORT, createConnectorServer, listen } from "./server.js";
import { readPackageMetadata } from "./version.js";

export function start(env: NodeJS.ProcessEnv = process.env): void {
  const metadata = readPackageMetadata();
  const config = loadConfig(env, metadata.version);
  const port = readPort(env, DEFAULT_PORT);
  const server = createConnectorServer(config);
  listen(server, port)
    .then((bound) => {
      const shop = config.shopDomain ?? "unset";
      console.log(
        `FastBuyJSON Shopify connector at http://localhost:${bound}/api/fastbuyjson/detect (shop ${shop})`,
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "failed to listen";
      console.error(message);
      process.exit(1);
    });
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
