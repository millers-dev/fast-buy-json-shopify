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
import { CART_DELIVERY_GROUPS_DOCUMENT } from "../src/checkout-query.js";
import type { ConnectorDeps } from "../src/deps.js";
import { MAX_DELIVERY_GROUP_PAGES } from "../src/delivery-groups.js";
import { ANONYMOUS_SCOPE } from "../src/idempotency.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { createConnectorServer, listen } from "../src/server.js";
import { SHOPIFY_BACKOFF_MS } from "../src/shopify-graphql.js";
import {
  CART_DELIVERY_OPTION_FIELDS_ON_2026_10,
  DELIVERY_DAY_BOUNDS_ON_2026_10,
  DELIVERY_OPTION_DAY_BOUND_FIELDS_ON_2026_10,
} from "../src/shipping-contract.js";
import { CART_SHIPPING_OPTIONS_DOCUMENT } from "../src/shipping-query.js";
import { shippingOptionsBody } from "../src/shipping.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const ADMIN_TOKEN = "shpat_shipping_admin_token";
const REFRESH_TOKEN = "shprt_shipping_refresh_token";
const DELEGATE_TOKEN = "shppa_delegate_shipping_test";
const FIXED_NOW = 1_700_000_000_000;
const SHOPIFY_CART_ID = "gid://shopify/Cart/c1?key=super-secret-cart-key";
const CART_SECRET = "super-secret-cart-key";
const LINE_GID = "gid://shopify/CartLine/line-a";
const VARIANT_GID = "gid://shopify/ProductVariant/2001";
const GROUP_GID = "gid://shopify/CartDeliveryGroup/g1";
const CHECKOUT_URL = "https://example.myshopify.com/cart/c/c1?key=super-secret-cart-key";

