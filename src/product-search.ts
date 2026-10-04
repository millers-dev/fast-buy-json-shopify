import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { Ajv, type ErrorObject } from "ajv";

import { mapCatalogProduct, type CatalogProduct } from "./catalog-map.js";
import {
  MAX_PRODUCT_SCAN,
  PRODUCTS_CONNECTION_TOTAL_COUNT_ON_2026_10,
  SHOPIFY_CONNECTION_PAGE,
  type CatalogSort,
  isCatalogSort,
} from "./catalog-contract.js";
import {
  PRODUCTS_DOCUMENT,
  SEARCH_DOCUMENT,
  SHOP_CURRENCY_DOCUMENT,
  availabilityOutcome,
  buildProductsQuery,
  buildSearchFilters,
  buildSearchText,
  isAvailability,
  sortVariables,
  type CatalogFilters,
} from "./catalog-query.js";
import { prepareCommerceAccess } from "./commerce-token.js";
import { ensureDelegateToken, installedProblem } from "./delegate-token.js";
import type { ConnectorDeps } from "./deps.js";
import { publicBuyerIp } from "./buyer-ip.js";
import { writeJson, writeProblem } from "./http-response.js";
import { isRecord } from "./json.js";
import {
  internalError,
  rateLimited,
  validationError,
  type FieldError,
  type Problem,
} from "./problems.js";
import { RequestBodyTooLargeError, readRequestBody } from "./read-body.js";
import { defaultSleep, shopifyGraphql, storefrontGraphqlUrl, type ShopifyCall } from "./shopify-graphql.js";
import { readPackageMetadata } from "./version.js";

export const PRODUCTS_SEARCH_PATH = "/api/fastbuyjson/products/search";

const NO_STORE = { "Cache-Control": "no-store" };

const validateSearchRequest = new Ajv({ allErrors: true, strict: false }).compile(
  JSON.parse(
    readFileSync(join(readPackageMetadata(import.meta.url).root, "schemas", "product-search.json"), "utf8"),
  ) as object,
);

type ParsedSearch = {
  query?: string;
  sort: CatalogSort;
  page: number;
  pageSize: number;
  filters?: CatalogFilters;
};

type WalkResult =
  | { kind: "ok"; nodes: unknown[]; totalItems: number }
  | { kind: "scan" }
  | { kind: "throttled" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

export async function handleProductSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
): Promise<void> {
  const parsed = await readParsedSearch(req);
  if (!parsed.ok) {
    writeProblem(res, parsed.problem);
    return;
  }
  const request = parsed.request;
  if (request.page * request.pageSize > MAX_PRODUCT_SCAN) {
    writeProblem(res, scanProblem());
    return;
  }

  const access = await prepareCommerceAccess(deps);
  if (access.kind === "unavailable") {
    writeProblem(res, internalError(access.detail));
    return;
  }
  if (availabilityOutcome(request.filters?.availability) === "empty") {
    const missing = await deps.tokens.exclusive(async () => installedProblem(deps));
    if (missing !== undefined) {
      writeProblem(res, missing);
      return;
    }
    writeJson(res, 200, pageBody([], request.page, request.pageSize, 0), NO_STORE);
    return;
  }

  const delegate = await ensureDelegateToken(deps);
  if (!delegate.ok) {
    writeProblem(res, delegate.problem);
    return;
  }

  const buyerIp = publicBuyerIp(req.socket.remoteAddress ?? undefined);
  if (request.filters?.priceRange !== undefined) {
    const currency = await shopCurrency(deps, delegate.token, buyerIp);
    if (currency.kind !== "ok") {
      await writeCallFailure(res, deps, currency.kind);
      return;
    }
    if (currency.code !== request.filters.priceRange.currency) {
      writeProblem(
        res,
        validationError(`priceRange.currency must be the shop currency (${currency.code}).`, [
          {
            field: "filters.priceRange.currency",
            message: `currency must be ${currency.code}`,
          },
        ]),
      );
      return;
    }
  }

  const walked = await walkCatalog(deps, delegate.token, buyerIp, request);
  if (walked.kind === "scan") {
    writeProblem(res, scanProblem());
    return;
  }
  if (walked.kind !== "ok") {
    await writeCallFailure(res, deps, walked.kind);
    return;
  }

  const results: CatalogProduct[] = [];
  for (const node of walked.nodes) {
    const product = mapCatalogProduct(node);
    if (product !== null) {
      results.push(product);
    }
  }
  writeJson(res, 200, pageBody(results, request.page, request.pageSize, walked.totalItems), NO_STORE);
}

