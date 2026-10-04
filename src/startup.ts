import type { ShopifyAuthConfig } from "./config.js";
import { ensureClientCredentials } from "./commerce-token.js";
import type { ConnectorDeps, ShopifyAppConfig } from "./deps.js";
import { OauthStateStore } from "./oauth-state.js";
import { defaultTokenDatabasePath, TokenStore } from "./token-store.js";

export type OpenConnectorOptions = {
  databasePath?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export async function openConnector(
  auth: ShopifyAuthConfig,
  options: OpenConnectorOptions = {},
): Promise<ConnectorDeps> {
  const tokens = await TokenStore.open(
    options.databasePath ?? defaultTokenDatabasePath(),
    auth.encryptionKey,
  );
  const deps: ConnectorDeps = {
    app: toAppConfig(auth),
    tokens,
    oauthState: new OauthStateStore(),
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? Date.now,
  };
  if (auth.appUrl === undefined) {
    const renewed = await ensureClientCredentials(deps);
    if (!renewed.ok) {
      console.error(startupFailure(renewed.reason));
    }
  }
  return deps;
}

function toAppConfig(auth: ShopifyAuthConfig): ShopifyAppConfig {
  if (auth.appUrl === undefined) {
    return {
      shopDomain: auth.shopDomain,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      apiVersion: auth.apiVersion,
    };
  }
  return {
    shopDomain: auth.shopDomain,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    apiVersion: auth.apiVersion,
    appUrl: auth.appUrl,
  };
}

function startupFailure(reason: "request_failed" | "one_shop" | "decrypt"): string {
  switch (reason) {
    case "one_shop":
      return "The token store already holds a different shop.";
    case "decrypt":
      return "The token store could not be decrypted.";
    case "request_failed":
      return "Shopify client-credentials token request failed";
    default: {
      const neverReason: never = reason;
      return `Shopify token request failed (${String(neverReason)})`;
    }
  }
}
