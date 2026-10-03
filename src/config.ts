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
