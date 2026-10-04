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
    pageInfo { hasNextPage endCursor }
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

export const VARIANT_PAGE_DOCUMENT = `
query CatalogVariantPage($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: ${VARIANT_PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        availableForSale
        currentlyNotInStock
        quantityAvailable
        selectedOptions { name value }
        price { amount currencyCode }
      }
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
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" ");
}

export function buildSearchFilters(filters: CatalogFilters | undefined): Record<string, unknown>[] | null {
  if (filters?.brand === undefined) {
    return null;
  }
  return [{ productVendor: filters.brand }];
}

export type MappedAvailability = "in_stock" | "out_of_stock" | "backorder";

export function availabilityWanted(
  values: string[] | undefined,
): "all" | "empty" | MappedAvailability[] {
  if (values === undefined || values.length === 0) {
    return "all";
  }
  const wanted: MappedAvailability[] = [];
  for (const value of values) {
    if (!isMappedAvailability(value) || wanted.includes(value)) {
      continue;
    }
    wanted.push(value);
  }
  return wanted.length === 0 ? "empty" : wanted;
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

function isMappedAvailability(value: string): value is MappedAvailability {
  return value === "in_stock" || value === "out_of_stock" || value === "backorder";
}

function quoteSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function isAvailability(value: unknown): value is Availability {
  return typeof value === "string" && (AVAILABILITY as readonly string[]).includes(value);
}
