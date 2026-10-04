/** Storefront scopes from the accepted plan. Admin order and customer scopes stay off. */
export const SHOPIFY_SCOPES = [
  "unauthenticated_read_product_listings",
  "unauthenticated_read_product_inventory",
  "unauthenticated_read_checkouts",
  "unauthenticated_write_checkouts",
] as const;

export type ShopifyScope = (typeof SHOPIFY_SCOPES)[number];

export const SHOPIFY_SCOPE_PARAM = SHOPIFY_SCOPES.join(",");

export function hasRequiredScopes(scope: string): boolean {
  const granted = new Set(
    scope
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
  return SHOPIFY_SCOPES.every((required) => granted.has(required));
}