type GraphqlCall = {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

type ShippingBody = {
  currency: string;
  options: {
    id: string;
    label: string;
    amount: { amount: number; currency: string };
    estimatedDelivery: { minDays: number; maxDays: number };
    description?: string;
    freeOver?: unknown;
  }[];
  omittedOptionCount?: number;
};

type ProblemBody = { status: number; code: string; detail?: string };
type HttpResult = { status: number; headers: Headers; json: unknown; text: string };

const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
const logs: string[] = [];
let script: Array<() => Response> = [];

describe("Storefront API 2026-10 shipping decisions", () => {
  it("records that CartDeliveryOption has no day-bound field and the checkout query stays handle-only", () => {
    assert.deepEqual(DELIVERY_OPTION_DAY_BOUND_FIELDS_ON_2026_10, []);
    assert.deepEqual(CART_DELIVERY_OPTION_FIELDS_ON_2026_10, [
      "code",
      "deliveryMethodType",
      "description",
      "estimatedCost",
      "handle",
      "title",
    ]);
    assert.match(DELIVERY_DAY_BOUNDS_ON_2026_10, /2026-10/);
    assert.match(DELIVERY_DAY_BOUNDS_ON_2026_10, /unstable/);
    assert.match(DELIVERY_DAY_BOUNDS_ON_2026_10, /omittedOptionCount/);
    assert.match(DELIVERY_DAY_BOUNDS_ON_2026_10, /does not invent/);
    assert.equal(SHOPIFY_API_VERSION, "2026-10");
    assert.equal(CART_SHIPPING_OPTIONS_DOCUMENT.includes("deliveryGroups(first: 20"), true);
    assert.equal(CART_SHIPPING_OPTIONS_DOCUMENT.includes("estimatedCost"), true);
    assert.equal(CART_SHIPPING_OPTIONS_DOCUMENT.includes("deliveryMethodType"), true);
    assert.equal(CART_SHIPPING_OPTIONS_DOCUMENT.includes("checkoutUrl"), false);
    for (const field of ["minEstimatedDeliveryDate", "maxEstimatedDeliveryDate", "minDays", "maxDays", "estimatedDelivery"]) {
      assert.equal(CART_SHIPPING_OPTIONS_DOCUMENT.includes(field), false, field);
    }
    assert.equal(CART_DELIVERY_GROUPS_DOCUMENT.includes("deliveryGroups(first: 20"), true);
    assert.equal(CART_DELIVERY_GROUPS_DOCUMENT.includes("deliveryOptions { handle }"), true);
    assert.equal(CART_DELIVERY_GROUPS_DOCUMENT.includes("estimatedCost"), false);
    assert.equal(CART_DELIVERY_GROUPS_DOCUMENT.includes("minEstimatedDeliveryDate"), false);
    assert.equal(MAX_DELIVERY_GROUP_PAGES, 5);
  });

  it("maps integer day bounds and omits everything else", () => {
    const mapped = shippingOptionsBody("EUR", [
      {
        handle: "ground-handle",
        title: "Ground",
        description: "Leaves the warehouse tomorrow",
        deliveryMethodType: "SHIPPING",
        estimatedCost: { amount: "4.90", currencyCode: "eur" },
        minDays: 2,
        maxDays: 4,
      },
      {
        handle: "ground-handle",
        title: "Ground duplicate",
        estimatedCost: { amount: "9.00", currencyCode: "EUR" },
        minDays: 1,
        maxDays: 1,
      },
      {
        handle: "pickup-handle",
        title: "Store pickup",
        description: "",
        deliveryMethodType: "PICK_UP",
        estimatedCost: { amount: "0.00", currencyCode: "EUR" },
        window: { minDays: 0, maxDays: 1 },
      },
      {
        handle: "no-days",
        title: "Express",
        description: "Delivered in 3–5 business days",
        estimatedCost: { amount: "12.50", currencyCode: "EUR" },
      },
      {
        handle: "bad-days",
        title: "Bad",
        estimatedCost: { amount: "1.00", currencyCode: "EUR" },
        minDays: -1,
        maxDays: 3,
      },
      {
        handle: "string-days",
        title: "Strings",
        estimatedCost: { amount: "1.00", currencyCode: "EUR" },
        minDays: "3",
        maxDays: "5",
      },
    ]);
    const body = mapped as ShippingBody;
    assert.equal(validateSchema("shipping-options-response.json", body), true);
    assert.equal(body.currency, "EUR");
    assert.equal(body.omittedOptionCount, 3);
    assert.equal(body.options.length, 2);
    const ground = body.options[0];
    assert.ok(ground);
    assert.equal(ground.id, "ground-handle");
    assert.equal(ground.label, "Ground");
    assert.equal(ground.amount.amount, 4.9);
    assert.equal(ground.amount.currency, "EUR");
    assert.deepEqual(ground.estimatedDelivery, { minDays: 2, maxDays: 4 });
    assert.equal(ground.description, "Leaves the warehouse tomorrow");
    assert.equal(ground.freeOver, undefined);
    const pickup = body.options[1];
    assert.ok(pickup);
    assert.equal(pickup.id, "pickup-handle");
    assert.equal(pickup.label, "Store pickup");
    assert.equal(pickup.amount.amount, 0);
    assert.deepEqual(pickup.estimatedDelivery, { minDays: 0, maxDays: 1 });
    assert.equal(pickup.description, undefined);
    assert.equal(JSON.stringify(body).includes("freeOver"), false);
    assert.equal(JSON.stringify(body).includes("standard"), false);
    assert.equal(JSON.stringify(body).includes("express"), false);
  });
});

describe("GET /shipping/options", { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let tokens: TokenStore;
  let now = FIXED_NOW;
  const sleepDelays: number[] = [];
  const originalError = console.error;
  const originalLog = console.log;

  before(async () => {
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    const file = tempFile();
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
    tokens.clearCheckoutSession();
    tokens.compact();
  });

  after(async () => {
    console.error = originalError;
    console.log = originalLog;
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns the shop currency and no options when the process has no cart", async () => {
    script.push(() => jsonResponse(200, loadFixture("shop-currency.json")));
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options", undefined, {
      Authorization: "Bearer not-a-commerce-token",
      "Idempotency-Key": "shipping-no-cart",
    });
    const body = assertShipping(response);
    assert.equal(body.currency, "USD");
    assert.deepEqual(body.options, []);
    assert.equal(Object.hasOwn(body, "omittedOptionCount"), false);
    assert.equal(response.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 1);
    const call = graphqlCall(calls, 0);
    expectStorefront(call);
    assert.equal(call.query.includes("paymentSettings"), true);
    assert.equal(call.query.includes("deliveryGroups"), false);
    assert.equal(call.query.includes(SHOPIFY_CART_ID), false);

    script.push(() => jsonResponse(200, loadFixture("shop-currency.json")));
    const again = await request(base, "GET", "/api/fastbuyjson/shipping/options", undefined, {
      "Idempotency-Key": "shipping-no-cart",
    });
    assertShipping(again);
    assert.equal(again.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 2);
    assert.equal(tokens.lookupIdempotency(ANONYMOUS_SCOPE, "shipping-no-cart", "unused", now).kind, "miss");
  });

  it("returns the cart currency and no options when delivery groups are empty", async () => {
    await addDefault();
    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("shipping-options-empty.json")));
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    const body = assertShipping(response);
    assert.equal(body.currency, "EUR");
    assert.deepEqual(body.options, []);
    assert.equal(Object.hasOwn(body, "omittedOptionCount"), false);
    assert.equal(calls.length, 1);
    const call = graphqlCall(calls, 0);
    expectStorefront(call);
    assert.equal(call.query, CART_SHIPPING_OPTIONS_DOCUMENT);
    assert.deepEqual(call.variables, { id: SHOPIFY_CART_ID, after: null });
    assert.equal(call.query.includes("paymentSettings"), false);
  });

  it("omits every 2026-10 option that has no day bounds and counts them", async () => {
    await addDefault();
    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("shipping-options-page-1.json")));
    script.push(() => jsonResponse(200, loadFixture("shipping-options-page-2.json")));
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    const body = assertShipping(response);
    assert.equal(body.currency, "EUR");
    assert.deepEqual(body.options, []);
    assert.equal(body.omittedOptionCount, 5);
    assert.equal(calls.length, 2);
    const first = graphqlCall(calls, 0);
    const second = graphqlCall(calls, 1);
    assert.deepEqual(first.variables, { id: SHOPIFY_CART_ID, after: null });
    assert.deepEqual(second.variables, { id: SHOPIFY_CART_ID, after: "group-cursor-2" });
    assert.equal(response.text.includes("shop-standard"), false);
    assert.equal(response.text.includes("shop-express"), false);
    assert.equal(response.text.includes("shop-pickup"), false);
    assert.equal(response.text.includes("shop-freight"), false);
    assert.equal(response.text.includes("Ground"), false);
    assert.equal(response.text.includes("Express"), false);
    assert.equal(response.text.includes("Delivered in 3"), false);
    assert.equal(response.text.includes("PICK_UP"), false);
    assert.equal(response.text.includes("freeOver"), false);
    assert.equal(response.text.includes(GROUP_GID), false);
  });

  it("stops after five delivery-group pages", async () => {
    await addDefault();
    calls.length = 0;
    for (let page = 0; page < MAX_DELIVERY_GROUP_PAGES; page += 1) {
      script.push(() => jsonResponse(200, loadFixture("shipping-options-page-1.json")));
    }
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    const body = assertShipping(response);
    assert.equal(body.options.length, 0);
    assert.equal(body.omittedOptionCount, 20);
    assert.equal(calls.length, MAX_DELIVERY_GROUP_PAGES);
    assert.equal(script.length, 0);
  });

  it("uses the shop currency when Shopify no longer has the cart", async () => {
    await addDefault();
    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("shipping-cart-gone.json")));
    script.push(() => jsonResponse(200, loadFixture("shop-currency.json")));
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    const body = assertShipping(response);
    assert.notEqual(response.status, 404);
    assert.equal(body.currency, "USD");
    assert.deepEqual(body.options, []);
    assert.equal(Object.hasOwn(body, "omittedOptionCount"), false);
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 0).query.includes("deliveryGroups"), true);
    assert.equal(graphqlCall(calls, 1).query.includes("paymentSettings"), true);
  });

  it("returns 500 when a delivery option has no handle", async () => {
    await addDefault();
    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("shipping-options-invalid.json")));
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal(response.text.includes(GROUP_GID), false);
    assert.equal(response.text.includes("Ground"), false);
    assert.equal(calls.length, 1);
  });

  it("returns 429 RATE_LIMITED after one backoff", async () => {
    await addDefault();
    calls.length = 0;
    sleepDelays.length = 0;
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const response = await request(base, "GET", "/api/fastbuyjson/shipping/options");
    assertProblem(response, 429, "RATE_LIMITED");
    assert.equal((response.json as ProblemBody).detail, "Shopify throttled the shipping request.");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.length, 2);
    assert.equal(response.headers.get("idempotency-replayed"), null);
  });

  it("allows GET only", async () => {
    const response = await request(base, "POST", "/api/fastbuyjson/shipping/options", {});
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(calls.length, 0);
  });

  async function addDefault(): Promise<void> {
    script.push(() => jsonResponse(200, { data: { node: { __typename: "ProductVariant", id: VARIANT_GID } } }));
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    const response = await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 });
    assert.equal(response.status, 200);
  }
});

