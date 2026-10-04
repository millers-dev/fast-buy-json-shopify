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
import {
  CART_CREATE_DOCUMENT,
  CART_DISCOUNT_CODES_UPDATE_DOCUMENT,
  CART_LINES_ADD_DOCUMENT,
  CART_LINES_REMOVE_DOCUMENT,
  CART_LINES_UPDATE_DOCUMENT,
  CART_QUERY_DOCUMENT,
} from "../src/cart-query.js";
import type { ConnectorDeps } from "../src/deps.js";
import { CART_ADD_ROUTE, IDEMPOTENCY_TTL_MS, computeIdempotencyFingerprint } from "../src/idempotency.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { createConnectorServer, listen } from "../src/server.js";
import { SHOPIFY_BACKOFF_MS } from "../src/shopify-graphql.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const ADMIN_TOKEN = "shpat_cart_admin_token";
const REFRESH_TOKEN = "shprt_cart_refresh_token";
const DELEGATE_TOKEN = "shppa_delegate_cart_test";
const FIXED_NOW = 1_700_000_000_000;
const SHOPIFY_CART_ID = "gid://shopify/Cart/c1?key=super-secret-cart-key";
const CART_SECRET = "super-secret-cart-key";
const CHECKOUT_URL = "https://example.myshopify.com/cart/c/c1?key=super-secret-cart-key";
const LINE_GID = "gid://shopify/CartLine/line-a";
const LINE_LARGE_GID = "gid://shopify/CartLine/line-b";
const VARIANT_GID = "gid://shopify/ProductVariant/2001";
const VARIANT_LARGE_GID = "gid://shopify/ProductVariant/2002";
const PRODUCT_GID = "gid://shopify/Product/900";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GraphqlCall = {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

type MoneyV2 = { amount: string; currencyCode: string };

type CartLineNode = {
  id: string;
  quantity: number;
  merchandise: {
    id: string;
    title: string;
    selectedOptions: { name: string; value: string }[];
    product: { title: string };
  };
  cost: { amountPerQuantity: MoneyV2; totalAmount: MoneyV2 };
};

type ShopifyCart = {
  id: string;
  checkoutUrl: string;
  attributes: { key: string; value: string }[];
  lines: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: CartLineNode[] };
  cost: {
    subtotalAmount: MoneyV2;
    totalAmount: MoneyV2;
    totalTaxAmount: MoneyV2 | null;
    totalDutyAmount: MoneyV2 | null;
  };
  discountAllocations: unknown[];
};

type CartItem = {
  itemId: string;
  productId: string;
  quantity: number;
  name?: string;
  price: { amount: number; currency: string };
  lineTotal: { amount: number; currency: string };
  options?: Record<string, string>;
};

type CartBody = {
  cart: {
    id: string;
    items: CartItem[];
    appliedDiscounts?: {
      code?: string;
      label?: string;
      type?: string;
      amount: { amount: number; currency: string };
    }[];
    totals: {
      currency: string;
      subtotal: number;
      discount: number;
      total: number;
      tax?: number;
      discountBreakdown?: { amount: number; code?: string; label?: string }[];
    };
    created: string;
    updated: string;
    extensions?: Record<string, unknown>;
  };
  message?: string;
  extensions?: unknown;
};

type ProblemBody = {
  status: number;
  code: string;
  detail?: string;
  errors?: { field: string; message: string }[];
};

type HttpResult = { status: number; headers: Headers; json: unknown; text: string };

describe("cart documents and idempotency fingerprint", () => {
  it("does not select checkoutUrl or mint a public storefront token", () => {
    for (const document of [
      CART_CREATE_DOCUMENT,
      CART_LINES_ADD_DOCUMENT,
      CART_LINES_UPDATE_DOCUMENT,
      CART_LINES_REMOVE_DOCUMENT,
      CART_QUERY_DOCUMENT,
      CART_DISCOUNT_CODES_UPDATE_DOCUMENT,
    ]) {
      assert.equal(document.includes("checkoutUrl"), false);
      assert.equal(document.includes("storefrontAccessTokenCreate"), false);
    }
    assert.equal(CART_DISCOUNT_CODES_UPDATE_DOCUMENT.includes("cartDiscountCodesUpdate"), true);
    assert.equal(CART_DISCOUNT_CODES_UPDATE_DOCUMENT.includes("discountCodes"), true);
    assert.equal(CART_DISCOUNT_CODES_UPDATE_DOCUMENT.includes("applicable"), true);
  });

  it("canonicalizes the cart add fingerprint", () => {
    const first = computeIdempotencyFingerprint("POST", CART_ADD_ROUTE, {
      productId: VARIANT_GID,
      quantity: 1,
    });
    const reordered = computeIdempotencyFingerprint("POST", CART_ADD_ROUTE, {
      quantity: 1,
      productId: VARIANT_GID,
    });
    const changed = computeIdempotencyFingerprint("POST", CART_ADD_ROUTE, {
      productId: VARIANT_GID,
      quantity: 2,
    });
    assert.equal(first, reordered);
    assert.notEqual(first, changed);
    assert.equal(CART_ADD_ROUTE, "/cart/add");
  });
});

