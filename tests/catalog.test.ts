import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

import { SHOPIFY_API_VERSION } from "../src/api-version.js";
import { publicBuyerIp } from "../src/buyer-ip.js";
import {
  AVAILABILITY_FILTER_ON_2026_10,
  BRAND_MATCH_ON_2026_10,
  CATEGORIES_FILTER_ON_2026_10,
  CURRENTLY_NOT_IN_STOCK_ON_2026_10,
  FILTERS_ONLY_TOTAL_ITEMS,
  PRICE_RANGE_ON_2026_10,
  PRODUCT_QUANTITY_ON_2026_10,
  PRODUCT_RELEVANCE_WITHOUT_QUERY_ON_2026_10,
  PRODUCTS_CONNECTION_TOTAL_COUNT_ON_2026_10,
  SEARCH_SORT_FALLBACK_ON_2026_10,
  SEARCH_SORT_ON_2026_10,
  SORT_KEYS_ON_2026_10,
  bindSort,
} from "../src/catalog-contract.js";
import { DELEGATE_DOCUMENT, PRODUCTS_DOCUMENT, SEARCH_DOCUMENT, VARIANT_PAGE_DOCUMENT } from "../src/catalog-query.js";
import type { ConnectorDeps } from "../src/deps.js";
import { plainTextFromHtml } from "../src/html-text.js";
import { moneyAmount } from "../src/money.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { createConnectorServer, listen } from "../src/server.js";
import { SHOPIFY_BACKOFF_MS, shopifyGraphql } from "../src/shopify-graphql.js";
import { SHOPIFY_SCOPE_PARAM, SHOPIFY_SCOPES } from "../src/scopes.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const ADMIN_TOKEN = "shpat_catalog_admin_token";
const REFRESH_TOKEN = "shprt_catalog_refresh_token";
const DELEGATE_TOKEN = "shppa_delegate_catalog_test";
const REUSED_DELEGATE = "shppa_delegate_reused_token";
const OLD_DELEGATE = "shppa_delegate_before_refresh";
const NEW_ADMIN = "shpat_catalog_refreshed_admin";
const NEW_REFRESH = "shprt_catalog_refreshed_token";
const FIXED_NOW = 1_700_000_000_000;
const SECRETS = [ADMIN_TOKEN, REFRESH_TOKEN, DELEGATE_TOKEN, REUSED_DELEGATE, OLD_DELEGATE, NEW_ADMIN, NEW_REFRESH];

