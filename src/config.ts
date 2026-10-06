import { SHOPIFY_API_VERSION } from "./api-version.js";
import { parseEncryptionKey } from "./secret-box.js";

const SHOP_DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type ConnectorConfig = {
  implementationVersion: string;
  shopDomain?: string;
};

export function loadConfig(
  env: NodeJS.ProcessEnv,
  implementationVersion: string,
): ConnectorConfig {
  const shopDomain = readShopDomain(env);
  if (shopDomain === undefined) {
    return { implementationVersion };
  }
  return { implementationVersion, shopDomain };
}

export function readShopDomain(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SHOPIFY_SHOP;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return normalizeShopDomain(raw);
}

export function normalizeShopDomain(value: string): string {
  const shopDomain = value.trim().toLowerCase();
  if (!SHOP_DOMAIN.test(shopDomain)) {
    throw new Error("SHOPIFY_SHOP must be a shop domain such as example.myshopify.com");
  }
  return shopDomain;
}

export type ShopifyAuthConfig = {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  encryptionKey: Buffer;
  apiVersion: typeof SHOPIFY_API_VERSION;
  appUrl?: string;
};

export function loadShopifyAuth(env: NodeJS.ProcessEnv): ShopifyAuthConfig | undefined {
  const clientId = readOptional(env, "SHOPIFY_CLIENT_ID");
  const clientSecret = readOptional(env, "SHOPIFY_CLIENT_SECRET");
  const encryptionRaw = readOptional(env, "TOKEN_ENCRYPTION_KEY");
  const appUrlRaw = readOptional(env, "APP_URL");
  const apiVersionRaw = readOptional(env, "SHOPIFY_API_VERSION");
  if (apiVersionRaw !== undefined && apiVersionRaw !== SHOPIFY_API_VERSION) {
    throw new Error(`SHOPIFY_API_VERSION must be ${SHOPIFY_API_VERSION}`);
  }
  const anyAuth =
    clientId !== undefined ||
    clientSecret !== undefined ||
    encryptionRaw !== undefined ||
    appUrlRaw !== undefined;
  if (!anyAuth) {
    return undefined;
  }
  if (clientId === undefined || clientSecret === undefined || encryptionRaw === undefined) {
    throw new Error(
      "SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY are required together",
    );
  }
  const shopDomain = readShopDomain(env);
  if (shopDomain === undefined) {
    throw new Error("SHOPIFY_SHOP is required to store a Shopify token");
  }
  const encryptionKey = parseEncryptionKey(encryptionRaw);
  if (appUrlRaw === undefined) {
    return {
      shopDomain,
      clientId,
      clientSecret,
      encryptionKey,
      apiVersion: SHOPIFY_API_VERSION,
    };
  }
  return {
    shopDomain,
    clientId,
    clientSecret,
    encryptionKey,
    apiVersion: SHOPIFY_API_VERSION,
    appUrl: parseAppUrl(appUrlRaw),
  };
}

/**
 * Street addresses are copied onto the order response only when this is on.
 * On is the trimmed value `1` or `true`, compared case-insensitively.
 * Unset, empty, `0`, `false`, `off`, and every other value are off.
 */
export function orderAddressGateEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Customer-account login is on only when the trimmed value is `1` or `true`,
 * compared case-insensitively. Unset, empty, `0`, `false`, and every other
 * value are off. Off keeps anonymous orders and does not advertise auth.
 */
export function customerAccountsEnabled(raw: string | undefined): boolean {
  return orderAddressGateEnabled(raw);
}

/**
 * Unset or `""` is 0 (socket address, `X-Forwarded-For` ignored).
 * A set value is trimmed, then accepted only when it matches `^[0-9]+$`
 * and the integer is 0 through 10. Anything else refuses process start.
 * This is not `parseInt` (`1abc` is rejected, not treated as 1).
 */
export function readTrustedProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 0;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error("SHOPIFY_TRUSTED_PROXY_HOPS must be an integer from 0 to 10");
  }
  const hops = Number(trimmed);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("SHOPIFY_TRUSTED_PROXY_HOPS must be an integer from 0 to 10");
  }
  return hops;
}

/**
 * UTF-8 HMAC key for the JWT `sub`. Unset or `""` lets the process start.
 * A set value shorter than 32 bytes refuses process start. The bytes are not trimmed.
 */
export function readCustomerSubSecret(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (Buffer.byteLength(raw, "utf8") < 32) {
    throw new Error("SHOPIFY_CUSTOMER_SUB_SECRET must be at least 32 bytes");
  }
  return raw;
}

/** HS256 key for the FastBuyJSON JWT. Unset or `""` lets the process start. */
export function readJwtSecret(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return raw;
}

export function readPort(env: NodeJS.ProcessEnv, defaultPort: number): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === "") {
    return defaultPort;
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }
  return port;
}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw.trim();
}

function parseAppUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_URL must be an https origin");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("APP_URL must be an https origin");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("APP_URL must be an https origin");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("APP_URL must be an https origin");
  }
  return url.origin;
}
