/** Storefront scopes delegated for catalog, cart, and checkout. */
export const STOREFRONT_SCOPES = [
  "unauthenticated_read_product_listings",
  "unauthenticated_read_product_inventory",
  "unauthenticated_read_checkouts",
  "unauthenticated_write_checkouts",
] as const;

/**
 * Scopes requested when the merchant installs the app.
 * `read_orders` is Admin-only (about the last 60 days). It is not a Storefront
 * delegate scope. `write_orders` and `read_all_orders` stay off.
 * An install that already granted the Storefront scopes does not gain
 * `read_orders` until the merchant authorizes again.
 */
export const SHOPIFY_SCOPES = [...STOREFRONT_SCOPES, "read_orders"] as const;

export type ShopifyScope = (typeof SHOPIFY_SCOPES)[number];

export const SHOPIFY_SCOPE_PARAM = SHOPIFY_SCOPES.join(",");

export function hasRequiredScopes(scope: string): boolean {
  const granted = new Set(
    scope
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
  // Catalog, cart, and checkout keep working on a token from before `read_orders`
  // was requested. The order route reports that the shop must be reinstalled.
  return STOREFRONT_SCOPES.every((required) => granted.has(required));
}
