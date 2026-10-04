import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { Ajv, type ErrorObject } from "ajv";

import { mapCatalogProduct, type CatalogProduct } from "./catalog-map.js";
import {
  MAX_PRODUCT_SCAN,
  SHOPIFY_CONNECTION_PAGE,
  type CatalogSort,
  isCatalogSort,
} from "./catalog-contract.js";
import {
  PRODUCTS_DOCUMENT,
  SEARCH_DOCUMENT,
  SHOP_CURRENCY_DOCUMENT,
  VARIANT_PAGE_DOCUMENT,
  availabilityWanted,
  buildProductsQuery,
  buildSearchFilters,
  isAvailability,
  sortVariables,
  type CatalogFilters,
  type MappedAvailability,
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

type CallFailure = "throttled" | "unauthorized" | "failed";

type WalkResult = { kind: "ok"; nodes: unknown[]; totalItems: number } | { kind: "scan" } | { kind: CallFailure };

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
  if (availabilityWanted(request.filters?.availability) === "empty") {
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

function dropsRows(request: ParsedSearch, mode: "search" | "products"): boolean {
  const wanted = availabilityWanted(request.filters?.availability);
  if (wanted !== "all") {
    return true;
  }
  if (request.filters?.priceRange !== undefined) {
    return true;
  }
  if (mode === "search" && request.filters?.categories !== undefined && request.filters.categories.length > 0) {
    return true;
  }
  return false;
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
          query: request.query ?? "",
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
  const end = offset + request.pageSize;
  if (dropsRows(request, mode)) {
    return walkMatches(deps, token, buyerIp, mode, document, base, offset, end, request);
  }
  if (mode === "search") {
    return walkSearchWindow(deps, token, buyerIp, document, base, offset, end);
  }
  return walkProductsCount(deps, token, buyerIp, document, base, offset, end);
}

async function walkSearchWindow(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  document: string,
  base: Record<string, unknown>,
  offset: number,
  end: number,
): Promise<WalkResult> {
  let scanned = 0;
  let after: string | null = null;
  let searchTotal: number | undefined;
  const selected: unknown[] = [];

  while (scanned < end) {
    if (searchTotal !== undefined && (offset >= searchTotal || scanned >= end)) {
      break;
    }
    const first = Math.min(SHOPIFY_CONNECTION_PAGE, end - scanned);
    const page = await fetchConnectionPage(deps, token, buyerIp, "search", document, base, first, after);
    if (page.kind !== "ok") {
      return page;
    }
    searchTotal = page.page.totalCount;
    for (let index = 0; index < page.page.nodes.length; index += 1) {
      const absolute = scanned + index;
      const node = page.page.nodes[index];
      if (node !== undefined && absolute >= offset && absolute < end) {
        selected.push(node);
      }
    }
    scanned += page.page.nodes.length;
    if (page.page.nodes.length === 0) {
      if (page.page.hasNextPage) {
        return { kind: "failed" };
      }
      break;
    }
    if (!page.page.hasNextPage || scanned >= end) {
      break;
    }
    after = page.page.endCursor;
  }

  if (searchTotal === undefined) {
    return { kind: "failed" };
  }
  return finishPage(deps, token, buyerIp, selected, searchTotal);
}

async function walkProductsCount(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  document: string,
  base: Record<string, unknown>,
  offset: number,
  end: number,
): Promise<WalkResult> {
  let scanned = 0;
  let after: string | null = null;
  const selected: unknown[] = [];

  for (;;) {
    const page = await fetchConnectionPage(
      deps,
      token,
      buyerIp,
      "products",
      document,
      base,
      SHOPIFY_CONNECTION_PAGE,
      after,
    );
    if (page.kind !== "ok") {
      return page;
    }
    for (const node of page.page.nodes) {
      if (scanned >= offset && scanned < end) {
        selected.push(node);
      }
      scanned += 1;
    }
    if (page.page.nodes.length === 0) {
      if (page.page.hasNextPage) {
        return { kind: "failed" };
      }
      break;
    }
    if (!page.page.hasNextPage) {
      break;
    }
    after = page.page.endCursor;
  }

  return finishPage(deps, token, buyerIp, selected, scanned);
}

async function walkMatches(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  mode: "search" | "products",
  document: string,
  base: Record<string, unknown>,
  offset: number,
  end: number,
  request: ParsedSearch,
): Promise<WalkResult> {
  const wanted = availabilityWanted(request.filters?.availability);
  const expandForStatus = wanted !== "all" && wanted !== "empty";
  let matchCount = 0;
  let after: string | null = null;
  const selected: unknown[] = [];

  for (;;) {
    const page = await fetchConnectionPage(
      deps,
      token,
      buyerIp,
      mode,
      document,
      base,
      SHOPIFY_CONNECTION_PAGE,
      after,
    );
    if (page.kind !== "ok") {
      return page;
    }
    for (const raw of page.page.nodes) {
      let node = raw;
      if (expandForStatus) {
        const completed = await expandOneProduct(deps, token, buyerIp, raw);
        if (completed.kind !== "ok") {
          return completed;
        }
        node = completed.node;
      }
      const product = mapCatalogProduct(node);
      if (product === null || !keepProduct(node, product, request, wanted)) {
        continue;
      }
      if (matchCount >= MAX_PRODUCT_SCAN) {
        return { kind: "scan" };
      }
      if (matchCount >= offset && matchCount < end) {
        selected.push(node);
      }
      matchCount += 1;
    }
    if (page.page.nodes.length === 0) {
      if (page.page.hasNextPage) {
        return { kind: "failed" };
      }
      break;
    }
    if (!page.page.hasNextPage) {
      break;
    }
    after = page.page.endCursor;
  }

  if (expandForStatus) {
    return { kind: "ok", nodes: selected, totalItems: matchCount };
  }
  return finishPage(deps, token, buyerIp, selected, matchCount);
}

async function finishPage(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  selected: unknown[],
  totalItems: number,
): Promise<WalkResult> {
  const expanded = await expandVariantPages(deps, token, buyerIp, selected);
  if (expanded.kind !== "ok") {
    return expanded;
  }
  return { kind: "ok", nodes: expanded.nodes, totalItems };
}

async function fetchConnectionPage(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  mode: "search" | "products",
  document: string,
  base: Record<string, unknown>,
  first: number,
  after: string | null,
): Promise<{ kind: "ok"; page: ConnectionPage } | { kind: CallFailure }> {
  const call = await storefront(deps, token, buyerIp, document, { ...base, first, after });
  if (call.kind !== "ok") {
    return { kind: call.kind };
  }
  const page = mode === "search" ? parseSearchPage(call.data) : parseProductsPage(call.data);
  if (page === null) {
    return { kind: "failed" };
  }
  if (mode === "search" && page.totalCount === undefined) {
    return { kind: "failed" };
  }
  return { kind: "ok", page };
}

const VARIANT_PAGE_LIMIT = 30;

async function expandVariantPages(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  nodes: unknown[],
): Promise<{ kind: "ok"; nodes: unknown[] } | { kind: "throttled" | "unauthorized" | "failed" }> {
  const expanded: unknown[] = [];
  for (const node of nodes) {
    const completed = await expandOneProduct(deps, token, buyerIp, node);
    if (completed.kind !== "ok") {
      return completed;
    }
    expanded.push(completed.node);
  }
  return { kind: "ok", nodes: expanded };
}

async function expandOneProduct(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  node: unknown,
): Promise<{ kind: "ok"; node: unknown } | { kind: "throttled" | "unauthorized" | "failed" }> {
  if (!isRecord(node) || !isRecord(node.variants) || typeof node.id !== "string") {
    return { kind: "ok", node };
  }
  const connection = readVariantConnection(node.variants);
  if (connection === null || !connection.hasNextPage) {
    return { kind: "ok", node };
  }
  const nodes = [...connection.nodes];
  let after = connection.endCursor;
  let hasNextPage = true;
  for (let page = 0; hasNextPage && page < VARIANT_PAGE_LIMIT; page += 1) {
    if (after === null) {
      return { kind: "failed" };
    }
    const call = await storefront(deps, token, buyerIp, VARIANT_PAGE_DOCUMENT, { id: node.id, after });
    if (call.kind !== "ok") {
      return { kind: call.kind };
    }
    const next = readVariantProduct(call.data);
    if (next === null) {
      return { kind: "failed" };
    }
    nodes.push(...next.nodes);
    hasNextPage = next.hasNextPage;
    after = next.endCursor;
  }
  if (hasNextPage) {
    return { kind: "failed" };
  }
  return {
    kind: "ok",
    node: {
      ...node,
      variants: {
        pageInfo: { hasNextPage: false, endCursor: after },
        nodes,
      },
    },
  };
}

function keepProduct(
  node: unknown,
  product: CatalogProduct,
  request: ParsedSearch,
  wanted: "all" | "empty" | MappedAvailability[],
): boolean {
  if (wanted !== "all" && wanted !== "empty") {
    const status = product.availability?.status;
    if (status !== "in_stock" && status !== "out_of_stock" && status !== "backorder") {
      return false;
    }
    if (!wanted.includes(status)) {
      return false;
    }
  }
  const range = request.filters?.priceRange;
  if (range !== undefined) {
    if (range.min !== undefined && product.price.amount < range.min) {
      return false;
    }
    if (range.max !== undefined && product.price.amount > range.max) {
      return false;
    }
  }
  const categories = request.filters?.categories;
  if (categories !== undefined && categories.length > 0 && !categoryMatches(node, categories)) {
    return false;
  }
  return true;
}

function categoryMatches(node: unknown, categories: string[]): boolean {
  if (!isRecord(node)) {
    return false;
  }
  const productType = typeof node.productType === "string" ? node.productType : undefined;
  const tags = Array.isArray(node.tags) ? node.tags : [];
  for (const category of categories) {
    if (productType === category) {
      return true;
    }
    if (tags.some((tag) => tag === category)) {
      return true;
    }
  }
  return false;
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

function readVariantProduct(data: unknown): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } | null {
  if (!isRecord(data) || !isRecord(data.product) || !isRecord(data.product.variants)) {
    return null;
  }
  return readVariantConnection(data.product.variants);
}

function readVariantConnection(
  connection: Record<string, unknown>,
): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } | null {
  return readConnection(connection);
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
