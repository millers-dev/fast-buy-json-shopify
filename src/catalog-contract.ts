/**
 * Storefront API 2026-10 catalog decisions, re-checked against the public
 * reference on 2026-10-04 before this mapper was frozen.
 *
 * SearchSortKeys: PRICE, RELEVANCE.
 * ProductSortKeys: BEST_SELLING, CREATED_AT, ID, PRICE, PRODUCT_TYPE, RELEVANCE, TITLE, UPDATED_AT, VENDOR.
 * ProductVariant.currentlyNotInStock is present (non-null Boolean).
 * search.totalCount is present (capped at 1000 by Shopify).
 * products (ProductConnection) returns edges, nodes, filters, and pageInfo. It has no totalCount.
 * ProductFilter.productVendor has no caseInsensitiveMatch argument.
 */

export const MAX_PRODUCT_SCAN = 1000;
export const SHOPIFY_CONNECTION_PAGE = 250;
export const VARIANT_PAGE_SIZE = 100;
export const IMAGE_PAGE_SIZE = 20;
export const COLLECTION_PAGE_SIZE = 20;

export const SORTS = ["relevance", "price_asc", "price_desc", "name_asc", "name_desc", "newest"] as const;
export type CatalogSort = (typeof SORTS)[number];

export type BoundSort = {
  sortKey: "RELEVANCE" | "PRICE" | "TITLE" | "CREATED_AT" | "ID";
  reverse: boolean;
  fallback: boolean;
};

export const SEARCH_SORT_ON_2026_10: Record<CatalogSort, BoundSort> = {
  relevance: { sortKey: "RELEVANCE", reverse: false, fallback: false },
  price_asc: { sortKey: "PRICE", reverse: false, fallback: false },
  price_desc: { sortKey: "PRICE", reverse: true, fallback: false },
  name_asc: { sortKey: "RELEVANCE", reverse: false, fallback: true },
  name_desc: { sortKey: "RELEVANCE", reverse: false, fallback: true },
  newest: { sortKey: "RELEVANCE", reverse: false, fallback: true },
};

export const PRODUCT_SORT_ON_2026_10: Record<CatalogSort, BoundSort> = {
  relevance: { sortKey: "RELEVANCE", reverse: false, fallback: false },
  price_asc: { sortKey: "PRICE", reverse: false, fallback: false },
  price_desc: { sortKey: "PRICE", reverse: true, fallback: false },
  name_asc: { sortKey: "TITLE", reverse: false, fallback: false },
  name_desc: { sortKey: "TITLE", reverse: true, fallback: false },
  newest: { sortKey: "CREATED_AT", reverse: true, fallback: false },
};

export const SEARCH_SORT_FALLBACK_ON_2026_10 = ["name_asc", "name_desc", "newest"] as const;

export const PRODUCT_RELEVANCE_WITHOUT_QUERY_ON_2026_10 = {
  sortKey: "ID",
  reverse: false,
  reason:
    "ProductSortKeys.RELEVANCE exists on 2026-10 but the reference says not to use it when the products query argument is omitted. The connection default is ID.",
} as const;

export const SORT_KEYS_ON_2026_10 =
  "SearchSortKeys on 2026-10 are PRICE and RELEVANCE. name_asc, name_desc, and newest fall back to RELEVANCE on a text query. ProductSortKeys include PRICE, TITLE, and CREATED_AT, so price_asc, price_desc, name_asc, name_desc, and newest bind directly on a filters-only query. newest is CREATED_AT reversed. relevance on products with no query string uses ID, because RELEVANCE is documented as invalid without a query.";

export const BRAND_MATCH_ON_2026_10 =
  "Storefront API 2026-10 vendor match is an exact vendor string and is not a guaranteed case-insensitive match. products(query) uses vendor:\"<brand>\" with no case-insensitive flag. search(productFilters) uses ProductFilter.productVendor, a String with no caseInsensitiveMatch argument. On 2026-10, caseInsensitiveMatch is an argument of variant selection (selectedOrFirstAvailableVariant, variantBySelectedOptions, adjacentVariants). ProductFilter.variantOption is name and value only. The brand is sent unchanged.";

export const CURRENTLY_NOT_IN_STOCK_ON_2026_10 = {
  presentOnProductVariant: true,
  backorderMapped: true,
} as const;

export const PRODUCTS_CONNECTION_TOTAL_COUNT_ON_2026_10 = false;

export const FILTERS_ONLY_TOTAL_ITEMS =
  "ProductConnection on Storefront API 2026-10 has no totalCount (the products query returns edges, nodes, filters, and pageInfo). Page 1 reads only pageSize nodes and does not walk the rest of the catalog, so a shop with more than 1000 products does not return 400 on page 1. Cursor walks for page > 1 return 400 VALIDATION_ERROR when page * pageSize would scan more than 1000 matching items. When pageInfo.hasNextPage is false after the nodes read for this page, totalItems is that node count. When hasNextPage is still true, totalItems is the number of nodes read plus one, because another node exists and this request does not scan it. The connector does not invent a count.";

export const PRODUCT_QUANTITY_ON_2026_10 =
  "Product has no quantityAvailable on Storefront API 2026-10 (the field is on ProductVariant). availability.quantity is the sum of variant quantityAvailable across every variant page, and is omitted when any returned variant has null. A first page of 100 variants is not the product quantity when pageInfo.hasNextPage is true.";

export const AVAILABILITY_FILTER_ON_2026_10 =
  "filters.availability is a subset of the mapped availability.status. in_stock and backorder do not both collapse to available:true. A mix that includes out_of_stock does not turn the filter off. Shopify's available flag cannot tell in_stock from backorder (currentlyNotInStock), so a product is returned only when its mapped status is in the requested set.";

export const CATEGORIES_FILTER_ON_2026_10 =
  "A categories filter matches product_type or tag. Collection titles are not an exact any-match. The category clause is not appended to the caller search query, so a query that contains OR or quotes cannot bypass it. ProductFilter on 2026-10 ANDs different keys and ORs the same key, so productType and tag cannot express that OR as productFilters. The OR is applied to productType and tags. A filters-only products query still sends the quoted product_type OR tag clause, because that string is not the caller text.";

export const PRICE_RANGE_ON_2026_10 =
  "priceRange is an inclusive bound on product price.amount, which is the minimum variant price. variants.price and ProductFilter.price are not that minimum: another variant inside the range does not put the product inside when the minimum is outside. Those Shopify price filters are not sent. A currency other than the shop currency is 400 VALIDATION_ERROR with no conversion.";

export function isCatalogSort(value: unknown): value is CatalogSort {
  return typeof value === "string" && (SORTS as readonly string[]).includes(value);
}

export function bindSort(connection: "search" | "products", sort: CatalogSort, hasQuery: boolean): BoundSort {
  if (connection === "products" && sort === "relevance" && !hasQuery) {
    return {
      sortKey: PRODUCT_RELEVANCE_WITHOUT_QUERY_ON_2026_10.sortKey,
      reverse: PRODUCT_RELEVANCE_WITHOUT_QUERY_ON_2026_10.reverse,
      fallback: false,
    };
  }
  switch (connection) {
    case "search":
      return SEARCH_SORT_ON_2026_10[sort];
    case "products":
      return PRODUCT_SORT_ON_2026_10[sort];
    default: {
      const neverConnection: never = connection;
      throw new Error(`Unhandled catalog connection: ${String(neverConnection)}`);
    }
  }
}