describe("anonymous Storefront cart", { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let tokens: TokenStore;
  let file: string;
  let now = FIXED_NOW;
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let script: Array<() => Response> = [];
  const sleepDelays: number[] = [];
  const logs: string[] = [];
  const originalError = console.error;

  before(async () => {
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    file = tempFile();
    tokens = await TokenStore.open(file, randomBytes(32));
    installScript(script);
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
      now: () => now,
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
    now = FIXED_NOW;
    calls.length = 0;
    script.length = 0;
    sleepDelays.length = 0;
    logs.length = 0;
    tokens.save(sampleToken(), FIXED_NOW);
    assert.equal(tokens.saveDelegate(SHOP, DELEGATE_TOKEN, null, FIXED_NOW), true);
    tokens.clearAnonymousCart();
    tokens.clearIdempotency();
  });

  after(async () => {
    console.error = originalError;
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns CART_NOT_FOUND before the first add without calling Shopify", async () => {
    const missing = await request(base, "GET", "/api/fastbuyjson/cart");
    assertProblem(missing, 404, "CART_NOT_FOUND");
    assert.equal(missing.json && (missing.json as ProblemBody).detail, "No cart exists for the current identity");
    const byId = await request(base, "GET", "/api/fastbuyjson/cart/11111111-1111-4111-8111-111111111111");
    assertProblem(byId, 404, "CART_NOT_FOUND");
    const remove = await request(base, "DELETE", "/api/fastbuyjson/cart");
    assertProblem(remove, 404, "CART_NOT_FOUND");
    assert.equal(calls.length, 0);
    assert.equal(tokens.getAnonymousCart(SHOP), null);
  });

  it("creates a cart, keeps Shopify's money, and hides the cart key", async () => {
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const response = await request(base, "POST", "/api/fastbuyjson/cart/add", {
      productId: VARIANT_GID,
      quantity: 1,
    });
    const body = assertCart(response);
    assert.equal(body.message, "Item added to cart successfully");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body.cart.id, UUID);
    assert.equal(body.cart.items.length, 1);
    const item = body.cart.items[0];
    assert.ok(item);
    assert.match(item.itemId, UUID);
    assert.equal(item.productId, VARIANT_GID);
    assert.equal(item.quantity, 1);
    assert.equal(item.name, "ACME Wireless Headphones Pro");
    assert.equal(JSON.stringify(item.price.amount), "19.99");
    assert.equal(item.price.currency, "USD");
    assert.equal(JSON.stringify(item.lineTotal.amount), "19.99");
    assert.equal(JSON.stringify(body.cart.totals.tax), "10");
    assert.equal(body.cart.totals.subtotal, 19.99);
    assert.equal(body.cart.totals.discount, 0);
    assert.equal(body.cart.totals.total, 30);
    assert.equal(body.extensions, undefined);

    assert.equal(calls.length, 2);
    const lookup = graphqlCall(calls, 0);
    const created = graphqlCall(calls, 1);
    expectStorefront(lookup);
    expectStorefront(created);
    assert.equal(lookup.query.includes("node(id:"), true);
    assert.deepEqual(lookup.variables, { id: VARIANT_GID });
    assert.equal(created.query.includes("cartCreate"), true);
    assert.equal(created.query.includes("cartLinesAdd"), false);
    assert.deepEqual(created.variables, { input: { lines: [{ merchandiseId: VARIANT_GID, quantity: 1 }] } });

    const stored = tokens.getAnonymousCart(SHOP);
    assert.ok(stored);
    assert.equal(stored.cartId, body.cart.id);
    assert.equal(stored.shopifyCartId, SHOPIFY_CART_ID);
    assert.equal(stored.lines[0]?.lineGid, LINE_GID);
    assert.equal(stored.lines[0]?.itemId, item.itemId);
    assertPlaintextAbsent(file);

    calls.length = 0;
    script.push(() => jsonResponse(200, queryResponse(snapshotCart())));
    const fetched = assertCart(await request(base, "GET", "/api/fastbuyjson/cart"));
    assert.equal(fetched.message, undefined);
    assert.equal(fetched.cart.id, body.cart.id);
    assert.equal(fetched.cart.items[0]?.itemId, item.itemId);
    assert.equal(JSON.stringify(fetched.cart.items[0]?.price.amount), "19.99");
    const fetchCall = graphqlCall(calls, 0);
    expectStorefront(fetchCall);
    assert.deepEqual(fetchCall.variables, { id: SHOPIFY_CART_ID });

    calls.length = 0;
    script.push(() => jsonResponse(200, queryResponse(snapshotCart())));
    const byId = assertCart(await request(base, "GET", `/api/fastbuyjson/cart/${body.cart.id}`));
    assert.equal(byId.cart.id, body.cart.id);
    calls.length = 0;
    const wrong = await request(base, "GET", "/api/fastbuyjson/cart/22222222-2222-4222-8222-222222222222");
    assertProblem(wrong, 404, "CART_NOT_FOUND");
    assert.equal(calls.length, 0);
  });

  it("reuses the Shopify cart id and the line UUID when a variant is merged", async () => {
    const first = await addDefault();
    const itemId = first.cart.items[0]?.itemId;
    assert.ok(itemId);
    calls.length = 0;

    const merged = snapshotCart();
    const line = merged.lines.nodes[0];
    assert.ok(line);
    line.quantity = 3;
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, mutationResponse("cartLinesAdd", merged)));
    const second = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 2 }),
    );
    assert.equal(second.cart.id, first.cart.id);
    assert.equal(second.cart.items.length, 1);
    assert.equal(second.cart.items[0]?.itemId, itemId);
    assert.equal(second.cart.items[0]?.quantity, 3);
    const added = graphqlCall(calls, 1);
    expectStorefront(added);
    assert.equal(added.query.includes("cartLinesAdd"), true);
    assert.equal(added.query.includes("cartCreate"), false);
    assert.deepEqual(added.variables, {
      cartId: SHOPIFY_CART_ID,
      lines: [{ merchandiseId: VARIANT_GID, quantity: 2 }],
    });
    assert.equal(tokens.getAnonymousCart(SHOP)?.shopifyCartId, SHOPIFY_CART_ID);

    calls.length = 0;
    const both = snapshotCart();
    const firstLine = both.lines.nodes[0];
    assert.ok(firstLine);
    firstLine.quantity = 3;
    both.lines.nodes.push(lineNode(LINE_LARGE_GID, VARIANT_LARGE_GID, "Large", "Size", "Large"));
    pushVariant(VARIANT_LARGE_GID);
    script.push(() => jsonResponse(200, mutationResponse("cartLinesAdd", both)));
    const third = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_LARGE_GID, quantity: 1 }),
    );
    assert.equal(third.cart.id, first.cart.id);
    assert.equal(third.cart.items.length, 2);
    assert.equal(third.cart.items[0]?.itemId, itemId);
    assert.match(third.cart.items[1]?.itemId ?? "", UUID);
    assert.notEqual(third.cart.items[1]?.itemId, itemId);
    assert.equal(third.cart.items[1]?.productId, VARIANT_LARGE_GID);
    const thirdCall = graphqlCall(calls, 1);
    assert.equal(thirdCall.variables.cartId, SHOPIFY_CART_ID);
    assert.equal(tokens.getAnonymousCart(SHOP)?.lines[1]?.lineGid, LINE_LARGE_GID);
  });

  it("updates and removes a line with the stored CartLine GID", async () => {
    const created = await addDefault();
    const itemId = created.cart.items[0]?.itemId;
    assert.ok(itemId);
    calls.length = 0;

    const updatedCart = snapshotCart();
    const updatedLine = updatedCart.lines.nodes[0];
    assert.ok(updatedLine);
    updatedLine.quantity = 4;
    script.push(() => jsonResponse(200, mutationResponse("cartLinesUpdate", updatedCart)));
    const patched = assertCart(
      await request(base, "PATCH", `/api/fastbuyjson/cart/items/${itemId}`, { quantity: 4 }, {
        "Idempotency-Key": "patch-does-not-honor",
      }),
    );
    assert.equal(patched.message, undefined);
    assert.equal(patched.cart.items[0]?.quantity, 4);
    assert.equal(patched.cart.items[0]?.itemId, itemId);
    const update = graphqlCall(calls, 0);
    expectStorefront(update);
    assert.equal(update.query.includes("cartLinesUpdate"), true);
    assert.deepEqual(update.variables, { cartId: SHOPIFY_CART_ID, lines: [{ id: LINE_GID, quantity: 4 }] });

    calls.length = 0;
    const missing = await request(base, "PATCH", "/api/fastbuyjson/cart/items/33333333-3333-4333-8333-333333333333", {
      quantity: 2,
    });
    assertProblem(missing, 404, "CART_ITEM_NOT_FOUND");
    assert.equal(calls.length, 0);

    script.push(() => jsonResponse(200, mutationResponse("cartLinesRemove", emptyCart(snapshotCart()))));
    const removed = assertCart(await request(base, "DELETE", `/api/fastbuyjson/cart/items/${itemId}`));
    assert.equal(removed.cart.id, created.cart.id);
    assert.deepEqual(removed.cart.items, []);
    const remove = graphqlCall(calls, 0);
    assert.deepEqual(remove.variables, { cartId: SHOPIFY_CART_ID, lineIds: [LINE_GID] });
    assert.equal(remove.query.includes("cartLinesRemove"), true);
  });

  it("clears every line and keeps the FastBuyJSON cart id for the next add", async () => {
    const created = await addDefault();
    calls.length = 0;
    script.push(() => jsonResponse(200, mutationResponse("cartLinesRemove", emptyCart(snapshotCart()))));
    const cleared = assertCart(await request(base, "DELETE", "/api/fastbuyjson/cart"));
    assert.equal(cleared.cart.id, created.cart.id);
    assert.deepEqual(cleared.cart.items, []);
    assert.equal(cleared.cart.totals.subtotal, 0);
    assert.equal(cleared.cart.totals.discount, 0);
    assert.equal(cleared.cart.totals.total, 0);
    assert.equal(cleared.cart.totals.tax, undefined);
    assert.equal(cleared.message, undefined);
    const remove = graphqlCall(calls, 0);
    assert.deepEqual(remove.variables, { cartId: SHOPIFY_CART_ID, lineIds: [LINE_GID] });
    assert.equal(tokens.getAnonymousCart(SHOP)?.cartId, created.cart.id);
    assert.equal(tokens.getAnonymousCart(SHOP)?.shopifyCartId, SHOPIFY_CART_ID);
    assert.deepEqual(tokens.getAnonymousCart(SHOP)?.lines, []);

    calls.length = 0;
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, mutationResponse("cartLinesAdd", snapshotCart())));
    const again = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }),
    );
    assert.equal(again.cart.id, created.cart.id);
    const added = graphqlCall(calls, 1);
    assert.equal(added.query.includes("cartLinesAdd"), true);
    assert.equal(added.query.includes("cartCreate"), false);
    assert.equal(added.variables.cartId, SHOPIFY_CART_ID);
  });

  it("replays a 2xx add and rejects a different fingerprint with 409", async () => {
    const key = "add-once";
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const first = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": key,
      }),
    );
    assert.equal(first.message, "Item added to cart successfully");
    assert.equal(calls.length, 2);
    const fingerprint = computeIdempotencyFingerprint("POST", CART_ADD_ROUTE, {
      productId: VARIANT_GID,
      quantity: 1,
    });
    assert.equal(tokens.lookupIdempotency("anonymous", key, fingerprint, now).kind, "replay");

    const replay = assertCart(
      await request(
        base,
        "POST",
        "/api/fastbuyjson/cart/add",
        { quantity: 1, productId: VARIANT_GID },
        { "Idempotency-Key": key },
      ),
    );
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(replay.json, first.json);
    assert.equal(calls.length, 2);

    const conflict = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 2 }, {
      "Idempotency-Key": key,
    });
    assertProblem(conflict, 409, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal(calls.length, 2);
    assert.equal(tokens.lookupIdempotency("anonymous", key, fingerprint, now).kind, "replay");

    const still = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": key,
      }),
    );
    assert.equal(still.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(still.json, first.json);
    assert.equal(calls.length, 2);
  });

  it("does not store failed adds, expires the key, and ignores it on PATCH and DELETE", async () => {
    const key = "add-fails-then-works";
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-user-error.json")));
    const rejected = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
      "Idempotency-Key": key,
    });
    assertProblem(rejected, 400, "VALIDATION_ERROR");
    assert.notEqual(rejected.status, 422);
    const problem = rejected.json as ProblemBody;
    assert.equal(problem.detail, "The product is out of stock");
    assert.equal(problem.errors?.[0]?.field, "lines.0.quantity");
    assert.equal(tokens.getAnonymousCart(SHOP), null);
    assert.equal(calls.length, 2);

    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const created = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": key,
      }),
    );
    assert.equal(created.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 4);
    assert.equal(graphqlCall(calls, 3).query.includes("cartCreate"), true);
    const itemId = created.cart.items[0]?.itemId;
    assert.ok(itemId);

    calls.length = 0;
    const updated = snapshotCart();
    const line = updated.lines.nodes[0];
    assert.ok(line);
    line.quantity = 4;
    script.push(() => jsonResponse(200, mutationResponse("cartLinesUpdate", updated)));
    const patched = assertCart(
      await request(base, "PATCH", `/api/fastbuyjson/cart/items/${itemId}`, { quantity: 4 }, { "Idempotency-Key": key }),
    );
    assert.equal(patched.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 1);
    assert.deepEqual(graphqlCall(calls, 0).variables, {
      cartId: SHOPIFY_CART_ID,
      lines: [{ id: LINE_GID, quantity: 4 }],
    });

    script.push(() => jsonResponse(200, mutationResponse("cartLinesRemove", emptyCart(snapshotCart()))));
    const removed = assertCart(
      await request(base, "DELETE", `/api/fastbuyjson/cart/items/${itemId}`, undefined, { "Idempotency-Key": key }),
    );
    assert.equal(removed.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 2);

    tokens.clearAnonymousCart();
    tokens.clearIdempotency();
    calls.length = 0;
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const stored = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": "expires",
      }),
    );
    now = FIXED_NOW + IDEMPOTENCY_TTL_MS;
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, mutationResponse("cartLinesAdd", snapshotCart())));
    const afterExpiry = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": "expires",
      }),
    );
    assert.equal(afterExpiry.headers.get("idempotency-replayed"), null);
    assert.equal(afterExpiry.cart.id, stored.cart.id);
    assert.equal(calls.length, 4);
    assert.equal(graphqlCall(calls, 3).query.includes("cartLinesAdd"), true);
    assert.equal(graphqlCall(calls, 3).variables.cartId, SHOPIFY_CART_ID);
  });

  it("resolves a variant, one variant, matching options, an ambiguous product, and an unknown id", async () => {
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const variant = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }),
    );
    assert.equal(variant.cart.items[0]?.productId, VARIANT_GID);
    assert.deepEqual(graphqlCall(calls, 1).variables, {
      input: { lines: [{ merchandiseId: VARIANT_GID, quantity: 1 }] },
    });

    tokens.clearAnonymousCart();
    calls.length = 0;
    script.push(() =>
      jsonResponse(200, {
        data: {
          product: {
            id: PRODUCT_GID,
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: VARIANT_GID, selectedOptions: [{ name: "Color", value: "Black" }] }],
            },
          },
        },
      }),
    );
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const only = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", {
        productId: PRODUCT_GID,
        quantity: 1,
        options: { color: "red" },
      }),
    );
    assert.equal(only.cart.items[0]?.productId, VARIANT_GID);
    assert.equal(graphqlCall(calls, 0).query.includes("product(id:"), true);
    assert.deepEqual(graphqlCall(calls, 1).variables, {
      input: { lines: [{ merchandiseId: VARIANT_GID, quantity: 1 }] },
    });

    tokens.clearAnonymousCart();
    calls.length = 0;
    pushProductVariants();
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const matched = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", {
        productId: PRODUCT_GID,
        quantity: 1,
        options: { Color: "black", Size: "SMALL" },
      }),
    );
    assert.equal(matched.cart.items[0]?.productId, VARIANT_GID);
    assert.deepEqual(graphqlCall(calls, 1).variables, {
      input: { lines: [{ merchandiseId: VARIANT_GID, quantity: 1 }] },
    });

    tokens.clearAnonymousCart();
    calls.length = 0;
    pushProductVariants();
    const colorOnly = await request(base, "POST", "/api/fastbuyjson/cart/add", {
      productId: PRODUCT_GID,
      quantity: 1,
      options: { color: "Black" },
    });
    assertProblem(colorOnly, 400, "VALIDATION_ERROR");
    assert.equal((colorOnly.json as ProblemBody).errors?.[0]?.field, "productId");
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).query.includes("cartCreate"), false);
    assert.equal(tokens.getAnonymousCart(SHOP), null);

    calls.length = 0;
    pushProductVariants();
    const noOptions = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: PRODUCT_GID, quantity: 1 });
    assertProblem(noOptions, 400, "VALIDATION_ERROR");
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).query.includes("cartCreate"), false);

    calls.length = 0;
    script.push(() => jsonResponse(200, { data: { product: null } }));
    const unknownProduct = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: PRODUCT_GID });
    assertProblem(unknownProduct, 404, "PRODUCT_NOT_FOUND");
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).query.includes("cartCreate"), false);

    const beforeSku = calls.length;
    const unknownSku = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: "acme-wh-001" });
    assertProblem(unknownSku, 404, "PRODUCT_NOT_FOUND");
    const unknownWord = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: "nope" });
    assertProblem(unknownWord, 404, "PRODUCT_NOT_FOUND");
    assert.equal(calls.length, beforeSku);
  });

  it("hides a userError that contains the cart key and answers 400", async () => {
    pushVariant(VARIANT_GID);
    script.push(() =>
      jsonResponse(200, {
        data: {
          cartCreate: {
            cart: { id: SHOPIFY_CART_ID, checkoutUrl: CHECKOUT_URL },
            userErrors: [{ field: ["cart"], message: `rejected ${CHECKOUT_URL}`, code: "INVALID" }],
          },
        },
      }),
    );
    const response = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 });
    assertProblem(response, 400, "VALIDATION_ERROR");
    assert.equal((response.json as ProblemBody).detail, "Shopify rejected the cart change.");
    assert.equal(tokens.getAnonymousCart(SHOP), null);
  });

  it("backs off once on Shopify throttling and does not store the cart or the idempotency key", async () => {
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const limited = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
      "Idempotency-Key": "throttled-add",
    });
    assertProblem(limited, 429, "RATE_LIMITED");
    assert.equal((limited.json as ProblemBody).detail, "Shopify throttled the cart request.");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(tokens.getAnonymousCart(SHOP), null);
    const beforeGet = calls.length;
    const missing = await request(base, "GET", "/api/fastbuyjson/cart");
    assertProblem(missing, 404, "CART_NOT_FOUND");
    assert.equal(calls.length, beforeGet);

    calls.length = 0;
    sleepDelays.length = 0;
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(429, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const recovered = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": "throttled-add",
      }),
    );
    assert.equal(recovered.headers.get("idempotency-replayed"), null);
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.length, 3);
    expectStorefront(graphqlCall(calls, 2));
  });

  it("echoes caller extensions and ignores a bearer token", async () => {
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const added = assertCart(
      await request(
        base,
        "POST",
        "/api/fastbuyjson/cart/add",
        { productId: VARIANT_GID, quantity: 1, extensions: { note: "gift" } },
        { Authorization: "Bearer not-a-commerce-token" },
      ),
    );
    assert.notEqual(added.status, 401);
    assert.equal(added.extensions, undefined);
    assert.deepEqual(added.cart.extensions, { note: "gift" });
    assert.equal(added.text.includes("attributes"), false);
    assert.equal(tokens.getAnonymousCart(SHOP)?.extensions && JSON.stringify(tokens.getAnonymousCart(SHOP)?.extensions), JSON.stringify({ note: "gift" }));

    calls.length = 0;
    const merged = snapshotCart();
    const line = merged.lines.nodes[0];
    assert.ok(line);
    line.quantity = 2;
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, mutationResponse("cartLinesAdd", merged)));
    const second = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }),
    );
    assert.deepEqual(second.cart.extensions, { note: "gift" });

    calls.length = 0;
    script.push(() => jsonResponse(200, queryResponse(merged)));
    const fetched = assertCart(await request(base, "GET", "/api/fastbuyjson/cart"));
    assert.deepEqual(fetched.cart.extensions, { note: "gift" });
    assert.equal(fetched.message, undefined);
  });

  it("applies one code, replaces it with a second code, and ignores Idempotency-Key", async () => {
    const key = "add-then-discount";
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const created = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": key,
      }),
    );
    calls.length = 0;

    const summer = snapshotCart();
    summer.discountAllocations = [
      codeAllocation("Save10", "2.00", "Summer sale"),
      titledAllocation("Automatic markdown", "1.50"),
      titledAllocation("Custom adjust", "0.50"),
    ];
    script.push(() => jsonResponse(200, discountResponse(summer, [{ code: "Save10", applicable: true }])));
    const applied = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "  Save10  " }, { "Idempotency-Key": key }),
    );
    assert.equal(applied.headers.get("idempotency-replayed"), null);
    assert.equal(applied.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(applied.cart.id, created.cart.id);
    assert.equal(applied.message, undefined);
    assert.equal(applied.cart.totals.discount, 4);
    assert.deepEqual(applied.cart.appliedDiscounts, [
      { code: "Save10", label: "Summer sale", amount: { amount: 2, currency: "USD" } },
    ]);
    assert.equal(applied.cart.appliedDiscounts?.[0] !== undefined && "type" in applied.cart.appliedDiscounts[0], false);
    assert.deepEqual(applied.cart.totals.discountBreakdown, [
      { amount: 2, code: "Save10", label: "Summer sale" },
      { amount: 1.5, label: "Automatic markdown" },
      { amount: 0.5, label: "Custom adjust" },
    ]);
    const update = graphqlCall(calls, 0);
    expectStorefront(update);
    assert.equal(update.query.includes("cartDiscountCodesUpdate"), true);
    assert.deepEqual(update.variables, { cartId: SHOPIFY_CART_ID, discountCodes: ["Save10"] });

    const welcome = snapshotCart();
    welcome.discountAllocations = [codeAllocation("Welcome5", "5.00")];
    script.push(() => jsonResponse(200, discountResponse(welcome, [{ code: "Welcome5", applicable: true }])));
    const replaced = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "Welcome5" }, { "Idempotency-Key": key }),
    );
    assert.equal(replaced.headers.get("idempotency-replayed"), null);
    assert.equal(replaced.cart.id, created.cart.id);
    assert.equal(replaced.cart.totals.discount, 5);
    assert.deepEqual(replaced.cart.appliedDiscounts, [
      { code: "Welcome5", label: "Welcome5", amount: { amount: 5, currency: "USD" } },
    ]);
    assert.deepEqual(graphqlCall(calls, 1).variables, { cartId: SHOPIFY_CART_ID, discountCodes: ["Welcome5"] });
    const addFingerprint = computeIdempotencyFingerprint("POST", CART_ADD_ROUTE, {
      productId: VARIANT_GID,
      quantity: 1,
    });
    assert.equal(tokens.lookupIdempotency("anonymous", key, addFingerprint, now).kind, "replay");

    calls.length = 0;
    const replay = assertCart(
      await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }, {
        "Idempotency-Key": key,
      }),
    );
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal(calls.length, 0);
    assert.equal(logs.join("\n").includes("key="), false);
    assert.equal(logs.join("\n").includes(LINE_GID), false);
  });

  it("clears discount codes for null, an empty body, an empty string, and whitespace", async () => {
    const created = await addDefault();
    calls.length = 0;
    const bodies: unknown[] = [undefined, {}, { code: null }, { code: "" }, { code: " \n\t " }, "   "];
    for (const body of bodies) {
      script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [])));
      const cleared = assertCart(await request(base, "POST", "/api/fastbuyjson/cart/discount", body));
      assert.equal(cleared.cart.id, created.cart.id);
      assert.equal(cleared.cart.totals.discount, 0);
      assert.equal(cleared.cart.appliedDiscounts, undefined);
    }
    assert.equal(calls.length, bodies.length);
    for (let index = 0; index < bodies.length; index += 1) {
      const call = graphqlCall(calls, index);
      expectStorefront(call);
      assert.deepEqual(call.variables, { cartId: SHOPIFY_CART_ID, discountCodes: [] });
    }
  });

  it("returns 422 and removes a code Shopify marks inapplicable", async () => {
    const created = await addDefault();
    calls.length = 0;
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [{ code: "NOPE", applicable: false }])));
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [])));
    const response = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "NOPE" });
    assertProblem(response, 422, "INVALID_DISCOUNT_CODE");
    assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const problem = response.json as { type?: string; cart?: unknown };
    assert.equal(problem.type, "https://fastbuyjson.org/problems/invalid-discount-code");
    assert.equal(problem.cart, undefined);
    assert.equal(calls.length, 2);
    assert.deepEqual(graphqlCall(calls, 0).variables, { cartId: SHOPIFY_CART_ID, discountCodes: ["NOPE"] });
    assert.deepEqual(graphqlCall(calls, 1).variables, { cartId: SHOPIFY_CART_ID, discountCodes: [] });
    assert.equal(tokens.getAnonymousCart(SHOP)?.cartId, created.cart.id);
    assert.equal(logs.join("\n").includes(SHOPIFY_CART_ID), false);
  });

  it("returns 500 when the follow-up that removes an inapplicable code fails", async () => {
    await addDefault();
    calls.length = 0;
    sleepDelays.length = 0;
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [{ code: "NOPE", applicable: false }])));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const throttled = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "NOPE" });
    assertProblem(throttled, 500, "INTERNAL_ERROR");
    assert.equal((throttled.json as { cart?: unknown }).cart, undefined);
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.length, 3);
    assert.deepEqual(graphqlCall(calls, 1).variables, { cartId: SHOPIFY_CART_ID, discountCodes: [] });

    calls.length = 0;
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [{ code: "NOPE", applicable: false }])));
    script.push(() =>
      jsonResponse(200, {
        data: {
          cartDiscountCodesUpdate: {
            userErrors: [{ field: ["discountCodes"], message: "Could not remove", code: "INVALID" }],
          },
        },
      }),
    );
    const rejected = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "NOPE" });
    assertProblem(rejected, 500, "INTERNAL_ERROR");
    assert.notEqual(rejected.status, 422);
    assert.equal(calls.length, 2);
  });

  it("maps discount userErrors to 400 and throttling to 429", async () => {
    await addDefault();
    calls.length = 0;
    script.push(() =>
      jsonResponse(200, {
        data: {
          cartDiscountCodesUpdate: {
            cart: null,
            userErrors: [{ field: ["discountCodes", "0"], message: "Code is invalid", code: "INVALID" }],
          },
        },
      }),
    );
    const rejected = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "NOPE" });
    assertProblem(rejected, 400, "VALIDATION_ERROR");
    assert.notEqual(rejected.status, 422);
    assert.equal((rejected.json as ProblemBody).detail, "Code is invalid");
    assert.equal(calls.length, 1);

    calls.length = 0;
    sleepDelays.length = 0;
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const limited = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "Save10" }, {
      "Idempotency-Key": "discount-throttle",
    });
    assertProblem(limited, 429, "RATE_LIMITED");
    assert.equal((limited.json as ProblemBody).detail, "Shopify throttled the cart request.");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(limited.headers.get("idempotency-replayed"), null);
  });

  it("returns CART_NOT_FOUND and 400 without calling Shopify when the discount cannot run", async () => {
    const missing = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: "Save10" });
    assertProblem(missing, 404, "CART_NOT_FOUND");
    assert.equal((missing.json as ProblemBody).detail, "No cart exists for the current identity");
    const notJson = await request(base, "POST", "/api/fastbuyjson/cart/discount", "not-json");
    assertProblem(notJson, 400, "VALIDATION_ERROR");
    const wrongType = await request(base, "POST", "/api/fastbuyjson/cart/discount", { code: 1 });
    assertProblem(wrongType, 400, "VALIDATION_ERROR");
    const method = await request(base, "GET", "/api/fastbuyjson/cart/discount");
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");
    assert.equal(calls.length, 0);
  });

  it("leaves shipping, orders, and POST /cart unimplemented", async () => {
    const postCart = await request(base, "POST", "/api/fastbuyjson/cart", { productId: VARIANT_GID });
    assert.equal(postCart.status, 404);
    const orders = await request(base, "GET", "/api/fastbuyjson/orders/ord-1");
    assert.equal(orders.status, 404);
    const shipping = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    assert.equal(shipping.status, 404);
    const method = await request(base, "GET", "/api/fastbuyjson/cart/add");
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");
    const invalidQuantity = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 0 });
    assertProblem(invalidQuantity, 400, "VALIDATION_ERROR");
    const missingProduct = await request(base, "POST", "/api/fastbuyjson/cart/add", {});
    assertProblem(missingProduct, 400, "VALIDATION_ERROR");
    const notJson = await request(base, "POST", "/api/fastbuyjson/cart/add", "not-json");
    assertProblem(notJson, 400, "VALIDATION_ERROR");
    const earlyPatch = await request(base, "PATCH", "/api/fastbuyjson/cart/items/44444444-4444-4444-8444-444444444444", {
      quantity: 1,
    });
    assertProblem(earlyPatch, 404, "CART_NOT_FOUND");
    assert.equal(calls.length, 0);
    assert.equal(logs.join("\n").includes("key="), false);
  });

  async function addDefault(): Promise<CartBody & HttpResult> {
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    return assertCart(await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }));
  }
});