async function readParsedSearch(
  req: IncomingMessage,
): Promise<{ ok: true; request: ParsedSearch } | { ok: false; problem: Problem }> {
  let raw: Buffer;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, problem: validationError("The request body is too large.") };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, problem: validationError("The request body must be JSON.") };
  }
  if (!validateSearchRequest(parsed)) {
    return {
      ok: false,
      problem: validationError("The request body is invalid.", fieldErrors(validateSearchRequest.errors)),
    };
  }
  return { ok: true, request: readSearch(parsed) };
}

function readSearch(value: unknown): ParsedSearch {
  const record = isRecord(value) ? value : {};
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const sort = isCatalogSort(record.sort) ? record.sort : "relevance";
  const page = typeof record.page === "number" ? record.page : 1;
  const pageSize = typeof record.pageSize === "number" ? record.pageSize : 10;
  const filters = isRecord(record.filters) ? readFilters(record.filters) : undefined;
  const request: ParsedSearch = { sort, page, pageSize };
  if (query !== "") {
    request.query = query;
  }
  if (filters !== undefined) {
    request.filters = filters;
  }
  return request;
}

function readFilters(filters: Record<string, unknown>): CatalogFilters | undefined {
  const parsed: CatalogFilters = {};
  if (typeof filters.brand === "string" && filters.brand.trim() !== "") {
    parsed.brand = filters.brand.trim();
  }
  if (Array.isArray(filters.categories)) {
    const categories = filters.categories
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (categories.length > 0) {
      parsed.categories = categories;
    }
  }
  if (isRecord(filters.priceRange)) {
    const currency =
      typeof filters.priceRange.currency === "string" && filters.priceRange.currency.trim() !== ""
        ? filters.priceRange.currency.trim().toUpperCase()
        : "USD";
    const priceRange: { min?: number; max?: number; currency: string } = { currency };
    if (typeof filters.priceRange.min === "number") {
      priceRange.min = filters.priceRange.min;
    }
    if (typeof filters.priceRange.max === "number") {
      priceRange.max = filters.priceRange.max;
    }
    parsed.priceRange = priceRange;
  }
  if (Array.isArray(filters.availability)) {
    const availability = filters.availability.filter(isAvailability);
    if (availability.length > 0) {
      parsed.availability = availability;
    }
  }
  if (
    parsed.brand === undefined &&
    parsed.categories === undefined &&
    parsed.priceRange === undefined &&
    parsed.availability === undefined
  ) {
    return undefined;
  }
  return parsed;
}

function fieldErrors(errors: ErrorObject[] | null | undefined): FieldError[] {
  return (errors ?? []).map((error) => ({
    field: fieldPath(error),
    message: error.message ?? "is invalid",
  }));
}

function fieldPath(error: ErrorObject): string {
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  if (path !== "") {
    return path;
  }
  const missing = error.params.missingProperty;
  if (typeof missing === "string" && missing !== "") {
    return missing;
  }
  return "request";
}

async function shopCurrency(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
): Promise<{ kind: "ok"; code: string } | { kind: "throttled" | "unauthorized" | "failed" }> {
  const call = await storefront(deps, token, buyerIp, SHOP_CURRENCY_DOCUMENT, {});
  if (call.kind !== "ok") {
    return { kind: call.kind };
  }
  const code = readShopCurrency(call.data);
  if (code === null) {
    return { kind: "failed" };
  }
  return { kind: "ok", code };
}

function readShopCurrency(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.shop) || !isRecord(data.shop.paymentSettings)) {
    return null;
  }
  const code = data.shop.paymentSettings.currencyCode;
  if (typeof code !== "string" || code.trim() === "") {
    return null;
  }
  return code.trim().toUpperCase();
}

