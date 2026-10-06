import { normalizeShopDomain, type ConnectorConfig } from "./config.js";

export const SPEC_VERSION = "1.0.0";

export const SUPPORTED_FEATURES = [
  "anonymous_cart",
  "idempotency",
  "schema_validation",
  "pagination",
  "hosted_checkout",
] as const;

export const ENDPOINTS = ["products", "cart", "checkout", "orders", "auth"] as const;

/** Relative to the API root. Cart and checkout stay anonymous; orders require `jwt`. */
export const AUTH_ENDPOINTS = ["/auth/customer/start"] as const;

export type DetectResponse = {
  standard: "FastBuyJSON";
  specVersion: typeof SPEC_VERSION;
  implementationVersion: string;
  supportedFeatures: readonly string[];
  capabilities: {
    tax: { mode: "shopify_estimated" };
    shipping: { source: "shopify_delivery_groups" };
    discounts: { stackable: false; maxCodes: 1 };
    checkout: { handoff: "shopify_hosted"; confirmCreatesOrder: false };
  };
  endpoints: readonly ["products", "cart", "checkout", "orders", "auth"];
  authentication: {
    methods: readonly ["anonymous", "jwt"];
    endpoints: readonly ["/auth/customer/start"];
  };
  merchantInfo?: { name: string; url: string };
};

export function buildDetectResponse(config: ConnectorConfig): DetectResponse {
  if (config.implementationVersion.trim() === "") {
    throw new Error("implementationVersion is required");
  }

  const response: DetectResponse = {
    standard: "FastBuyJSON",
    specVersion: SPEC_VERSION,
    implementationVersion: config.implementationVersion,
    supportedFeatures: [...SUPPORTED_FEATURES],
    capabilities: {
      tax: { mode: "shopify_estimated" },
      shipping: { source: "shopify_delivery_groups" },
      discounts: { stackable: false, maxCodes: 1 },
      checkout: { handoff: "shopify_hosted", confirmCreatesOrder: false },
    },
    endpoints: ENDPOINTS,
    authentication: { methods: ["anonymous", "jwt"], endpoints: AUTH_ENDPOINTS },
  };

  if (config.shopDomain === undefined) {
    return response;
  }

  const shopDomain = normalizeShopDomain(config.shopDomain);
  return {
    ...response,
    merchantInfo: {
      name: shopDomain,
      url: `https://${shopDomain}`,
    },
  };
}