function pushVariant(id: string): void {
  scriptPush({ data: { node: { __typename: "ProductVariant", id } } });
}

function pushProductVariants(): void {
  scriptPush({
    data: {
      product: {
        id: PRODUCT_GID,
        variants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: VARIANT_GID,
              selectedOptions: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "Small" },
              ],
            },
            {
              id: VARIANT_LARGE_GID,
              selectedOptions: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "Large" },
              ],
            },
          ],
        },
      },
    },
  });
}

let scriptPush: (body: unknown) => void = () => {
  throw new Error("script is not ready");
};

function snapshotCart(): ShopifyCart {
  const fixture = loadFixture("cart-snapshot.json") as { data: { cartCreate: { cart: ShopifyCart } } };
  return structuredClone(fixture.data.cartCreate.cart);
}

function emptyCart(cart: ShopifyCart): ShopifyCart {
  const next = structuredClone(cart);
  next.lines.nodes = [];
  next.cost.subtotalAmount = { amount: "0.00", currencyCode: "USD" };
  next.cost.totalAmount = { amount: "0.00", currencyCode: "USD" };
  next.cost.totalTaxAmount = null;
  next.cost.totalDutyAmount = null;
  next.discountAllocations = [];
  return next;
}

function lineNode(id: string, variantId: string, title: string, optionName: string, optionValue: string): CartLineNode {
  return {
    id,
    quantity: 1,
    merchandise: {
      id: variantId,
      title,
      selectedOptions: [{ name: optionName, value: optionValue }],
      product: { title: "ACME Tee" },
    },
    cost: {
      amountPerQuantity: { amount: "19.99", currencyCode: "USD" },
      totalAmount: { amount: "19.99", currencyCode: "USD" },
    },
  };
}