type GraphqlCall = {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

type SearchBody = {
  results: ProductResult[];
  pagination: { currentPage: number; pageSize: number; totalItems: number; totalPages: number };
};

type ProductResult = {
  id: string;
  name: string;
  brand?: string;
  description?: string;
  price: { amount: number; currency: string };
  availability?: { status: string; quantity?: number };
  categories?: string[];
  images?: { url: string; alt?: string }[];
  variants?: { id: string; attributes: Record<string, string>; price?: { amount: number; currency: string } }[];
  extensions?: unknown;
};

describe("Storefront API 2026-10 catalog decisions", () => {
  it("records brand match, currentlyNotInStock, sort keys, and filters-only totalItems", () => {
    assert.equal(PRODUCTS_CONNECTION_TOTAL_COUNT_ON_2026_10, false);
    assert.match(FILTERS_ONLY_TOTAL_ITEMS, /no totalCount/);
    assert.match(FILTERS_ONLY_TOTAL_ITEMS, /does not invent a count/);
    assert.match(FILTERS_ONLY_TOTAL_ITEMS, /plus one/);
    assert.match(FILTERS_ONLY_TOTAL_ITEMS, /does not walk the rest of the catalog/);
    assert.match(AVAILABILITY_FILTER_ON_2026_10, /subset of the mapped availability.status/);
    assert.match(CATEGORIES_FILTER_ON_2026_10, /not appended to the caller search query/);
    assert.match(PRICE_RANGE_ON_2026_10, /minimum variant price/);
    assert.match(PRODUCT_QUANTITY_ON_2026_10, /every variant page/);
    assert.equal(VARIANT_PAGE_DOCUMENT.includes("CatalogVariantPage"), true);
    assert.equal(SEARCH_DOCUMENT.includes("variants(first:"), true);
    assert.equal(SEARCH_DOCUMENT.includes("query AND"), false);
    assert.match(BRAND_MATCH_ON_2026_10, /not a guaranteed case-insensitive match/);
    assert.match(BRAND_MATCH_ON_2026_10, /caseInsensitiveMatch/);
    assert.match(BRAND_MATCH_ON_2026_10, /sent unchanged/);
    assert.equal(CURRENTLY_NOT_IN_STOCK_ON_2026_10.presentOnProductVariant, true);
    assert.equal(CURRENTLY_NOT_IN_STOCK_ON_2026_10.backorderMapped, true);
    assert.match(SORT_KEYS_ON_2026_10, /PRICE and RELEVANCE/);
    assert.match(PRODUCT_QUANTITY_ON_2026_10, /sum of variant quantityAvailable/);
    assert.equal(SEARCH_DOCUMENT.includes("totalCount"), true);
    assert.equal(SEARCH_DOCUMENT.includes("currentlyNotInStock"), true);
    assert.equal(PRODUCTS_DOCUMENT.includes("totalCount"), false);
    assert.equal(PRODUCTS_DOCUMENT.includes("currentlyNotInStock"), true);
    assert.equal(DELEGATE_DOCUMENT.includes("delegateAccessTokenCreate"), true);
    assert.equal(DELEGATE_DOCUMENT.includes("storefrontAccessTokenCreate"), false);

    for (const sort of SEARCH_SORT_FALLBACK_ON_2026_10) {
      const bound = bindSort("search", sort, true);
      assert.equal(bound.sortKey, "RELEVANCE");
      assert.equal(bound.fallback, true);
    }
    assert.deepEqual(SEARCH_SORT_ON_2026_10.price_asc, { sortKey: "PRICE", reverse: false, fallback: false });
    assert.deepEqual(SEARCH_SORT_ON_2026_10.price_desc, { sortKey: "PRICE", reverse: true, fallback: false });
    assert.deepEqual(bindSort("products", "name_asc", true), { sortKey: "TITLE", reverse: false, fallback: false });
    assert.deepEqual(bindSort("products", "name_desc", true), { sortKey: "TITLE", reverse: true, fallback: false });
    assert.deepEqual(bindSort("products", "newest", true), { sortKey: "CREATED_AT", reverse: true, fallback: false });
    assert.deepEqual(bindSort("products", "relevance", false), {
      sortKey: PRODUCT_RELEVANCE_WITHOUT_QUERY_ON_2026_10.sortKey,
      reverse: false,
      fallback: false,
    });
    assert.equal(PRODUCT_RELEVANCE_WITHOUT_QUERY_ON_2026_10.sortKey, "ID");
  });

  it("parses Shopify money strings in decimal arithmetic", () => {
    assert.equal(JSON.stringify(moneyAmount("19.99", "USD")), "19.99");
    assert.equal(JSON.stringify(moneyAmount("10.00", "USD")), "10");
    assert.equal(moneyAmount("19.99", "USD"), 19.99);
    assert.equal(moneyAmount("10.00", "USD"), 10);
  });

  it("strips HTML from descriptionHtml", () => {
    assert.equal(
      plainTextFromHtml("<p>Premium <b>wireless</b> &amp; noise cancelling</p>"),
      "Premium wireless & noise cancelling",
    );
  });

  it("forwards only a public buyer IP", async () => {
    assert.equal(publicBuyerIp("127.0.0.1"), undefined);
    assert.equal(publicBuyerIp("::1"), undefined);
    assert.equal(publicBuyerIp("::ffff:127.0.0.1"), undefined);
    assert.equal(publicBuyerIp("10.1.1.1"), undefined);
    assert.equal(publicBuyerIp("192.168.0.8"), undefined);
    assert.equal(publicBuyerIp("8.8.8.8"), "8.8.8.8");
    assert.equal(publicBuyerIp("2606:4700:4700::1111"), "2606:4700:4700::1111");

    const seen: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(headerRecord(init?.headers));
      return jsonResponse(200, { data: { shop: { name: "Example" } } });
    };
    await shopifyGraphql({
      url: `https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`,
      tokenHeader: "Shopify-Storefront-Private-Token",
      token: DELEGATE_TOKEN,
      query: "query { shop { name } }",
      variables: {},
      buyerIp: "8.8.8.8",
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await shopifyGraphql({
      url: `https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`,
      tokenHeader: "Shopify-Storefront-Private-Token",
      token: DELEGATE_TOKEN,
      query: "query { shop { name } }",
      variables: {},
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    assert.equal(seen[0]?.["Shopify-Storefront-Buyer-IP"], "8.8.8.8");
    assert.equal(seen[1]?.["Shopify-Storefront-Buyer-IP"], undefined);
    assert.equal(seen[0]?.["X-Shopify-Storefront-Access-Token"], undefined);
  });
});

describe("delegate token store", () => {
  it("encrypts the delegate and drops it when the admin token is saved again", async () => {
    const file = tempFile();
    const store = await TokenStore.open(file, randomBytes(32));
    store.save(sampleToken(), FIXED_NOW);
    assert.equal(store.saveDelegate(SHOP, DELEGATE_TOKEN, FIXED_NOW + 3_600_000, FIXED_NOW), true);
    assert.equal(store.getDelegate()?.accessToken, DELEGATE_TOKEN);
    assertPlaintextAbsent(file);
    store.save(sampleToken(), FIXED_NOW + 1);
    assert.equal(store.getDelegate(), null);
    assert.equal(store.get()?.accessToken, ADMIN_TOKEN);
    store.close();
  });
});

describe("POST /api/fastbuyjson/products/search", () => {
  let server: Server;
  let base: string;
  let tokens: TokenStore;
  let file: string;
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let script: Array<() => Response> = [];
  const sleepDelays: number[] = [];

  before(async () => {
    file = tempFile();
    tokens = await TokenStore.open(file, randomBytes(32));
    const deps: ConnectorDeps = {
      app: {
        shopDomain: SHOP,
        clientId: "dev-dashboard-client-id",
        clientSecret: "shpss_test_client_secret_44cd",
        apiVersion: SHOPIFY_API_VERSION,
        appUrl: "https://app.example.com",
      },
      tokens,
      oauthState: new OauthStateStore(),
      now: () => FIXED_NOW,
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({
          url,
          body: bodyText(init?.body),
          headers: headerRecord(init?.headers),
        });
        const next = script.shift();
        if (next === undefined) {
          return jsonResponse(500, { errors: [{ message: "unexpected" }] });
        }
        return next();
      },
    };
    server = createConnectorServer({ implementationVersion: metadata.version, shopDomain: SHOP }, deps);
    const port = await listen(server, 0, "127.0.0.1");
    base = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    calls.length = 0;
    script = [];
    sleepDelays.length = 0;
    tokens.save(sampleToken(), FIXED_NOW);
  });

  after(async () => {
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("maps search results and validates the response schema", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const response = await postSearch(base, {
      query: "headphones",
      extensions: { fastbuyjson: { note: "ignore" }, "x-fastbuyjson": true },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(validateSearchResponse(response.json), true);
    assertSecretsAbsent(response.text);

    const body = response.json as SearchBody;
    assert.equal(body.pagination.totalItems, 3);
    assert.equal(body.pagination.totalPages, 1);
    assert.equal(body.pagination.pageSize, 10);
    assert.equal(body.results.length, 3);

    const headphones = productById(body, "gid://shopify/Product/1001");
    assert.equal(headphones.name, "ACME Wireless Headphones Pro");
    assert.equal(headphones.brand, "Acme");
    assert.equal(headphones.description, "Premium wireless & noise cancelling");
    assert.equal(JSON.stringify(headphones.price.amount), "10");
    assert.equal(headphones.price.currency, "USD");
    assert.equal(headphones.availability?.status, "in_stock");
    assert.equal(headphones.availability?.quantity, 5);
    assert.deepEqual(headphones.categories, ["Headphones", "Audio", "Wireless", "Summer Drop"]);
    assert.equal(headphones.images?.[0]?.alt, "Front");
    assert.equal(Object.hasOwn(headphones.images?.[1] ?? {}, "alt"), false);
    assert.equal(headphones.variants?.[0]?.id, "gid://shopify/ProductVariant/2001");
    assert.deepEqual(headphones.variants?.[0]?.attributes, { Color: "Black", Size: "Large" });
    assert.equal(JSON.stringify(headphones.variants?.[0]?.price?.amount), "19.99");
    assert.equal(JSON.stringify(headphones.variants?.[1]?.price?.amount), "10");
    assert.equal(Object.hasOwn(headphones, "extensions"), false);

    const soldOut = productById(body, "gid://shopify/Product/1002");
    assert.equal(JSON.stringify(soldOut.price.amount), "19.99");
    assert.equal(soldOut.availability?.status, "out_of_stock");
    assert.equal(Object.hasOwn(soldOut.availability ?? {}, "quantity"), false);

    const backorder = productById(body, "gid://shopify/Product/1003");
    assert.equal(backorder.availability?.status, "backorder");
    assert.equal(backorder.availability?.quantity, 0);
    for (const result of body.results) {
      assert.equal(result.availability?.status === "low_stock", false);
      assert.equal(result.availability?.status === "preorder", false);
    }

    const mint = graphqlCall(calls, 0);
    assert.equal(mint.url, `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    assert.equal(mint.headers["X-Shopify-Access-Token"], ADMIN_TOKEN);
    assert.deepEqual(mint.variables.scopes, [...SHOPIFY_SCOPES]);
    assert.equal(mint.query.includes("storefrontAccessTokenCreate"), false);
    const search = graphqlCall(calls, 1);
    assert.equal(search.url, `https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`);
    assert.equal(search.headers["Shopify-Storefront-Private-Token"], DELEGATE_TOKEN);
    assert.equal(search.headers["Shopify-Storefront-Buyer-IP"], undefined);
    assert.equal(search.headers["X-Shopify-Storefront-Access-Token"], undefined);
    assert.equal(search.headers["X-Shopify-Access-Token"], undefined);
    assert.equal(search.variables.sortKey, "RELEVANCE");
    assert.equal(search.variables.query, "headphones");
    assert.equal(search.query.includes("totalCount"), true);
    assertPlaintextAbsent(file);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const again = await postSearch(base, { query: "headphones" });
    assert.equal(again.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).headers["Shopify-Storefront-Private-Token"], DELEGATE_TOKEN);
  });

  it("uses products for filters, keeps the brand string, and counts walked nodes", async () => {
    const fixture = loadFixture("products-catalog.json") as {
      data: { products: Record<string, unknown> };
    };
    assert.equal(Object.hasOwn(fixture.data.products, "totalCount"), false);
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("shop-currency.json")));
    script.push(() => jsonResponse(200, fixture));
    const response = await postSearch(base, {
      filters: {
        brand: "aCmE",
        categories: ["Headphones"],
        priceRange: { min: 10, max: 20, currency: "USD" },
        availability: ["in_stock"],
      },
      sort: "name_asc",
    });
    assert.equal(response.status, 200);
    assert.equal(validateSearchResponse(response.json), true);
    const body = response.json as SearchBody;
    assert.equal(body.pagination.totalItems, 2);
    assert.equal(body.results.length, 2);
    const products = graphqlCall(calls, 2);
    assert.equal(products.query.includes("totalCount"), false);
    assert.equal(products.query.includes("products("), true);
    assert.equal(products.variables.sortKey, "TITLE");
    assert.equal(products.variables.reverse, false);
    assert.equal(products.variables.first, 10);
    const query = products.variables.query;
    assert.equal(typeof query, "string");
    assert.equal(String(query).includes('vendor:"aCmE"'), true);
    assert.equal(String(query).includes('vendor:"Acme"'), false);
    assert.equal(String(query).includes('product_type:"Headphones"'), true);
    assert.equal(String(query).includes('tag:"Headphones"'), true);
    assert.equal(String(query).includes("collection:"), false);
    assert.equal(String(query).includes("variants.price"), false);
    assert.equal(String(query).includes("available_for_sale"), false);
  });

  it("rejects a priceRange currency that is not the shop currency", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("shop-currency.json")));
    const response = await postSearch(base, {
      filters: { priceRange: { min: 1, currency: "EUR" } },
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/);
    assert.equal(validateProblem(response.json), true);
    const problem = response.json as { code?: string; errors?: { field: string }[] };
    assert.equal(problem.code, "VALIDATION_ERROR");
    assert.equal(problem.errors?.[0]?.field, "filters.priceRange.currency");
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 1).query.includes("currencyCode"), true);
    assert.equal(graphqlCall(calls, 1).query.includes("products("), false);
    assertSecretsAbsent(response.text);
  });

  it("keeps a product only when its mapped status is in the availability set", async () => {
    const catalog = loadFixture("search-catalog.json") as { data: { search: Record<string, unknown> } };
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, { data: { products: catalog.data.search } }));
    const inStock = await postSearch(base, { filters: { availability: ["in_stock"] } });
    assert.equal(inStock.status, 200);
    const inStockBody = inStock.json as SearchBody;
    assert.deepEqual(inStockBody.results.map((item) => item.id), ["gid://shopify/Product/1001"]);
    assert.equal(inStockBody.results[0]?.availability?.status, "in_stock");
    const inStockQuery = graphqlCall(calls, 1);
    assert.equal(String(inStockQuery.variables.query ?? "").includes("available_for_sale"), false);
    assert.equal(inStockQuery.query.includes("available:"), false);

    calls.length = 0;
    script.push(() => jsonResponse(200, { data: { products: catalog.data.search } }));
    const mixed = await postSearch(base, { filters: { availability: ["in_stock", "out_of_stock"] } });
    assert.equal(mixed.status, 200);
    const mixedBody = mixed.json as SearchBody;
    assert.deepEqual(
      mixedBody.results.map((item) => item.availability?.status).sort(),
      ["in_stock", "out_of_stock"],
    );
    assert.equal(mixedBody.results.some((item) => item.availability?.status === "backorder"), false);
    assert.equal(String(graphqlCall(calls, 0).variables.query ?? "").includes("available_for_sale"), false);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const backorder = await postSearch(base, { query: "headphones", filters: { availability: ["backorder"] } });
    assert.equal(backorder.status, 200);
    const backorderBody = backorder.json as SearchBody;
    assert.deepEqual(backorderBody.results.map((item) => item.id), ["gid://shopify/Product/1003"]);
    assert.equal(backorderBody.pagination.totalItems, 3);
    const searchCall = graphqlCall(calls, 0);
    assert.equal(searchCall.variables.query, "headphones");
    assert.equal(searchCall.variables.productFilters, null);
  });

  it("does not append categories to the search query", async () => {
    const callerQuery = 'shirt OR hat" OR tag:"Audio';
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const response = await postSearch(base, { query: callerQuery, filters: { categories: ["Audio"] } });
    assert.equal(response.status, 200);
    const body = response.json as SearchBody;
    assert.deepEqual(body.results.map((item) => item.id), ["gid://shopify/Product/1001"]);
    assert.equal(body.results[0]?.categories?.includes("Summer Drop"), true);
    const search = graphqlCall(calls, 1);
    assert.equal(search.variables.query, callerQuery);
    assert.equal(String(search.variables.query).includes("product_type:"), false);
    assert.equal(String(search.variables.query).includes(" AND "), false);
    assert.equal(search.variables.productFilters, null);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const collectionOnly = await postSearch(base, { query: "headphones", filters: { categories: ["Summer Drop"] } });
    assert.equal(collectionOnly.status, 200);
    assert.deepEqual((collectionOnly.json as SearchBody).results, []);
    assert.equal(graphqlCall(calls, 0).variables.query, "headphones");
  });

  it("filters priceRange on the minimum variant price", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("shop-currency.json")));
    script.push(() =>
      jsonResponse(200, {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Product/6100",
                title: "Minimum Inside",
                vendor: "Acme",
                descriptionHtml: "<p>Inside</p>",
                productType: "Hats",
                tags: [],
                availableForSale: true,
                priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
                images: { nodes: [] },
                collections: { nodes: [] },
                variants: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    variantNode("gid://shopify/ProductVariant/6101", "10.00", 1),
                    variantNode("gid://shopify/ProductVariant/6102", "80.00", 1),
                  ],
                },
              },
              {
                id: "gid://shopify/Product/6200",
                title: "Minimum Outside",
                vendor: "Acme",
                descriptionHtml: "<p>Outside</p>",
                productType: "Hats",
                tags: [],
                availableForSale: true,
                priceRange: { minVariantPrice: { amount: "5.00", currencyCode: "USD" } },
                images: { nodes: [] },
                collections: { nodes: [] },
                variants: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    variantNode("gid://shopify/ProductVariant/6201", "5.00", 1),
                    variantNode("gid://shopify/ProductVariant/6202", "15.00", 1),
                  ],
                },
              },
            ],
          },
        },
      }),
    );
    const response = await postSearch(base, { filters: { priceRange: { min: 10, max: 20, currency: "USD" } } });
    assert.equal(response.status, 200);
    const body = response.json as SearchBody;
    assert.deepEqual(body.results.map((item) => item.id), ["gid://shopify/Product/6100"]);
    assert.equal(JSON.stringify(body.results[0]?.price.amount), "10");
    const products = graphqlCall(calls, 2);
    assert.equal(products.variables.query, null);
    assert.equal(products.query.includes("variants.price"), false);
    assert.equal(products.query.includes("price:"), false);
  });

  it("sums quantityAvailable across variant pages and omits a null on a later page", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() =>
      jsonResponse(200, {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Product/7100",
                title: "Paged Quantity",
                vendor: "Acme",
                descriptionHtml: "<p>Paged</p>",
                productType: "Hats",
                tags: [],
                availableForSale: true,
                priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
                images: { nodes: [] },
                collections: { nodes: [] },
                variants: {
                  pageInfo: { hasNextPage: true, endCursor: "variant-cursor" },
                  nodes: [variantNode("gid://shopify/ProductVariant/7101", "10.00", 4)],
                },
              },
            ],
          },
        },
      }),
    );
    script.push(() =>
      jsonResponse(200, {
        data: {
          product: {
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [variantNode("gid://shopify/ProductVariant/7102", "10.00", 6)],
            },
          },
        },
      }),
    );
    const summed = await postSearch(base, {});
    assert.equal(summed.status, 200);
    const summedBody = summed.json as SearchBody;
    assert.equal(summedBody.results[0]?.availability?.quantity, 10);
    const variantCall = graphqlCall(calls, 2);
    assert.equal(variantCall.query.includes("CatalogVariantPage"), true);
    assert.equal(variantCall.variables.id, "gid://shopify/Product/7100");
    assert.equal(variantCall.variables.after, "variant-cursor");

    calls.length = 0;
    script.push(() =>
      jsonResponse(200, {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Product/7200",
                title: "Null Later",
                vendor: "Acme",
                descriptionHtml: "<p>Null</p>",
                productType: "Hats",
                tags: [],
                availableForSale: true,
                priceRange: { minVariantPrice: { amount: "19.99", currencyCode: "USD" } },
                images: { nodes: [] },
                collections: { nodes: [] },
                variants: {
                  pageInfo: { hasNextPage: true, endCursor: "variant-null" },
                  nodes: [variantNode("gid://shopify/ProductVariant/7201", "19.99", 2)],
                },
              },
            ],
          },
        },
      }),
    );
    script.push(() =>
      jsonResponse(200, {
        data: {
          product: {
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [variantNode("gid://shopify/ProductVariant/7202", "19.99", null)],
            },
          },
        },
      }),
    );
    const omitted = await postSearch(base, {});
    assert.equal(omitted.status, 200);
    const omittedProduct = (omitted.json as SearchBody).results[0];
    assert.equal(Object.hasOwn(omittedProduct?.availability ?? {}, "quantity"), false);
    assert.equal(omittedProduct?.availability?.status, "in_stock");
  });

  it("falls back to relevance when search has no name or newest key", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const newest = await postSearch(base, { query: "headphones", sort: "newest" });
    assert.equal(newest.status, 200);
    assert.equal(graphqlCall(calls, 1).variables.sortKey, "RELEVANCE");
    assert.equal(graphqlCall(calls, 1).variables.reverse, false);
    assert.equal(SEARCH_SORT_ON_2026_10.newest.fallback, true);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const price = await postSearch(base, { query: "headphones", sort: "price_desc" });
    assert.equal(price.status, 200);
    assert.equal(graphqlCall(calls, 0).variables.sortKey, "PRICE");
    assert.equal(graphqlCall(calls, 0).variables.reverse, true);
  });

  it("reads totalItems from search totalCount", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("search-total-count.json")));
    const response = await postSearch(base, { query: "hat", pageSize: 1 });
    assert.equal(response.status, 200);
    const body = response.json as SearchBody;
    assert.equal(body.results.length, 1);
    assert.equal(body.pagination.totalItems, 40);
    assert.equal(body.pagination.totalPages, 40);
    assert.equal(calls.length, 2);
  });

  it("walks cursors for a later page and does not scan a filters-only catalog on page 1", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("products-cursor-1.json")));
    script.push(() => jsonResponse(200, loadFixture("products-cursor-2.json")));
    const page = await postSearch(base, { page: 2, pageSize: 1 });
    assert.equal(page.status, 200);
    const body = page.json as SearchBody;
    assert.equal(body.results[0]?.name, "Cursor Second");
    assert.equal(body.pagination.totalItems, 2);
    assert.equal(body.pagination.currentPage, 2);
    assert.equal(graphqlCall(calls, 2).variables.after, "cursor-1");

    calls.length = 0;
    script = [];
    const tooFar = await postSearch(base, { page: 11, pageSize: 100 });
    assert.equal(tooFar.status, 400);
    assert.equal((tooFar.json as { code?: string }).code, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);

    tokens.clearDelegate(SHOP, FIXED_NOW);
    const node = (loadFixture("search-catalog.json") as { data: { search: { nodes: unknown[] } } }).data.search.nodes[0];
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() =>
      jsonResponse(200, {
        data: {
          products: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-more" },
            nodes: Array.from({ length: 10 }, () => node),
          },
        },
      }),
    );
    const firstPage = await postSearch(base, {});
    assert.equal(firstPage.status, 200);
    const firstBody = firstPage.json as SearchBody;
    assert.equal(firstBody.results.length, 10);
    assert.equal(firstBody.pagination.totalItems, 11);
    assert.equal(firstBody.pagination.totalPages, 2);
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 1).variables.first, 10);
    assert.equal(graphqlCall(calls, 1).query.includes("totalCount"), false);
    assertSecretsAbsent(firstPage.text);
  });

  it("retries a Storefront throttle once", async () => {
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const recovered = await postSearch(base, { query: "headphones" });
    assert.equal(recovered.status, 200);
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(SHOPIFY_BACKOFF_MS, 1000);

    calls.length = 0;
    sleepDelays.length = 0;
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const limited = await postSearch(base, { query: "headphones" });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("content-type") ?? "", /^application\/problem\+json/);
    assert.equal(validateProblem(limited.json), true);
    assert.equal((limited.json as { code?: string }).code, "RATE_LIMITED");
    assert.deepEqual(sleepDelays, [1000]);
    assert.equal(calls.length, 2);
    assertSecretsAbsent(limited.text);

    calls.length = 0;
    sleepDelays.length = 0;
    script.push(() => jsonResponse(429, { errors: "Too Many Requests" }));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const http429 = await postSearch(base, { query: "headphones" });
    assert.equal(http429.status, 200);
    assert.deepEqual(sleepDelays, [1000]);
  });

  it("mints again after an admin refresh clears the delegate", async () => {
    tokens.save(sampleToken(FIXED_NOW - 1_000), FIXED_NOW);
    tokens.saveDelegate(SHOP, OLD_DELEGATE, FIXED_NOW + 3_600_000, FIXED_NOW);
    script.push(() =>
      jsonResponse(200, {
        access_token: NEW_ADMIN,
        refresh_token: NEW_REFRESH,
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scope: SHOPIFY_SCOPE_PARAM,
      }),
    );
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const response = await postSearch(base, { query: "headphones" });
    assert.equal(response.status, 200);
    assert.equal(calls[0]?.url, `https://${SHOP}/admin/oauth/access_token`);
    assert.equal(new URLSearchParams(calls[0]?.body).get("grant_type"), "refresh_token");
    assert.equal(graphqlCall(calls, 1).url.includes("/admin/api/"), true);
    assert.equal(graphqlCall(calls, 2).headers["Shopify-Storefront-Private-Token"], DELEGATE_TOKEN);
    assert.equal(tokens.getDelegate()?.accessToken, DELEGATE_TOKEN);
    assert.equal(tokens.get()?.accessToken, NEW_ADMIN);
    assertSecretsAbsent(response.text);
    assertPlaintextAbsent(file);
  });

  it("reuses a stored delegate until it is inside the refresh window", async () => {
    tokens.saveDelegate(SHOP, REUSED_DELEGATE, FIXED_NOW + 3_600_000, FIXED_NOW);
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const reused = await postSearch(base, { query: "headphones" });
    assert.equal(reused.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).headers["Shopify-Storefront-Private-Token"], REUSED_DELEGATE);

    tokens.saveDelegate(SHOP, OLD_DELEGATE, FIXED_NOW + 30_000, FIXED_NOW);
    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("delegate-token.json")));
    script.push(() => jsonResponse(200, loadFixture("search-catalog.json")));
    const reminted = await postSearch(base, { query: "headphones" });
    assert.equal(reminted.status, 200);
    assert.equal(graphqlCall(calls, 0).query.includes("delegateAccessTokenCreate"), true);
    assert.equal(graphqlCall(calls, 1).headers["Shopify-Storefront-Private-Token"], DELEGATE_TOKEN);
  });

  it("returns 400 for an invalid search body and 404 for other commerce routes", async () => {
    const invalid = await postSearch(base, { pageSize: 101 });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.json as { code?: string }).code, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);

    const empty = await postSearchRaw(base, "not-json");
    assert.equal(empty.status, 400);
    assert.equal(calls.length, 0);

    const method = await fetch(`${base}/api/fastbuyjson/products/search`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");

    const lowStock = await postSearch(base, { filters: { availability: ["low_stock", "preorder"] } });
    assert.equal(lowStock.status, 200);
    assert.deepEqual(lowStock.json, {
      results: [],
      pagination: { currentPage: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
    });
    assert.equal(calls.length, 0);

    for (const path of [
      "/api/fastbuyjson/cart",
      "/api/fastbuyjson/checkout/initiate",
      "/api/fastbuyjson/checkout/confirm",
      "/api/fastbuyjson/cart/discount",
    ]) {
      const response = await fetch(`${base}${path}`, { method: "POST" });
      assert.equal(response.status, 404);
    }
    const shipping = await fetch(`${base}/api/fastbuyjson/shipping/options`);
    assert.equal(shipping.status, 404);
    const detect = await fetch(`${base}/api/fastbuyjson/detect`);
    assert.equal(detect.status, 200);
    assert.equal(detect.headers.get("cache-control"), "public, max-age=300");
    assert.equal(calls.length, 0);
  });

  it("clears the admin token when delegate minting is unauthorized", async () => {
    script.push(() => jsonResponse(401, { errors: [{ message: "invalid", extensions: { code: "ACCESS_DENIED" } }] }));
    const response = await postSearch(base, { query: "headphones" });
    assert.equal(response.status, 500);
    assert.equal((response.json as { code?: string }).code, "INTERNAL_ERROR");
    assert.equal(tokens.get()?.accessToken, null);
    assertSecretsAbsent(response.text);
    assertPlaintextAbsent(file);
  });
});

describe("catalog without OAuth", () => {
  it("keeps product search at 404 when no token store is configured", async () => {
    const server = createConnectorServer({ implementationVersion: metadata.version, shopDomain: SHOP });
    const port = await listen(server, 0, "127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/fastbuyjson/products/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function variantNode(id: string, amount: string, quantity: number | null) {
  return {
    id,
    availableForSale: true,
    currentlyNotInStock: false,
    quantityAvailable: quantity,
    selectedOptions: [{ name: "Color", value: "Black" }],
    price: { amount, currencyCode: "USD" },
  };
}

function sampleToken(accessExpiresAt = FIXED_NOW + 3_600_000) {
  return {
    shopDomain: SHOP,
    grantType: "authorization_code" as const,
    accessToken: ADMIN_TOKEN,
    accessExpiresAt,
    refreshToken: REFRESH_TOKEN,
    refreshExpiresAt: FIXED_NOW + 7_776_000_000,
  };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fastbuyjson-catalog-")), "tokens.sqlite");
}

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(metadata.root, "tests", "fixtures", name), "utf8")) as unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bodyText(body: RequestInit["body"]): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return "";
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}

function graphqlCall(
  calls: { url: string; body: string; headers: Record<string, string> }[],
  index: number,
): GraphqlCall {
  const call = calls[index];
  assert.ok(call);
  const parsed = JSON.parse(call.body) as { query?: unknown; variables?: unknown };
  assert.equal(typeof parsed.query, "string");
  assert.equal(typeof parsed.variables, "object");
  return {
    url: call.url,
    headers: call.headers,
    query: parsed.query as string,
    variables: parsed.variables as Record<string, unknown>,
  };
}

function productById(body: SearchBody, id: string): ProductResult {
  const product = body.results.find((item) => item.id === id);
  assert.ok(product);
  return product;
}

async function postSearch(base: string, body: unknown): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  return postSearchRaw(base, JSON.stringify(body));
}

async function postSearchRaw(
  base: string,
  body: string,
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const response = await fetch(`${base}/api/fastbuyjson/products/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function assertSecretsAbsent(text: string): void {
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, secret);
  }
}

function assertPlaintextAbsent(file: string): void {
  const bytes = readFileSync(file);
  for (const secret of SECRETS) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, secret);
  }
}

function validateSearchResponse(body: unknown): boolean {
  return validateSchema("product-search-response.json", body);
}

function validateProblem(body: unknown): boolean {
  return validateSchema("error.json", body);
}

function validateSchema(name: string, body: unknown): boolean {
  const schema = JSON.parse(readFileSync(join(metadata.root, "schemas", name), "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormatsModule.default(ajv, ["uri"]);
  const validate = ajv.compile(schema);
  const ok = validate(body);
  assert.deepEqual(validate.errors ?? [], []);
  return ok === true;
}