describe("shipping without a token store", () => {
  it("stays 404 when the process is not configured for commerce", async () => {
    const server = createConnectorServer({ implementationVersion: metadata.version, shopDomain: SHOP });
    const port = await listen(server, 0, "127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/fastbuyjson/shipping/options`);
      assert.equal(response.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

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
  return join(mkdtempSync(join(tmpdir(), "fastbuyjson-shipping-")), "tokens.sqlite");
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
  return typeof body === "string" ? body : "";
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

function graphqlCall(seen: { url: string; body: string; headers: Record<string, string> }[], index: number): GraphqlCall {
  const call = seen[index];
  assert.ok(call);
  const parsed = JSON.parse(call.body) as { query?: unknown; variables?: unknown };
  assert.equal(typeof parsed.query, "string");
  return {
    url: call.url,
    headers: call.headers,
    query: parsed.query as string,
    variables: (parsed.variables ?? {}) as Record<string, unknown>,
  };
}

function expectStorefront(call: GraphqlCall): void {
  assert.equal(call.url, `https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(call.headers["Shopify-Storefront-Private-Token"], DELEGATE_TOKEN);
  assert.equal(call.headers["Shopify-Storefront-Buyer-IP"], undefined);
  assert.equal(call.headers["X-Shopify-Storefront-Access-Token"], undefined);
  assert.equal(call.query.includes("checkoutUrl"), false);
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
    init.body = JSON.stringify(body);
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

function assertShipping(response: HttpResult): ShippingBody {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(validateSchema("shipping-options-response.json", response.json), true);
  assertClean(response.text);
  return response.json as ShippingBody;
}

function assertProblem(response: HttpResult, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(validateSchema("error.json", response.json), true);
  const body = response.json as ProblemBody;
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assertClean(response.text);
}

function assertClean(text: string): void {
  const combined = `${text}\n${logs.join("\n")}`;
  assert.equal(combined.includes("key="), false);
  assert.equal(combined.includes("checkoutUrl"), false);
  assert.equal(combined.includes("paymentDetails"), false);
  assert.equal(combined.includes("sessionToken"), false);
  assert.equal(combined.includes("verificationToken"), false);
  assert.equal(combined.includes(SHOPIFY_CART_ID), false);
  assert.equal(combined.includes(CART_SECRET), false);
  assert.equal(combined.includes(LINE_GID), false);
  assert.equal(combined.includes(GROUP_GID), false);
  assert.equal(combined.includes(CHECKOUT_URL), false);
  assert.equal(combined.includes(DELEGATE_TOKEN), false);
  assert.equal(combined.includes(ADMIN_TOKEN), false);
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
