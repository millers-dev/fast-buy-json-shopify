import type { LoginAttemptLog } from "./customer-login-crypto.js";
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
  /** From `SHOPIFY_TRUSTED_PROXY_HOPS` at startup. Absent means 0. */
  trustedProxyHops?: number;
  /** UTF-8, at least 32 bytes, when `SHOPIFY_CUSTOMER_SUB_SECRET` is set. */
  customerSubSecret?: string;
  /** HS256 key when `JWT_SECRET` is set. */
  jwtSecret?: string;
  /** Per-process start limiter. Absent until the first customer-login start. */
  loginAttempts?: LoginAttemptLog;
};