function codeAllocation(code: string, amount: string, title?: string): Record<string, unknown> {
  const allocation: Record<string, unknown> = {
    discountedAmount: { amount, currencyCode: "USD" },
    code,
  };
  if (title !== undefined) {
    allocation.title = title;
  }
  return allocation;
}

function titledAllocation(title: string, amount: string): Record<string, unknown> {
  return {
    discountedAmount: { amount, currencyCode: "USD" },
    title,
  };
}

function discountResponse(
  cart: ShopifyCart,
  discountCodes: { code: string; applicable: boolean }[],
  userErrors: unknown[] = [],
): unknown {
  return { data: { cartDiscountCodesUpdate: { cart: { ...cart, discountCodes }, userErrors } } };
}

function mutationResponse(operation: string, cart: ShopifyCart, userErrors: unknown[] = []): unknown {
  return { data: { [operation]: { cart, userErrors } } };
}

function queryResponse(cart: ShopifyCart): unknown {
  return { data: { cart } };
}

function sampleToken() {
  return {
    shopDomain: SHOP,
    grantType: "authorization_code" as const,
    accessToken: ADMIN_TOKEN,
    accessExpiresAt: null,
    refreshToken: REFRESH_TOKEN,
    refreshExpiresAt: null,
  };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fastbuyjson-cart-")), "tokens.sqlite");
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

function graphqlCall(calls: { url: string; body: string; headers: Record<string, string> }[], index: number): GraphqlCall {
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

function expectStorefront(call: GraphqlCall): void {
  assert.equal(call.url, `https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(call.headers["Shopify-Storefront-Private-Token"], DELEGATE_TOKEN);
  assert.equal(call.headers["Shopify-Storefront-Buyer-IP"], undefined);
  assert.equal(call.headers["X-Shopify-Storefront-Access-Token"], undefined);
  assert.equal(call.query.includes("checkoutUrl"), false);
  assert.equal(call.query.includes("storefrontAccessTokenCreate"), false);
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function assertCart(response: HttpResult): CartBody & HttpResult {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(validateSchema("cart-response.json", response.json), true);
  assertClean(response.text);
  return { ...response, ...(response.json as CartBody) };
}

function assertProblem(response: HttpResult, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.equal(validateSchema("error.json", response.json), true);
  const body = response.json as ProblemBody;
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assertClean(response.text);
}

function assertClean(text: string): void {
  assert.equal(text.includes("key="), false);
  assert.equal(text.includes("checkoutUrl"), false);
  assert.equal(text.includes(SHOPIFY_CART_ID), false);
  assert.equal(text.includes(LINE_GID), false);
  assert.equal(text.includes(LINE_LARGE_GID), false);
  assert.equal(text.includes(CART_SECRET), false);
  assert.equal(text.includes(CHECKOUT_URL), false);
  assert.equal(text.includes(DELEGATE_TOKEN), false);
  assert.equal(text.includes(ADMIN_TOKEN), false);
}

function assertPlaintextAbsent(file: string): void {
  const bytes = readFileSync(file);
  for (const secret of [SHOPIFY_CART_ID, LINE_GID, LINE_LARGE_GID, CART_SECRET, CHECKOUT_URL, DELEGATE_TOKEN, ADMIN_TOKEN]) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, secret);
  }
}

function validateSchema(name: string, body: unknown): boolean {
  const schema = JSON.parse(readFileSync(join(metadata.root, "schemas", name), "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormatsModule.default(ajv, ["uri", "uuid", "date-time"]);
  const validate = ajv.compile(schema);
  const ok = validate(body);
  assert.deepEqual(validate.errors ?? [], []);
  return ok === true;
}

function installScript(script: Array<() => Response>): void {
  scriptPush = (body: unknown) => {
    script.push(() => jsonResponse(200, body));
  };
}
