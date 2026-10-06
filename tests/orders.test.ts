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
import { customerSub, signFastBuyJwt } from "../src/customer-login-crypto.js";
import { CUSTOMER_USER_AGENT } from "../src/customer-login-shopify.js";
import type { ConnectorDeps } from "../src/deps.js";
import { mapDisplayStatus } from "../src/order-map.js";
import { ORDER_BY_ID_DOCUMENT, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT } from "../src/order-query.js";
import { SHOPIFY_BACKOFF_MS } from "../src/shopify-graphql.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { createConnectorServer, listen } from "../src/server.js";
import { REINSTALL_DETAIL } from "../src/problems.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const ADMIN_TOKEN = "shpat_order_admin_token";
const REFRESH_TOKEN = "shprt_order_refresh_token";
const CUSTOMER_ACCESS = "shcat_customer_access_token";
const CUSTOMER_GID = "gid://shopify/Customer/42";
const GRAPHQL_URL = "https://accounts.example.com/customer/api/2026-10/graphql";
const SUB_SECRET = "customer-sub-secret-at-least-32-bytes";
const JWT_SECRET = "jwt-secret-for-fastbuyjson-tests-32b";
const SUB = customerSub(SUB_SECRET, CUSTOMER_GID);
const FIXED_NOW = 1_700_000_000_000;
const GID = "gid://shopify/Order/1001";
let script: Array<() => Response> = [];

