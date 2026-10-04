import {
  COLLECTION_PAGE_SIZE,
  IMAGE_PAGE_SIZE,
  VARIANT_PAGE_SIZE,
  type CatalogSort,
  bindSort,
} from "./catalog-contract.js";

export type CatalogFilters = {
  brand?: string;
  categories?: string[];
  priceRange?: { min?: number; max?: number; currency: string };
  availability?: string[];
};

const AVAILABILITY = ["in_stock", "low_stock", "out_of_stock", "backorder", "preorder"] as const;
type Availability = (typeof AVAILABILITY)[number];

export const CATALOG_PRODUCT_FIELDS = `
fragment CatalogProduct on Product {
  id
  title
  vendor
  descriptionHtml
  productType
  tags
  availableForSale
  priceRange { minVariantPrice { amount currencyCode } }
  images(first: ${IMAGE_PAGE_SIZE}) { nodes { url altText } }
  collections(first: ${COLLECTION_PAGE_SIZE}) { nodes { title } }
  variants(first: ${VARIANT_PAGE_SIZE}) {
    nodes {
      id
      availableForSale
      currentlyNotInStock
      quantityAvailable
      selectedOptions { name value }
      price { amount currencyCode }
    }
  }
}`;

export const SEARCH_DOCUMENT = `
${CATALOG_PRODUCT_FIELDS}
query CatalogSearch(
  $query: String!
  $first: Int!
  $after: String
  $sortKey: SearchSortKeys
  $reverse: Boolean
  $productFilters: [ProductFilter!]
) {
  search(
    query: $query
    types: [PRODUCT]
    first: $first
    after: $after
    sortKey: $sortKey
    reverse: $reverse
    productFilters: $productFilters
    unavailableProducts: SHOW
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { ...CatalogProduct }
  }
}`;

export const PRODUCTS_DOCUMENT = `
${CATALOG_PRODUCT_FIELDS}
query CatalogProducts(
  $query: String
  $first: Int!
  $after: String
  $sortKey: ProductSortKeys
  $reverse: Boolean
) {
  products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    pageInfo { hasNextPage endCursor }
    nodes { ...CatalogProduct }
  }
}`;

export const SHOP_CURRENCY_DOCUMENT = `
query ShopCurrency {
  shop { paymentSettings { currencyCode } }
}`;

export const DELEGATE_DOCUMENT = `
mutation DelegateAccess($scopes: [String!]!) {
  delegateAccessTokenCreate(input: { delegateAccessScope: $scopes }) {
    delegateAccessToken { accessToken expiresIn }
    userErrors { field message }
  }
}`;

export function buildProductsQuery(filters: CatalogFilters | undefined): string | undefined {
  if (filters === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (filters.brand !== undefined) {
    parts.push(`vendor:${quoteSearchValue(filters.brand)}`);
  }
  const categories = categoryClause(filters.categories);
  if (categories !== undefined) {
    parts.push(categories);
  }
  if (filters.priceRange?.min !== undefined) {
    parts.push(`variants.price:>=${formatBound(filters.priceRange.min)}`);
  }
  if (filters.priceRange?.max !== undefined) {
    parts.push(`variants.price:<=${formatBound(filters.priceRange.max)}`);
  }
  const availability = availabilityClause(filters.availability);
  if (availability === "true") {
    parts.push("available_for_sale:true");
  }
  if (availability === "false") {
    parts.push("available_for_sale:false");
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" ");
}

export function buildSearchText(query: string, categories: string[] | undefined): string {
  const categoriesClause = categoryClause(categories);
  if (categoriesClause === undefined) {
    return query;
  }
  return `${query} AND ${categoriesClause}`;
}

export function buildSearchFilters(filters: CatalogFilters | undefined): Record<string, unknown>[] | null {
  if (filters === undefined) {
    return null;
  }
  const productFilters: Record<string, unknown>[] = [];
  if (filters.brand !== undefined) {
    productFilters.push({ productVendor: filters.brand });
  }
  if (filters.priceRange?.min !== undefined || filters.priceRange?.max !== undefined) {
    const price: Record<string, number> = {};
    if (filters.priceRange.min !== undefined) {
      price.min = filters.priceRange.min;
    }
    if (filters.priceRange.max !== undefined) {
      price.max = filters.priceRange.max;
    }
    productFilters.push({ price });
  }
  const availability = availabilityClause(filters.availability);
  if (availability === "true") {
    productFilters.push({ available: true });
  }
  if (availability === "false") {
    productFilters.push({ available: false });
  }
  return productFilters.length > 0 ? productFilters : null;
}

export function availabilityOutcome(
  values: string[] | undefined,
): "none" | "empty" | "true" | "false" {
  return availabilityClause(values);
}

export function sortVariables(
  connection: "search" | "products",
  sort: CatalogSort,
  hasQuery: boolean,
): { sortKey: string; reverse: boolean } {
  const bound = bindSort(connection, sort, hasQuery);
  return { sortKey: bound.sortKey, reverse: bound.reverse };
}

function categoryClause(categories: string[] | undefined): string | undefined {
  if (categories === undefined || categories.length === 0) {
    return undefined;
  }
  const terms: string[] = [];
  for (const category of categories) {
    const quoted = quoteSearchValue(category);
    terms.push(`product_type:${quoted}`, `tag:${quoted}`);
  }
  return `(${terms.join(" OR ")})`;
}

function availabilityClause(values: string[] | undefined): "none" | "empty" | "true" | "false" {
  if (values === undefined || values.length === 0) {
    return "none";
  }
  const wanted = new Set(values.filter(isActionableAvailability));
  if (wanted.size === 0) {
    return "empty";
  }
  const wantsAvailable = wanted.has("in_stock") || wanted.has("backorder");
  const wantsOut = wanted.has("out_of_stock");
  if (wantsAvailable && wantsOut) {
    return "none";
  }
  if (wantsOut) {
    return "false";
  }
  return "true";
}

function isActionableAvailability(value: string): value is "in_stock" | "out_of_stock" | "backorder" {
  return value === "in_stock" || value === "out_of_stock" || value === "backorder";
}

function quoteSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatBound(value: number): string {
  return JSON.stringify(value);
}

export function isAvailability(value: unknown): value is Availability {
  return typeof value === "string" && (AVAILABILITY as readonly string[]).includes(value);
}
