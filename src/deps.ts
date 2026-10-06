import type { OauthStateStore } from "./oauth-state.js";
import type { TokenStore } from "./token-store.js";

export type ShopifyAppConfig = {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  appUrl?: string;
};

export type ConnectorDeps = {
  app: ShopifyAppConfig;
  tokens: TokenStore;
  oauthState: OauthStateStore;
  fetch: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** From `SHOPIFY_ORDER_ADDRESS_GATE` at startup. Absent or false keeps addresses off. */
  orderAddressGate?: boolean;
};