async function walkCatalog(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  request: ParsedSearch,
): Promise<WalkResult> {
  const mode = request.query !== undefined ? "search" : "products";
  const productsQuery = mode === "products" ? buildProductsQuery(request.filters) : undefined;
  const sort = sortVariables(mode, request.sort, mode === "search" || productsQuery !== undefined);
  const base =
    mode === "search"
      ? {
          query: buildSearchText(request.query ?? "", request.filters?.categories),
          sortKey: sort.sortKey,
          reverse: sort.reverse,
          productFilters: buildSearchFilters(request.filters),
        }
      : {
          query: productsQuery ?? null,
          sortKey: sort.sortKey,
          reverse: sort.reverse,
        };
  const document = mode === "search" ? SEARCH_DOCUMENT : PRODUCTS_DOCUMENT;
  const offset = (request.page - 1) * request.pageSize;
  let scanned = 0;
  let after: string | null = null;
  let searchTotal: number | undefined;
  let exhausted = false;
  const selected: unknown[] = [];

  while (scanned < MAX_PRODUCT_SCAN) {
    if (mode === "search" && searchTotal !== undefined && (offset >= searchTotal || scanned >= offset + request.pageSize)) {
      break;
    }
    const budget = MAX_PRODUCT_SCAN - scanned;
    const first =
      mode === "products"
        ? Math.min(SHOPIFY_CONNECTION_PAGE, budget)
        : Math.min(SHOPIFY_CONNECTION_PAGE, budget, Math.max(offset + request.pageSize - scanned, 1));
    const call = await storefront(deps, token, buyerIp, document, { ...base, first, after });
    if (call.kind !== "ok") {
      return { kind: call.kind };
    }
    const page = mode === "search" ? parseSearchPage(call.data) : parseProductsPage(call.data);
    if (page === null) {
      return { kind: "failed" };
    }
    if (mode === "search") {
      if (page.totalCount === undefined) {
        return { kind: "failed" };
      }
      searchTotal = page.totalCount;
    }
    for (let index = 0; index < page.nodes.length; index += 1) {
      const absolute = scanned + index;
      const node = page.nodes[index];
      if (node !== undefined && absolute >= offset && absolute < offset + request.pageSize) {
        selected.push(node);
      }
    }
    scanned += page.nodes.length;
    if (page.nodes.length === 0) {
      if (page.hasNextPage) {
        return { kind: "failed" };
      }
      exhausted = true;
      break;
    }
    if (!page.hasNextPage) {
      exhausted = true;
      break;
    }
    after = page.endCursor;
  }

  if (mode === "search") {
    if (searchTotal === undefined) {
      return { kind: "failed" };
    }
    return { kind: "ok", nodes: selected, totalItems: searchTotal };
  }
  if (PRODUCTS_CONNECTION_TOTAL_COUNT_ON_2026_10 || !exhausted) {
    return PRODUCTS_CONNECTION_TOTAL_COUNT_ON_2026_10 ? { kind: "failed" } : { kind: "scan" };
  }
  return { kind: "ok", nodes: selected, totalItems: scanned };
}

type ConnectionPage = {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount?: number;
};

function parseSearchPage(data: unknown): ConnectionPage | null {
  if (!isRecord(data) || !isRecord(data.search)) {
    return null;
  }
  const page = readConnection(data.search);
  if (page === null) {
    return null;
  }
  const totalCount = data.search.totalCount;
  if (typeof totalCount !== "number" || !Number.isInteger(totalCount) || totalCount < 0) {
    return null;
  }
  return { ...page, totalCount };
}

function parseProductsPage(data: unknown): ConnectionPage | null {
  if (!isRecord(data) || !isRecord(data.products)) {
    return null;
  }
  return readConnection(data.products);
}

function readConnection(
  connection: Record<string, unknown>,
): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } | null {
  if (!isRecord(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== "boolean") {
    return null;
  }
  if (!Array.isArray(connection.nodes)) {
    return null;
  }
  const endCursor = connection.pageInfo.endCursor;
  const cursor = typeof endCursor === "string" && endCursor !== "" ? endCursor : null;
  if (connection.pageInfo.hasNextPage && cursor === null) {
    return null;
  }
  return {
    nodes: connection.nodes,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: cursor,
  };
}

function storefront(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  query: string,
  variables: Record<string, unknown>,
): Promise<ShopifyCall> {
  return shopifyGraphql({
    url: storefrontGraphqlUrl(deps.app.shopDomain, deps.app.apiVersion),
    tokenHeader: "Shopify-Storefront-Private-Token",
    token,
    query,
    variables,
    ...(buyerIp !== undefined ? { buyerIp } : {}),
    fetch: deps.fetch,
    sleep: deps.sleep ?? defaultSleep,
  });
}

async function writeCallFailure(
  res: ServerResponse,
  deps: ConnectorDeps,
  kind: "throttled" | "unauthorized" | "failed",
): Promise<void> {
  if (kind === "throttled") {
    writeProblem(res, rateLimited());
    return;
  }
  if (kind === "unauthorized") {
    await deps.tokens.exclusive(async () => {
      deps.tokens.clearDelegate(deps.app.shopDomain, deps.now());
    });
  }
  writeProblem(res, internalError("The catalog request could not be completed."));
}

function scanProblem(): Problem {
  return validationError("That page would scan more than 1000 matching items.", [
    {
      field: "page",
      message: "page and pageSize would scan more than 1000 matching items.",
    },
  ]);
}

function pageBody(results: CatalogProduct[], page: number, pageSize: number, totalItems: number): unknown {
  return {
    results,
    pagination: {
      currentPage: page,
      pageSize,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
    },
  };
}