type GraphqlCall = {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

type HttpResult = { status: number; headers: Headers; json: unknown; text: string };

type OrderBody = {
  order: {
    id: string;
    status: string;
    items: {
      productId: string;
      name?: string;
      quantity: number;
      options?: Record<string, string>;
      price: { amount: number; currency: string };
      lineTotal: { amount: number; currency: string };
    }[];
    totals: { subtotal: number; tax?: number; shipping?: number; discount?: number; total: number };
    payment?: { method: string; status: string; lastFourDigits?: string; brand?: string };
    shipment?: { carrier?: string; trackingNumber?: string; trackingUrl?: string; estimatedDelivery?: string };
    created: string;
    updated?: string;
    shippingAddress?: PostalAddress;
    billingAddress?: PostalAddress;
  };
  message?: string;
  extensions?: unknown;
  userId?: string;
};

type PostalAddress = {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  country: string;
  postalCode: string;
};

type ProblemBody = { type: string; status: number; code: string; detail?: string };

describe("GET /api/fastbuyjson/orders/{orderId}", () => {
  let server: Server;
  let base: string;
  let tokens: TokenStore;
  let orderDeps: ConnectorDeps;
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const sleepDelays: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  before(async () => {
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
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
      now: () => FIXED_NOW,
      customerSubSecret: SUB_SECRET,
      jwtSecret: JWT_SECRET,
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, body: bodyText(init?.body), headers: headerRecord(init?.headers) });
        const next = script.shift();
        if (next === undefined) {
          return jsonResponse(500, { errors: [{ message: "unexpected" }] });
        }
        return next();
      },
    };
    orderDeps = deps;
    server = createConnectorServer({ implementationVersion: metadata.version, shopDomain: SHOP }, deps);
    const port = await listen(server, 0, "127.0.0.1");
    base = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    calls.length = 0;
    script = [];
    sleepDelays.length = 0;
    logs.length = 0;
    errors.length = 0;
    orderDeps.customerSubSecret = SUB_SECRET;
    orderDeps.jwtSecret = JWT_SECRET;
    tokens.save(sampleToken(), FIXED_NOW);
    tokens.customer.saveSession(SHOP, SUB, CUSTOMER_ACCESS, FIXED_NOW + 3_600_000, GRAPHQL_URL);
  });

  after(async () => {
    console.log = originalLog;
    console.error = originalError;
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("resolves a numeric name for the owner and keeps GIDs out of the body and logs", async () => {
    queueOwned(asOrder(orderFixture()));
    const response = await getOrder(base, "1001");
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(body.order.status, "confirmed");
    assert.equal(body.order.items.length, 3);
    assert.equal(body.order.items[0]?.productId, "variant-sku");
    assert.equal(body.order.items[0]?.name, "ACME Wireless Headphones Pro");
    assert.equal(body.order.items[0]?.quantity, 2);
    assert.deepEqual(body.order.items[0]?.options, { Color: "Black" });
    assert.equal(JSON.stringify(body.order.items[0]?.price.amount), "19.99");
    assert.equal(body.order.items[0]?.price.currency, "USD");
    assert.equal(body.order.items[1]?.productId, "line-only-sku");
    assert.equal(JSON.stringify(body.order.items[1]?.price.amount), "10");
    assert.equal(Object.hasOwn(body.order.items[1] ?? {}, "options"), false);
    assert.equal(body.order.items[2]?.productId, "2003");
    assert.equal(response.text.includes("Unidentified spare"), false);
    assert.equal(JSON.stringify(body.order.totals.subtotal), "19.99");
    assert.equal(JSON.stringify(body.order.totals.shipping), "10");
    assert.equal(JSON.stringify(body.order.totals.discount), "0");
    assert.equal(Object.hasOwn(body.order.totals, "tax"), false);
    assert.equal(body.order.payment?.method, "shopify_payments");
    assert.equal(body.order.payment?.status, "approved");
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false);
    assert.deepEqual(body.order.shippingAddress, {
      line1: "123 Main St",
      city: "Berlin",
      country: "DE",
      postalCode: "10115",
    });
    assert.deepEqual(body.order.billingAddress, {
      line1: "9 Billing Rd",
      city: "Berlin",
      country: "DE",
      postalCode: "10115",
    });
    assert.equal(Object.hasOwn(body.order, "shipment"), false);
    assert.equal(Object.hasOwn(body, "message"), false);
    assert.equal(Object.hasOwn(body, "extensions"), false);
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(body.order.created, "2025-09-08T12:34:56.789Z");
    assert.equal(body.order.updated, "2025-09-08T12:45:22.123Z");

    assert.equal(calls.length, 2);
    const owned = graphqlCall(calls, 0);
    expectCustomer(owned);
    assert.equal(owned.variables.query, "name:#1001");
    assert.equal(owned.query.includes("order(id:"), false);
    const call = graphqlCall(calls, 1);
    expectOwnedAdmin(call);
    assert.equal(call.variables.id, GID);
    assert.equal(call.variables.after, null);
    assert.equal(logs.some((line) => line.includes("order status 200 1001 customer-accounts-on")), true);
    assertNoIdentity(response.text);
    assertSafe(logs.join("\n"));
    assertSafe(errors.join("\n"));
  });

  it("uses the client token when a hashed name matches, not the Shopify name", async () => {
    const order = orderFixture();
    order.name = "#EN1001";
    queueOwned(asOrder(order));
    const response = await getOrder(base, "#1001");
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(graphqlCall(calls, 0).variables.query, "name:#1001");
    assert.equal(calls.length, 2);
    expectOwnedAdmin(graphqlCall(calls, 1));
  });

  it("falls through from name:#digits to id:digits and then Admin order(id:)", async () => {
    const order = orderFixture();
    order.name = "#EN1001";
    script.push(() => jsonResponse(200, loadFixture("customer-orders-none.json")));
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(order)));
    const response = await getOrder(base, "1001");
    const body = assertOrder(response);
    assert.equal(body.order.id, "EN1001");
    assert.equal(calls.length, 3);
    assert.equal(graphqlCall(calls, 0).variables.query, "name:#1001");
    assert.equal(graphqlCall(calls, 1).variables.query, "id:1001");
    const legacy = graphqlCall(calls, 2);
    expectOwnedAdmin(legacy);
    assert.equal(legacy.variables.id, GID);
    assertNoIdentity(response.text);
    assertSafe(logs.join("\n"));
  });

  it("keeps a GID lookup out of the response and the logs", async () => {
    queueOwned(asOrder(orderFixture()));
    const response = await getOrder(base, GID);
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 0).variables.query, "id:1001");
    const call = graphqlCall(calls, 1);
    expectOwnedAdmin(call);
    assert.equal(call.variables.id, GID);
    assert.equal(logs.some((line) => line.includes("order status 200 gid lookup customer-accounts-on")), true);
    assert.equal(logs.join("\n").includes("gid://"), false);
    assertNoIdentity(response.text);
    assertSafe(logs.join("\n"));
  });

  it("resolves one confirmation number to the client token", async () => {
    queueOwned(asOrder(orderFixture()));
    const response = await getOrder(base, "XPAV284CT");
    const body = assertOrder(response);
    assert.equal(body.order.id, "XPAV284CT");
    assert.equal(
      graphqlCall(calls, 0).variables.query,
      'name:"XPAV284CT" OR name:"#XPAV284CT" OR confirmation_number:"XPAV284CT"',
    );
    assert.equal(calls.length, 2);
    expectOwnedAdmin(graphqlCall(calls, 1));
  });

  it("returns ORDER_NOT_FOUND when a confirmation query matches two orders", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-two.json")));
    const response = await getOrder(base, "XPAV284CT");
    assertNotFound(response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, GRAPHQL_URL);
    assert.equal(graphqlCall(calls, 0).query.includes("order(id:"), false);
  });

  it("does not fall through to id:digits when a digit name is ambiguous", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-two.json")));
    const response = await getOrder(base, "1001");
    assertNotFound(response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, GRAPHQL_URL);
  });

  it("uses the same detail for an unknown id and an order outside the window", async () => {
    const fixture = readFileSync(join(metadata.root, "tests", "fixtures", "order-outside-window.json"), "utf8");
    assert.equal(fixture.includes("outside-read-orders-window"), true);
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, { data: { order: null } }));
    const unknown = await getOrder(base, GID);
    assertNotFound(unknown);

    calls.length = 0;
    logs.length = 0;
    script.push(() => jsonResponse(200, ownedCustomer("gid://shopify/Order/1002")));
    script.push(() => jsonResponse(200, loadFixture("order-outside-window.json")));
    const outside = await getOrder(base, "gid://shopify/Order/1002");
    assertNotFound(outside);
    assert.equal((unknown.json as ProblemBody).detail, (outside.json as ProblemBody).detail);
    assert.equal((outside.json as ProblemBody).detail, "No order matches that id.");
    assert.equal(outside.text.includes("window"), false);
    assert.equal(outside.text.includes("outside-read-orders-window"), false);
    assertSafe(unknown.text);
    assertSafe(outside.text);
    assertSafe(logs.join("\n"));
  });

  it("rejects tokens this phase does not accept before calling Shopify", async () => {
    const spaced = await getOrder(base, "1001 A");
    assertNotFound(spaced);
    const foreign = await getOrder(base, "gid://shopify/Product/1");
    assertNotFound(foreign);
    const tooLong = await getOrder(base, "a".repeat(41));
    assertNotFound(tooLong);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, [
      "order status 404 rejected token customer-accounts-on",
      "order status 404 rejected token customer-accounts-on",
      "order status 404 rejected token customer-accounts-on",
    ]);
    assertSafe(logs.join("\n"));
  });

  it("logs a fixed label when a rejected order id contains %0A or @", async () => {
    const newline = await requestOrder(
      base,
      "/api/fastbuyjson/orders/%0Aorder%20status%20200%20owned",
      authHeaders(),
    );
    assertNotFound(newline);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ["order status 404 rejected token customer-accounts-on"]);
    assert.equal(logs.some((line) => line.includes("\n") || line.includes("%0A")), false);
    assert.equal(newline.text.includes("owned"), false);

    logs.length = 0;
    calls.length = 0;
    const email = await getOrder(base, "user@shop.test");
    assertNotFound(email);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ["order status 404 rejected token customer-accounts-on"]);
    assert.equal(logs.some((line) => line.includes("@") || line.includes("user@shop.test")), false);
    assert.equal(email.text.includes("@"), false);
  });

  it("maps refunded only for a full refund and leaves undated fulfillments off delivered", async () => {
    const rows: { financial: string | null; fulfillment: string; cancelledAt?: string; status: string; payment?: string }[] = [
      { financial: "PAID", fulfillment: "UNFULFILLED", status: "confirmed", payment: "approved" },
      { financial: "PAID", fulfillment: "OPEN", status: "confirmed", payment: "approved" },
      { financial: "PAID", fulfillment: "RESTOCKED", status: "confirmed", payment: "approved" },
      { financial: "PAID", fulfillment: "FULFILLED", status: "shipped", payment: "approved" },
      { financial: "PAID", fulfillment: "PARTIALLY_FULFILLED", status: "processing", payment: "approved" },
      { financial: "PAID", fulfillment: "IN_PROGRESS", status: "processing", payment: "approved" },
      { financial: "PAID", fulfillment: "ON_HOLD", status: "processing", payment: "approved" },
      { financial: "PAID", fulfillment: "SCHEDULED", status: "processing", payment: "approved" },
      { financial: "PAID", fulfillment: "PENDING_FULFILLMENT", status: "processing", payment: "approved" },
      { financial: "PAID", fulfillment: "REQUEST_DECLINED", status: "processing", payment: "approved" },
      { financial: "PAID", fulfillment: "FULFILLMENT_NOT_REQUIRED", status: "processing", payment: "approved" },
      { financial: "PENDING", fulfillment: "UNFULFILLED", status: "processing", payment: "pending" },
      { financial: "AUTHORIZED", fulfillment: "UNFULFILLED", status: "processing", payment: "pending" },
      { financial: "PARTIALLY_PAID", fulfillment: "UNFULFILLED", status: "processing", payment: "approved" },
      { financial: "PARTIALLY_REFUNDED", fulfillment: "FULFILLED", status: "shipped", payment: "approved" },
      { financial: "PARTIALLY_REFUNDED", fulfillment: "PARTIALLY_FULFILLED", status: "processing", payment: "approved" },
      { financial: "PARTIALLY_REFUNDED", fulfillment: "UNFULFILLED", status: "processing", payment: "approved" },
      { financial: "REFUNDED", fulfillment: "FULFILLED", status: "refunded", payment: "refunded" },
      { financial: "EXPIRED", fulfillment: "UNFULFILLED", status: "processing", payment: "declined" },
      { financial: "VOIDED", fulfillment: "UNFULFILLED", status: "processing", payment: "declined" },
      { financial: "REFUNDED", fulfillment: "FULFILLED", cancelledAt: "2025-09-09T00:00:00.000Z", status: "cancelled", payment: "refunded" },
    ];
    for (const row of rows) {
      calls.length = 0;
      const order = orderFixture();
      order.displayFinancialStatus = row.financial;
      order.displayFulfillmentStatus = row.fulfillment;
      order.cancelledAt = row.cancelledAt ?? null;
      queueOwned(asOrder(order));
      const response = await getOrder(base, "1001");
      const body = assertOrder(response);
      assert.equal(body.order.status, row.status, `${row.financial} ${row.fulfillment}`);
      assert.equal(response.text.includes("delivered"), false);
      if (row.payment === undefined) {
        assert.equal(body.order.payment, undefined);
      } else {
        assert.equal(body.order.payment?.status, row.payment, `${row.financial} ${row.fulfillment}`);
      }
    }
  });

  it("selects deliveredAt without truncating fulfillments or reading a second signal", () => {
    for (const query of [ORDER_BY_ID_DOCUMENT, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT]) {
      assertFulfillmentSelection(query);
    }
  });

  it("maps delivered only when every active fulfillment has deliveredAt", async () => {
    const rows: {
      fixture: string;
      status: string;
      payment: string;
      trackingNumber?: string;
      absent?: string[];
    }[] = [
      {
        fixture: "order-delivered.json",
        status: "delivered",
        payment: "approved",
        trackingNumber: "TRACK-DELIVERED",
      },
      {
        fixture: "order-fulfilled-delivered-at-null.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-UNDATED",
        absent: ["delivered"],
      },
      {
        fixture: "order-split-one-delivered-at.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-UNDATED",
        absent: ["delivered", "TRACK-DATED"],
      },
      {
        fixture: "order-fulfilled-no-fulfillments.json",
        status: "shipped",
        payment: "approved",
        absent: ["delivered"],
      },
      {
        fixture: "order-delivered-cancelled-undated.json",
        status: "delivered",
        payment: "approved",
        trackingNumber: "TRACK-OK",
        absent: ["TRACK-CANCELLED"],
      },
      {
        fixture: "order-shipped-cancelled-dated.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-UNDATED",
        absent: ["delivered", "TRACK-CANCELLED"],
      },
      {
        fixture: "order-partially-fulfilled-dated.json",
        status: "processing",
        payment: "approved",
        trackingNumber: "TRACK-PARTIAL",
        absent: ["delivered"],
      },
      {
        fixture: "order-cancelled-was-delivered.json",
        status: "cancelled",
        payment: "approved",
        trackingNumber: "TRACK-OK",
        absent: ["delivered"],
      },
      {
        fixture: "order-refunded-was-delivered.json",
        status: "refunded",
        payment: "refunded",
        trackingNumber: "TRACK-OK",
        absent: ["delivered"],
      },
      {
        fixture: "order-partial-refund-delivered.json",
        status: "delivered",
        payment: "approved",
        trackingNumber: "TRACK-ONE",
        absent: ["TRACK-TWO"],
      },
      {
        fixture: "order-display-status-ignored.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-UNDATED",
        absent: ["delivered", "displayStatus", "DELIVERED"],
      },
      {
        fixture: "order-event-status-ignored.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-UNDATED",
        absent: ["delivered", "DELIVERED"],
      },
      {
        fixture: "order-estimated-delivery-ignored.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-UNDATED",
        absent: ["delivered", "estimatedDelivery", "2020-01-01", "2019-12-20"],
      },
      {
        fixture: "order-requires-shipping-blocks-delivered.json",
        status: "shipped",
        payment: "approved",
        trackingNumber: "TRACK-SHIP",
        absent: ["delivered"],
      },
    ];
    for (const row of rows) {
      calls.length = 0;
      logs.length = 0;
      const fixture = loadFixture(row.fixture);
      queueOwned(asOrder(fixture));
      const response = await getOrder(base, "1001");
      const body = assertOrder(response);
      assert.equal(body.order.status, row.status, row.fixture);
      assert.equal(body.order.payment?.status, row.payment, row.fixture);
      assert.equal(response.text.includes("deliveredAt"), false, row.fixture);
      assert.equal(response.text.includes(DELIVERED_AT), false, row.fixture);
      assert.equal(logs.join("\n").includes("deliveredAt"), false, row.fixture);
      assert.equal(logs.join("\n").includes(DELIVERED_AT), false, row.fixture);
      assert.equal(Object.hasOwn(body, "extensions"), false, row.fixture);
      if (row.trackingNumber === undefined) {
        assert.equal(body.order.shipment, undefined, row.fixture);
      } else {
        assert.equal(body.order.shipment?.trackingNumber, row.trackingNumber, row.fixture);
        assert.equal(Object.hasOwn(body.order.shipment ?? {}, "estimatedDelivery"), false, row.fixture);
      }
      for (const absent of row.absent ?? []) {
        assert.equal(response.text.includes(absent), false, `${row.fixture} ${absent}`);
      }
      const call = graphqlCall(calls, 1);
      assert.equal(call.query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
      assertFulfillmentSelection(call.query);
    }
  });

  it("parses shop money strings and falls back when the current bag is null", async () => {
    const order = orderFixture();
    order.currentSubtotalPriceSet = null;
    order.subtotalPriceSet = { shopMoney: { amount: "19.99", currencyCode: "USD" } };
    order.currentTotalPriceSet = null;
    order.totalPriceSet = { shopMoney: { amount: "10.00", currencyCode: "USD" } };
    order.currentShippingPriceSet = null;
    order.totalShippingPriceSet = null;
    queueOwned(asOrder(order));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(JSON.stringify(body.order.totals.subtotal), "19.99");
    assert.equal(JSON.stringify(body.order.totals.total), "10");
    assert.equal(Object.hasOwn(body.order.totals, "shipping"), false);
    assert.equal(JSON.stringify(body.order.items[1]?.lineTotal.amount), "10");
  });

  it("returns 500 when required shop money is missing and does not invent zero", async () => {
    const order = orderFixture();
    order.currentTotalPriceSet = { shopMoney: null };
    order.totalPriceSet = null;
    queueOwned(asOrder(order));
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal(response.text.includes('"order"'), false);
    assert.equal((response.json as ProblemBody).detail, "The order response could not be completed.");
  });

  it("uses the first fulfillment that still has a tracking number", async () => {
    const order = orderFixture();
    order.fulfillments = [
      {
        status: "CANCELLED",
        trackingInfo: [{ company: "Ignore", number: "SKIP-ME", url: "https://ignore.example/SKIP-ME" }],
      },
      {
        status: "SUCCESS",
        trackingInfo: [
          { company: null, number: null, url: "not-a-url" },
          {
            company: "DHL",
            number: "1Z999AA10123456784",
            url: "https://www.dhl.com/tracking/1Z999AA10123456784",
          },
        ],
      },
    ];
    queueOwned(asOrder(order));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.deepEqual(body.order.shipment, {
      carrier: "DHL",
      trackingNumber: "1Z999AA10123456784",
      trackingUrl: "https://www.dhl.com/tracking/1Z999AA10123456784",
    });
    assert.equal(Object.hasOwn(body.order.shipment ?? {}, "estimatedDelivery"), false);
    assert.equal(JSON.stringify(body).includes("SKIP-ME"), false);
  });

  it("omits a tracking URL that is not absolute and omits shipment when nothing is tracked", async () => {
    const relative = orderFixture();
    relative.fulfillments = [
      { status: "SUCCESS", trackingInfo: [{ company: null, number: "TRACK-1", url: "/relative" }] },
    ];
    queueOwned(asOrder(relative));
    const withNumber = assertOrder(await getOrder(base, "1001"));
    assert.deepEqual(withNumber.order.shipment, { trackingNumber: "TRACK-1" });

    calls.length = 0;
    const untracked = orderFixture();
    untracked.fulfillments = [
      { status: "CANCELLED", trackingInfo: [{ company: "DHL", number: "SKIP-ME", url: "https://example.com/x" }] },
      { status: "ERROR", trackingInfo: [{ number: "ALSO-SKIP" }] },
      { status: "FAILURE", trackingInfo: [{ number: "NOPE" }] },
      { status: "SUCCESS", trackingInfo: [{ company: "DHL", number: null, url: null }] },
    ];
    queueOwned(asOrder(untracked));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(Object.hasOwn(body.order, "shipment"), false);
  });

  it("omits payment when gateway names are empty", async () => {
    const order = orderFixture();
    order.paymentGatewayNames = [];
    queueOwned(asOrder(order));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(body.order.payment, undefined);
    assert.equal(Object.hasOwn(body.order, "payment"), false);
  });

  it("omits payment when the financial status is null", async () => {
    const order = orderFixture();
    order.displayFinancialStatus = null;
    queueOwned(asOrder(order));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(body.order.status, "processing");
    assert.equal(body.order.payment, undefined);
  });

  it("omits payment and returns the order when the financial status is unknown", async () => {
    const processing = orderFixture();
    processing.displayFinancialStatus = "UNKNOWN_STATUS";
    queueOwned(asOrder(processing));
    const processingBody = assertOrder(await getOrder(base, "1001"));
    assert.equal(processingBody.order.status, "processing");
    assert.equal(processingBody.order.payment, undefined);
    assert.equal(Object.hasOwn(processingBody.order, "payment"), false);

    calls.length = 0;
    const shipped = orderFixture();
    shipped.displayFinancialStatus = "UNKNOWN_STATUS";
    shipped.displayFulfillmentStatus = "FULFILLED";
    queueOwned(asOrder(shipped));
    const shippedBody = assertOrder(await getOrder(base, "1001"));
    assert.equal(shippedBody.order.status, "shipped");
    assert.equal(shippedBody.order.payment, undefined);
  });

  it("returns 500 when a non-address field is denied on the owned read", async () => {
    const order = orderFixture();
    order.fulfillments = null;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() =>
      jsonResponse(200, {
        data: { order },
        errors: [
          {
            message: "Access denied for fulfillments field.",
            path: ["order", "fulfillments"],
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      }),
    );
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal(Object.hasOwn(response.json as object, "order"), false);
    assert.equal(response.text.includes("123 Main St"), false);
  });

  it("requires a bearer JWT and does not return an anonymous order", async () => {
    const anonymous = await getOrder(base, "1001", {});
    assertProblem(anonymous, 401, "AUTHENTICATION_REQUIRED");
    assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.equal(Object.hasOwn(anonymous.json as object, "order"), false);
    assert.equal(calls.length, 0);

    const bearer = await getOrder(base, "1001", { Authorization: "Bearer demo.jwt.leftover" });
    assertProblem(bearer, 401, "INVALID_TOKEN");
    assert.equal(bearer.headers.get("www-authenticate"), "Bearer");
    assert.equal(calls.length, 0);
  });

  it("asks for a reinstall when read_orders is missing and keeps the admin token", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, loadFixture("order-access-denied.json")));
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(response.text.includes(ADMIN_TOKEN), false);
    assert.equal(tokens.get()?.accessToken, ADMIN_TOKEN);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.url.includes("/admin/"), true);
    assertSafe(response.text);
  });

  it("reads every line page and then stops", async () => {
    const first = orderFixture();
    const connection = first.lineItems as { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
    const rest = connection.nodes.slice(1);
    connection.nodes = connection.nodes.slice(0, 1);
    connection.pageInfo = { hasNextPage: true, endCursor: "line-page-2" };
    const second = orderFixture();
    const secondConnection = second.lineItems as { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
    secondConnection.nodes = rest;
    secondConnection.pageInfo = { hasNextPage: false, endCursor: null };
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(first)));
    script.push(() => jsonResponse(200, asOrder(second)));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.deepEqual(
      body.order.items.map((item) => item.productId),
      ["variant-sku", "line-only-sku", "2003"],
    );
    assert.equal(calls.length, 3);
    assert.equal(graphqlCall(calls, 1).query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
    assert.equal(graphqlCall(calls, 2).query, ORDER_BY_ID_DOCUMENT);
    assert.equal(graphqlCall(calls, 2).variables.after, "line-page-2");
    assert.equal(/\bshippingAddress\b/.test(graphqlCall(calls, 2).query), false);
    assert.equal(/\bemail\b/.test(graphqlCall(calls, 2).query), false);
  });

  it("backs off once on a Shopify throttle and then returns RATE_LIMITED", async () => {
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const response = await getOrder(base, "1001");
    assertProblem(response, 429, "RATE_LIMITED");
    assert.equal((response.json as ProblemBody).detail, "Shopify throttled the order request.");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, GRAPHQL_URL);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("returns 500 when the stored admin token is gone", async () => {
    tokens.clearAccessToken(SHOP, FIXED_NOW);
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, GRAPHQL_URL);
    assert.equal(calls[1]?.url, `https://${SHOP}/admin/oauth/access_token`);
    assert.equal(calls.some((call) => call.url.includes("/graphql.json")), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.text.includes(ADMIN_TOKEN), false);
    assert.equal(response.text.includes(REFRESH_TOKEN), false);
  });

  it("sends Cache-Control no-store and advertises jwt", async () => {
    const missing = await getOrder(base, "");
    assert.equal(missing.status, 404);
    const method = await fetch(`${base}/api/fastbuyjson/orders/${encodeURIComponent("1001")}`, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET");
    assert.equal(method.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 0);

    const detect = await fetch(`${base}/api/fastbuyjson/detect`);
    assert.equal(detect.status, 200);
    assert.equal(detect.headers.get("cache-control"), "public, max-age=300");
    const discover = (await detect.json()) as {
      endpoints: string[];
      authentication: { methods: string[]; endpoints: string[] };
      capabilities: { checkout: { confirmCreatesOrder: boolean } };
    };
    assert.equal(discover.endpoints.includes("orders"), true);
    assert.equal(discover.endpoints.includes("auth"), true);
    assert.equal(discover.capabilities.checkout.confirmCreatesOrder, false);
    assert.deepEqual(discover.authentication.methods, ["anonymous", "jwt"]);
    assert.deepEqual(discover.authentication.endpoints, ["/auth/customer/start"]);
    assert.equal(Object.hasOwn(discover, "auth"), false);
  });

  it("ignores ?email= and still maps the owner's addresses", async () => {
    queueOwned(asOrder(addressFixture()));
    const response = await getOrder(base, "1001", undefined, "email=other@example.com");
    const body = assertOrder(response);
    assert.equal(body.order.shippingAddress?.line1, "123 Main St");
    assert.equal(body.order.billingAddress?.line1, "9 Billing Rd");
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(graphqlCall(calls, 1).query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
    assert.equal(/\bemail\b/.test(graphqlCall(calls, 1).query), false);
    assert.equal(response.text.includes("other@example.com"), false);
    assert.equal(logs.join("\n").includes("email="), false);
    assertLogsOmitEmailAndAddresses(logs, errors);

    calls.length = 0;
    const anonymous = await getOrder(base, "1001", {}, "email=buyer@example.com");
    assertProblem(anonymous, 401, "AUTHENTICATION_REQUIRED");
    assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
    assert.equal(calls.length, 0);
    assert.equal(anonymous.text.includes("123 Main St"), false);
  });
});

describe("deliveredAt signal", () => {
  it("stays shipped when deliveredAt is empty or whitespace", () => {
    const dated = "2026-01-15T08:30:00.000Z";
    for (const deliveredAt of ["", "   ", "\n\t", 0]) {
      assert.equal(
        mapDisplayStatus(null, "PAID", "FULFILLED", [{ status: "SUCCESS", deliveredAt }]),
        "shipped",
        JSON.stringify(deliveredAt),
      );
    }
    assert.equal(
      mapDisplayStatus(null, "PAID", "FULFILLED", [
        { status: "SUCCESS", deliveredAt: dated },
        { status: "SUCCESS", deliveredAt: "" },
      ]),
      "shipped",
    );
    assert.equal(
      mapDisplayStatus(null, "PAID", "FULFILLED", [{ status: "SUCCESS", deliveredAt: dated }]),
      "delivered",
    );
  });
});

describe("orders without a stored token", () => {
  it("returns 404 when the process is not connected to a shop", async () => {
    const detectOnly = createConnectorServer({ implementationVersion: metadata.version, shopDomain: SHOP });
    const detectPort = await listen(detectOnly, 0, "127.0.0.1");
    const unavailable = await fetch(`http://127.0.0.1:${detectPort}/api/fastbuyjson/orders/1001`);
    assert.equal(unavailable.status, 404);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    await new Promise<void>((resolve, reject) => {
      detectOnly.close((error) => (error ? reject(error) : resolve()));
    });
  });
});

function orderFixture(): Record<string, unknown> {
  return structuredClone(loadFixture("order-admin.json")) as Record<string, unknown>;
}

function asOrder(order: unknown): unknown {
  return { data: { order } };
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
  return join(mkdtempSync(join(tmpdir(), "fastbuyjson-orders-")), "tokens.sqlite");
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

function graphqlCall(seen: { url: string; body: string; headers: Record<string, string> }[], index: number): GraphqlCall {
  const call = seen[index];
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

function expectCustomer(call: GraphqlCall): void {
  assert.equal(call.url, GRAPHQL_URL);
  assert.equal(call.headers.Authorization, CUSTOMER_ACCESS);
  assert.equal(call.headers.Authorization?.startsWith("Bearer "), false);
  assert.equal(call.headers["User-Agent"], CUSTOMER_USER_AGENT);
  assert.equal(call.headers.Origin, "https://app.example.com");
  assert.equal(call.query.includes("orders(first: 2"), true);
  assert.equal(call.query.includes("order(id:"), false);
}

function expectOwnedAdmin(call: GraphqlCall): void {
  assert.equal(call.url, `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(call.headers["X-Shopify-Access-Token"], ADMIN_TOKEN);
  assert.equal(call.query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
  assert.equal(call.query.includes("CardPaymentDetails"), false);
  assert.equal(/\bemail\b/.test(call.query), false);
  assert.equal(/\bphone\b/.test(call.query), false);
  assert.equal(call.query.includes("legacyResourceId"), true);
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${signFastBuyJwt(JWT_SECRET, SUB, FIXED_NOW, 3600)}` };
}

function queueOwned(admin: unknown): void {
  script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
  script.push(() => jsonResponse(200, admin));
}

function ownedCustomer(gid: string): unknown {
  return {
    data: {
      customer: {
        id: CUSTOMER_GID,
        orders: { nodes: [{ id: gid, name: "#1002" }] },
      },
    },
  };
}

async function getOrder(
  base: string,
  id: string,
  headers?: Record<string, string>,
  query = "",
): Promise<HttpResult> {
  const path = id === "" ? "/api/fastbuyjson/orders/" : `/api/fastbuyjson/orders/${encodeURIComponent(id)}`;
  const suffix = query === "" ? "" : query.startsWith("?") ? query : `?${query}`;
  return requestOrder(base, `${path}${suffix}`, headers ?? authHeaders());
}

async function requestOrder(base: string, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function assertOrder(response: HttpResult): OrderBody {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(validateSchema("order-status.json", response.json), true);
  assertNoIdentity(response.text);
  return response.json as OrderBody;
}

function assertNoIdentity(text: string): void {
  assert.equal(text.toLowerCase().includes("gid://"), false);
  assert.equal(text.includes(ADMIN_TOKEN), false);
  assert.equal(text.includes(REFRESH_TOKEN), false);
  assert.equal(text.includes(CUSTOMER_ACCESS), false);
  assert.equal(text.includes("buyer@example.com"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("Ada Lovelace"), false);
  assert.equal(text.includes("Visa"), false);
  assert.equal(text.includes("lastFourDigits"), false);
  assert.equal(text.includes("CardPaymentDetails"), false);
  assert.equal(text.includes("userId"), false);
}

function addressFixture(): Record<string, unknown> {
  return structuredClone(loadFixture("order-address-gate.json")) as Record<string, unknown>;
}

function assertNotFound(response: HttpResult): void {
  assertProblem(response, 404, "ORDER_NOT_FOUND");
  const body = response.json as ProblemBody;
  assert.equal(body.type, "https://fastbuyjson.org/problems/order-not-found");
  assert.equal(body.detail, "No order matches that id.");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/);
}

function assertProblem(response: HttpResult, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.equal(validateSchema("error.json", response.json), true);
  const body = response.json as ProblemBody;
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assertSafe(response.text);
}

function assertAddressFree(text: string): void {
  assertSafe(text);
  for (const secret of [
    "Apt 4B",
    "Suite 2",
    "Munich",
    "Bavaria",
    "80331",
    "1 Unknown Way",
    "999 Display Only",
    "BE-CODE",
    "BY-CODE",
    "customer@example.com",
    "buyer+tag@example.com",
    "+15555550100",
    "Analytical Engines",
    "Germany",
  ]) {
    assert.equal(text.includes(secret), false, secret);
  }
}

function assertLogsOmitEmailAndAddresses(seenLogs: string[], seenErrors: string[]): void {
  const text = `${seenLogs.join("\n")}\n${seenErrors.join("\n")}`;
  assertAddressFree(text);
  assert.equal(text.includes("email="), false);
  assert.equal(text.includes("@"), false);
}

function assertSafe(text: string): void {
  assert.equal(text.toLowerCase().includes("gid://"), false);
  assert.equal(text.includes(ADMIN_TOKEN), false);
  assert.equal(text.includes(REFRESH_TOKEN), false);
  assert.equal(text.includes("buyer@example.com"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("123 Main St"), false);
  assert.equal(text.includes("9 Billing Rd"), false);
  assert.equal(text.includes("Ada Lovelace"), false);
  assert.equal(text.includes("Visa"), false);
  assert.equal(text.includes("lastFourDigits"), false);
  assert.equal(text.includes("shippingAddress"), false);
  assert.equal(text.includes("billingAddress"), false);
  assert.equal(text.includes("CardPaymentDetails"), false);
}

const DELIVERED_AT = "2026-01-15T08:30:00.000Z";

function assertFulfillmentSelection(query: string): void {
  assert.match(query, /fulfillments\s*\{[^]*?\bdeliveredAt\b/);
  assert.equal(/fulfillments\s*\(/.test(query), false);
  assert.equal(/\bevents\b/.test(query), false);
  assert.equal(/\bdisplayStatus\b/.test(query), false);
  assert.equal(/\bestimatedDeliveryAt\b/.test(query), false);
  assert.equal(/\binTransitAt\b/.test(query), false);
  assert.equal(/\boriginAddress\b/.test(query), false);
  assert.equal(/\blocation\b/.test(query), false);
  assert.match(query, /trackingInfo\(first: 10\)/);
  assert.match(query, /\bcompany\b/);
  assert.match(query, /\bnumber\b/);
  assert.match(query, /\burl\b/);
}

function validateSchema(name: string, body: unknown): boolean {
  const schema = JSON.parse(readFileSync(join(metadata.root, "schemas", name), "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormatsModule.default(ajv, ["date", "uri", "date-time"]);
  const validate = ajv.compile(schema);
  const ok = validate(body);
  assert.deepEqual(validate.errors ?? [], []);
  return ok === true;
}
