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
import { orderAddressGateEnabled } from "../src/config.js";
import type { ConnectorDeps } from "../src/deps.js";
import { mapDisplayStatus } from "../src/order-map.js";
import {
  ORDER_BY_ID_ADDRESS_DOCUMENT,
  ORDER_BY_ID_DOCUMENT,
  ORDERS_BY_QUERY_ADDRESS_DOCUMENT,
  ORDERS_BY_QUERY_DOCUMENT,
} from "../src/order-query.js";
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
const FIXED_NOW = 1_700_000_000_000;
const GID = "gid://shopify/Order/1001";

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
  let script: Array<() => Response> = [];
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
      orderAddressGate: false,
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
    orderDeps.orderAddressGate = false;
    tokens.save(sampleToken(), FIXED_NOW);
  });

  after(async () => {
    console.log = originalLog;
    console.error = originalError;
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("resolves a numeric name, omits PII, and keeps GIDs out of the body and logs", async () => {
    script.push(() => jsonResponse(200, asOrders([orderFixture()])));
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
    assert.equal(Object.hasOwn(body.order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(body.order, "billingAddress"), false);
    assert.equal(Object.hasOwn(body.order, "shipment"), false);
    assert.equal(Object.hasOwn(body, "message"), false);
    assert.equal(Object.hasOwn(body, "extensions"), false);
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(body.order.created, "2025-09-08T12:34:56.789Z");
    assert.equal(body.order.updated, "2025-09-08T12:45:22.123Z");

    assert.equal(calls.length, 1);
    const call = graphqlCall(calls, 0);
    expectAdmin(call);
    assert.equal(call.query.includes("orders(first: 2"), true);
    assert.equal(call.query.includes("order(id:"), false);
    assert.equal(call.variables.query, 'name:"#1001"');
    assert.equal(call.variables.after, null);
    assert.equal(logs.some((line) => line.includes("order status 200 1001")), true);
    assertSafe(response.text);
    assertSafe(logs.join("\n"));
    assertSafe(errors.join("\n"));
  });

  it("uses the client token when a hashed name matches, not the Shopify name", async () => {
    const order = orderFixture();
    order.name = "#EN1001";
    script.push(() => jsonResponse(200, asOrders([order])));
    const response = await getOrder(base, "#1001");
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(graphqlCall(calls, 0).variables.query, 'name:"#1001"');
    assert.equal(calls.length, 1);
  });

  it("falls through to the legacy id when the name query is empty", async () => {
    const order = orderFixture();
    order.name = "#EN1001";
    script.push(() => jsonResponse(200, asOrders([])));
    script.push(() => jsonResponse(200, asOrder(order)));
    const response = await getOrder(base, "1001");
    const body = assertOrder(response);
    assert.equal(body.order.id, "EN1001");
    assert.equal(calls.length, 2);
    const name = graphqlCall(calls, 0);
    assert.equal(name.variables.query, 'name:"#1001"');
    assert.equal(name.query.includes("orders(first: 2"), true);
    const legacy = graphqlCall(calls, 1);
    expectAdmin(legacy);
    assert.equal(legacy.query.includes("order(id:"), true);
    assert.equal(legacy.query.includes("orders(first:"), false);
    assert.equal(legacy.variables.id, "gid://shopify/Order/1001");
    assertSafe(response.text);
    assertSafe(logs.join("\n"));
  });

  it("keeps a GID lookup out of the response and the logs", async () => {
    script.push(() => jsonResponse(200, asOrder(orderFixture())));
    const response = await getOrder(base, GID);
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(calls.length, 1);
    const call = graphqlCall(calls, 0);
    expectAdmin(call);
    assert.equal(call.variables.id, GID);
    assert.equal(call.query.includes("orders(first:"), false);
    assert.equal(logs.some((line) => line.includes("order status 200 gid lookup")), true);
    assertSafe(response.text);
    assertSafe(logs.join("\n"));
  });

  it("resolves one confirmation number to the client token", async () => {
    script.push(() => jsonResponse(200, asOrders([orderFixture()])));
    const response = await getOrder(base, "XPAV284CT");
    const body = assertOrder(response);
    assert.equal(body.order.id, "XPAV284CT");
    assert.equal(
      graphqlCall(calls, 0).variables.query,
      'name:"XPAV284CT" OR name:"#XPAV284CT" OR confirmation_number:"XPAV284CT"',
    );
    assert.equal(calls.length, 1);
  });

  it("returns ORDER_NOT_FOUND when a confirmation query matches two orders", async () => {
    script.push(() => jsonResponse(200, asOrders([orderFixture(), orderFixture()])));
    const response = await getOrder(base, "XPAV284CT");
    assertNotFound(response);
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).query.includes("order(id:"), false);
  });

  it("does not fall through to the legacy id when a digit name is ambiguous", async () => {
    script.push(() => jsonResponse(200, asOrders([orderFixture(), orderFixture()])));
    const response = await getOrder(base, "1001");
    assertNotFound(response);
    assert.equal(calls.length, 1);
  });

  it("uses the same detail for an unknown id and an order outside the window", async () => {
    const fixture = readFileSync(join(metadata.root, "tests", "fixtures", "order-outside-window.json"), "utf8");
    assert.equal(fixture.includes("outside-read-orders-window"), true);
    script.push(() => jsonResponse(200, { data: { order: null } }));
    const unknown = await getOrder(base, GID);
    assertNotFound(unknown);

    calls.length = 0;
    logs.length = 0;
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
      "order status 404 rejected token",
      "order status 404 rejected token",
      "order status 404 rejected token",
    ]);
    assertSafe(logs.join("\n"));
  });

  it("logs a fixed label when a rejected order id contains %0A or @", async () => {
    const newline = await requestOrder(base, "/api/fastbuyjson/orders/%0Aorder%20status%20200%20owned");
    assertNotFound(newline);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ["order status 404 rejected token"]);
    assert.equal(logs.some((line) => line.includes("\n") || line.includes("owned") || line.includes("%0A")), false);
    assert.equal(newline.text.includes("owned"), false);

    logs.length = 0;
    calls.length = 0;
    const email = await getOrder(base, "user@shop.test");
    assertNotFound(email);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ["order status 404 rejected token"]);
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
      script.push(() => jsonResponse(200, asOrders([order])));
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
    for (const query of [ORDER_BY_ID_DOCUMENT, ORDERS_BY_QUERY_DOCUMENT]) {
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
      script.push(() => jsonResponse(200, asOrders([fixture])));
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
      const call = graphqlCall(calls, 0);
      assert.equal(call.query, ORDERS_BY_QUERY_DOCUMENT);
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
    script.push(() => jsonResponse(200, asOrders([order])));
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
    script.push(() => jsonResponse(200, asOrders([order])));
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
    script.push(() => jsonResponse(200, asOrders([order])));
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
    script.push(() => jsonResponse(200, asOrders([relative])));
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
    script.push(() => jsonResponse(200, asOrders([untracked])));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(Object.hasOwn(body.order, "shipment"), false);
  });

  it("omits payment when gateway names are empty", async () => {
    const order = orderFixture();
    order.paymentGatewayNames = [];
    script.push(() => jsonResponse(200, asOrders([order])));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(body.order.payment, undefined);
    assert.equal(Object.hasOwn(body.order, "payment"), false);
  });

  it("omits payment when the financial status is null", async () => {
    const order = orderFixture();
    order.displayFinancialStatus = null;
    script.push(() => jsonResponse(200, asOrders([order])));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(body.order.status, "processing");
    assert.equal(body.order.payment, undefined);
  });

  it("omits payment and returns the order when the financial status is unknown", async () => {
    const processing = orderFixture();
    processing.displayFinancialStatus = "UNKNOWN_STATUS";
    script.push(() => jsonResponse(200, asOrders([processing])));
    const processingBody = assertOrder(await getOrder(base, "1001"));
    assert.equal(processingBody.order.status, "processing");
    assert.equal(processingBody.order.payment, undefined);
    assert.equal(Object.hasOwn(processingBody.order, "payment"), false);

    calls.length = 0;
    const shipped = orderFixture();
    shipped.displayFinancialStatus = "UNKNOWN_STATUS";
    shipped.displayFulfillmentStatus = "FULFILLED";
    script.push(() => jsonResponse(200, asOrders([shipped])));
    const shippedBody = assertOrder(await getOrder(base, "1001"));
    assert.equal(shippedBody.order.status, "shipped");
    assert.equal(shippedBody.order.payment, undefined);
  });

  it("returns 200 when a selected field is redacted and the order is still present", async () => {
    const order = orderFixture();
    order.fulfillments = null;
    script.push(() =>
      jsonResponse(200, {
        data: { orders: { nodes: [order] } },
        errors: [
          {
            message: "Access denied for fulfillments field.",
            path: ["orders", "nodes", 0, "fulfillments"],
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      }),
    );
    const body = assertOrder(await getOrder(base, "1001"));
    assert.equal(body.order.status, "confirmed");
    assert.equal(Object.hasOwn(body.order, "shipment"), false);
  });

  it("ignores a Bearer token", async () => {
    script.push(() => jsonResponse(200, asOrders([orderFixture()])));
    script.push(() => jsonResponse(200, asOrders([orderFixture()])));
    const anonymous = await getOrder(base, "1001");
    const bearer = await getOrder(base, "1001", { Authorization: "Bearer demo.jwt.leftover" });
    assert.equal(anonymous.status, 200);
    assert.equal(bearer.status, 200);
    assert.equal(bearer.text, anonymous.text);
    assert.notEqual(bearer.status, 401);
  });

  it("asks for a reinstall when read_orders is missing and keeps the admin token", async () => {
    script.push(() => jsonResponse(200, loadFixture("order-access-denied.json")));
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(response.text.includes(ADMIN_TOKEN), false);
    assert.equal(tokens.get()?.accessToken, ADMIN_TOKEN);
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
    script.push(() => jsonResponse(200, asOrders([first])));
    script.push(() => jsonResponse(200, asOrders([second])));
    const body = assertOrder(await getOrder(base, "1001"));
    assert.deepEqual(
      body.order.items.map((item) => item.productId),
      ["variant-sku", "line-only-sku", "2003"],
    );
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 1).variables.after, "line-page-2");
    assert.equal(graphqlCall(calls, 0).query, graphqlCall(calls, 1).query);
  });

  it("backs off once on a Shopify throttle and then returns RATE_LIMITED", async () => {
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const response = await getOrder(base, "1001");
    assertProblem(response, 429, "RATE_LIMITED");
    assert.equal((response.json as ProblemBody).detail, "Shopify throttled the order request.");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.length, 2);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("returns 500 when the stored admin token is gone", async () => {
    tokens.deleteShop(SHOP);
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(calls.length, 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("sends Cache-Control no-store and does not require a body", async () => {
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
      authentication: { methods: string[] };
      capabilities: { checkout: { confirmCreatesOrder: boolean } };
    };
    assert.equal(discover.endpoints.includes("orders"), true);
    assert.equal(discover.endpoints.includes("auth"), false);
    assert.equal(discover.capabilities.checkout.confirmCreatesOrder, false);
    assert.deepEqual(discover.authentication, { methods: ["anonymous"] });
    assert.equal(Object.hasOwn(discover, "auth"), false);
  });

  it("keeps both addresses off unless SHOPIFY_ORDER_ADDRESS_GATE is 1 or true", async () => {
    const off = [undefined, "", "   ", "0", "false", "FALSE", "off", "yes", "no", "2", "truee"];
    for (const value of off) {
      calls.length = 0;
      logs.length = 0;
      errors.length = 0;
      orderDeps.orderAddressGate = orderAddressGateEnabled(value);
      script.push(() => jsonResponse(200, asOrders([addressFixture()])));
      const response = await getOrder(base, "1001", {}, "email=buyer@example.com");
      const body = assertOrder(response);
      assert.equal(Object.hasOwn(body.order, "shippingAddress"), false, JSON.stringify(value));
      assert.equal(Object.hasOwn(body.order, "billingAddress"), false, JSON.stringify(value));
      assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
      assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false);
      const call = graphqlCall(calls, 0);
      assert.equal(call.query, ORDERS_BY_QUERY_DOCUMENT, JSON.stringify(value));
      assert.equal(/\bemail\b/.test(call.query), false);
      assert.equal(/\bshippingAddress\b/.test(call.query), false);
      assert.equal(/\bbillingAddress\b/.test(call.query), false);
      assert.equal(String(call.variables.query).includes("email:"), false);
      assertAddressFree(response.text);
      assertGateLogs(logs, errors);
    }
  });

  it("selects email and the six mailing-address fields on both queries when the gate is on", () => {
    for (const query of [ORDER_BY_ID_ADDRESS_DOCUMENT, ORDERS_BY_QUERY_ADDRESS_DOCUMENT]) {
      assertAddressSelection(query);
      assertFulfillmentSelection(query);
    }
    for (const query of [ORDER_BY_ID_DOCUMENT, ORDERS_BY_QUERY_DOCUMENT]) {
      assert.equal(/\bemail\b/.test(query), false);
      assert.equal(/\bshippingAddress\b/.test(query), false);
      assert.equal(/\bbillingAddress\b/.test(query), false);
    }
  });

  it("opens the gate when the email matches after trim and case fold", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    const spaced = await getOrder(base, "1001", {}, "email=%20Buyer@Example.com%20");
    const body = assertOpenOrder(spaced);
    assert.deepEqual(body.order.shippingAddress, {
      line1: "123 Main St",
      line2: "Apt 4B",
      city: "Berlin",
      region: "Berlin",
      country: "DE",
      postalCode: "10115",
    });
    assert.deepEqual(body.order.billingAddress, {
      line1: "9 Billing Rd",
      line2: "Suite 2",
      city: "Munich",
      region: "Bavaria",
      country: "DE",
      postalCode: "80331",
    });
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false);
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(spaced.text.includes("@"), false);
    const call = graphqlCall(calls, 0);
    assert.equal(call.query, ORDERS_BY_QUERY_ADDRESS_DOCUMENT);
    assert.equal(call.variables.query, 'name:"#1001"');
    assert.equal(String(call.variables.query).includes("email:"), false);
    assertAddressSelection(call.query);
    assertGateLogs(logs, errors);

    calls.length = 0;
    logs.length = 0;
    const trimmed = addressFixture();
    const shipping = trimmed.shippingAddress as Record<string, unknown>;
    shipping.address1 = "  123 Main St  ";
    shipping.address2 = "  Apt 4B  ";
    shipping.city = " Berlin ";
    shipping.province = "  ";
    shipping.countryCodeV2 = " DE ";
    shipping.zip = " 10115 ";
    script.push(() => jsonResponse(200, asOrders([trimmed])));
    const trimmedBody = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
    assert.deepEqual(trimmedBody.order.shippingAddress, {
      line1: "123 Main St",
      line2: "Apt 4B",
      city: "Berlin",
      country: "DE",
      postalCode: "10115",
    });
    assert.equal(Object.hasOwn(trimmedBody.order.shippingAddress ?? {}, "region"), false);
  });

  it("maps addresses on the order(id:) path when the email matches", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrder(addressFixture())));
    const response = await getOrder(base, GID, {}, "email=buyer@example.com");
    const body = assertOpenOrder(response);
    assert.equal(body.order.shippingAddress?.line1, "123 Main St");
    assert.equal(body.order.billingAddress?.line1, "9 Billing Rd");
    assert.equal(graphqlCall(calls, 0).query, ORDER_BY_ID_ADDRESS_DOCUMENT);
    assert.equal(logs.some((line) => line.includes("order status 200 gid lookup")), true);
    assertGateLogs(logs, errors);
  });

  it("uses the address selection on the name query and the legacy id", async () => {
    orderDeps.orderAddressGate = true;
    const legacy = addressFixture();
    legacy.name = "#EN1001";
    script.push(() => jsonResponse(200, asOrders([])));
    script.push(() => jsonResponse(200, asOrder(legacy)));
    const body = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
    assert.equal(body.order.id, "EN1001");
    assert.equal(graphqlCall(calls, 0).query, ORDERS_BY_QUERY_ADDRESS_DOCUMENT);
    assert.equal(graphqlCall(calls, 1).query, ORDER_BY_ID_ADDRESS_DOCUMENT);
    assert.equal(body.order.shippingAddress?.postalCode, "10115");
    assertGateLogs(logs, errors);
  });

  it("keeps email and addresses off line-item pages after the first read", async () => {
    orderDeps.orderAddressGate = true;
    const paged = splitLinePages(orderFixture());
    script.push(() => jsonResponse(200, asOrders([paged.first])));
    script.push(() => jsonResponse(200, asOrders([paged.second])));
    const searched = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
    assert.deepEqual(
      searched.order.items.map((item) => item.productId),
      ["variant-sku", "line-only-sku", "2003"],
    );
    assert.equal(searched.order.shippingAddress?.line1, "123 Main St");
    assert.equal(searched.order.billingAddress?.line1, "9 Billing Rd");
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 0).query, ORDERS_BY_QUERY_ADDRESS_DOCUMENT);
    assert.equal(graphqlCall(calls, 1).query, ORDERS_BY_QUERY_DOCUMENT);
    assert.equal(graphqlCall(calls, 1).variables.after, "line-page-2");
    assertPlainOrderSelection(graphqlCall(calls, 1).query);

    calls.length = 0;
    logs.length = 0;
    errors.length = 0;
    const byId = splitLinePages(orderFixture());
    script.push(() => jsonResponse(200, asOrder(byId.first)));
    script.push(() => jsonResponse(200, asOrder(byId.second)));
    const legacy = assertOpenOrder(await getOrder(base, GID, {}, "email=buyer@example.com"));
    assert.deepEqual(
      legacy.order.items.map((item) => item.productId),
      ["variant-sku", "line-only-sku", "2003"],
    );
    assert.equal(legacy.order.shippingAddress?.postalCode, "10115");
    assert.equal(graphqlCall(calls, 0).query, ORDER_BY_ID_ADDRESS_DOCUMENT);
    assert.equal(graphqlCall(calls, 1).query, ORDER_BY_ID_DOCUMENT);
    assert.equal(graphqlCall(calls, 1).variables.after, "line-page-2");
    assertPlainOrderSelection(graphqlCall(calls, 1).query);
    assertGateLogs(logs, errors);
  });

  it("stays address-free when the email is missing, repeated, malformed, or different", async () => {
    orderDeps.orderAddressGate = true;
    const queries = [
      "",
      "email=other@example.com",
      "email=not-an-email",
      "email=",
      "email=buyer@example.com&email=buyer@example.com",
      "Email=buyer@example.com",
      "email=a@b",
    ];
    for (const query of queries) {
      calls.length = 0;
      logs.length = 0;
      errors.length = 0;
      const order = addressFixture();
      if (query === "email=a@b") {
        order.email = "a@b";
      }
      script.push(() => jsonResponse(200, asOrders([order])));
      const response = await getOrder(base, "1001", {}, query);
      const body = assertOrder(response);
      assert.equal(response.status, 200, query);
      assert.notEqual(response.status, 400, query);
      assert.notEqual(response.status, 401, query);
      assert.notEqual(response.status, 403, query);
      assert.equal(Object.hasOwn(body.order, "shippingAddress"), false, query);
      assert.equal(Object.hasOwn(body.order, "billingAddress"), false, query);
      assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false, query);
      assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false, query);
      assert.equal(graphqlCall(calls, 0).query, ORDERS_BY_QUERY_ADDRESS_DOCUMENT, query);
      assertAddressFree(response.text);
      assertGateLogs(logs, errors);
    }
  });

  it("stays address-free when Order.email is null or blank", async () => {
    orderDeps.orderAddressGate = true;
    for (const fixture of ["order-address-email-null.json", "order-address-email-blank.json"]) {
      calls.length = 0;
      logs.length = 0;
      errors.length = 0;
      script.push(() => jsonResponse(200, asOrders([loadFixture(fixture)])));
      const response = await getOrder(base, "1001", {}, "email=buyer@example.com");
      const body = assertOrder(response);
      assert.equal(Object.hasOwn(body.order, "shippingAddress"), false, fixture);
      assert.equal(Object.hasOwn(body.order, "billingAddress"), false, fixture);
      assertAddressFree(response.text);
      assertGateLogs(logs, errors);
    }

    calls.length = 0;
    logs.length = 0;
    script.push(() => jsonResponse(200, asOrders([loadFixture("order-address-email-null.json")])));
    const customer = await getOrder(base, "1001", {}, "email=customer@example.com");
    const customerBody = assertOrder(customer);
    assert.equal(Object.hasOwn(customerBody.order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(customerBody.order, "billingAddress"), false);
    assertAddressFree(customer.text);
  });

  it("opens for a percent-encoded plus and stays closed when plus decodes as a space", async () => {
    orderDeps.orderAddressGate = true;
    const order = addressFixture();
    order.email = "buyer+tag@example.com";
    script.push(() => jsonResponse(200, asOrders([structuredClone(order)])));
    const openedResponse = await getOrder(base, "1001", {}, "email=buyer%2Btag@example.com");
    const opened = assertOpenOrder(openedResponse);
    assert.equal(opened.order.shippingAddress?.line1, "123 Main St");
    assert.equal(opened.order.billingAddress?.line1, "9 Billing Rd");
    assert.equal(openedResponse.text.includes("buyer+tag@example.com"), false);
    assert.equal(openedResponse.text.includes("@"), false);
    assertGateLogs(logs, errors);

    calls.length = 0;
    logs.length = 0;
    errors.length = 0;
    script.push(() => jsonResponse(200, asOrders([order])));
    const closedResponse = await getOrder(base, "1001", {}, "email=buyer+tag@example.com");
    const closed = assertOrder(closedResponse);
    assert.equal(Object.hasOwn(closed.order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(closed.order, "billingAddress"), false);
    assertAddressFree(closedResponse.text);
    assertGateLogs(logs, errors);
  });

  it("ignores an email sent only on a header", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    const response = await getOrder(base, "1001", { Email: "buyer@example.com" });
    const body = assertOrder(response);
    assert.equal(Object.hasOwn(body.order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(body.order, "billingAddress"), false);
    assertGateLogs(logs, errors);
  });

  it("ignores a Bearer token and still applies the query email", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    const anonymous = await getOrder(base, "1001");
    const bearer = await getOrder(base, "1001", { Authorization: "Bearer demo.jwt.leftover" });
    assert.equal(anonymous.status, 200);
    assert.equal(bearer.status, 200);
    assert.equal(bearer.text, anonymous.text);
    assert.notEqual(bearer.status, 401);
    assert.equal(Object.hasOwn((anonymous.json as OrderBody).order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(anonymous.json as OrderBody, "userId"), false);

    calls.length = 0;
    logs.length = 0;
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    const matchedResponse = await getOrder(
      base,
      "1001",
      { Authorization: "Bearer demo.jwt.leftover" },
      "email=buyer@example.com",
    );
    const matched = assertOpenOrder(matchedResponse);
    assert.equal(matched.order.shippingAddress?.line1, "123 Main St");
    assert.equal(Object.hasOwn(matched, "userId"), false);
    assert.equal(matchedResponse.text.includes("@"), false);
    assertGateLogs(logs, errors);
  });

  it("returns ORDER_NOT_FOUND for an unknown id even when email is well formed", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, { data: { order: null } }));
    const response = await getOrder(base, GID, {}, "email=buyer@example.com");
    assertNotFound(response);
    assert.equal((response.json as ProblemBody).detail?.includes("email"), false);
    assert.equal(response.text.includes("@"), false);
    assert.equal(response.text.includes("123 Main St"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assertGateLogs(logs, errors);
  });

  it("closes the gate when email is redacted and stays 200", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, loadFixture("order-address-redact-email.json")));
    const response = await getOrder(base, "1001", {}, "email=buyer@example.com");
    const body = assertOrder(response);
    assert.equal(Object.hasOwn(body.order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(body.order, "billingAddress"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assertAddressFree(response.text);
    assertGateLogs(logs, errors);
  });

  it("omits a redacted shipping address and still maps billing", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, loadFixture("order-address-redact-shipping-zip.json")));
    const zip = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
    assert.equal(Object.hasOwn(zip.order, "shippingAddress"), false);
    assert.equal(zip.order.billingAddress?.line1, "9 Billing Rd");
    assert.equal(zip.order.billingAddress?.postalCode, "80331");
    assert.equal(zip.order.id, "1001");
    assert.equal(JSON.stringify(zip).includes("123 Main St"), false);
    assertGateLogs(logs, errors);

    calls.length = 0;
    logs.length = 0;
    errors.length = 0;
    script.push(() => jsonResponse(200, loadFixture("order-address-redact-shipping-address.json")));
    const wholeResponse = await getOrder(base, "1001", {}, "email=buyer@example.com");
    const whole = assertOpenOrder(wholeResponse);
    assert.equal(wholeResponse.status, 200);
    assert.equal(Object.hasOwn(whole.order, "shippingAddress"), false);
    assert.equal(whole.order.billingAddress?.city, "Munich");
    assert.equal(wholeResponse.text.includes("123 Main St"), false);
    assertGateLogs(logs, errors);
  });

  it("returns 500 when an error is not limited to a gate field", async () => {
    orderDeps.orderAddressGate = true;
    for (const fixture of ["order-address-error-no-path.json", "order-address-error-order-path.json", "order-address-error-mixed.json"]) {
      calls.length = 0;
      logs.length = 0;
      errors.length = 0;
      script.push(() => jsonResponse(200, loadFixture(fixture)));
      const response = await getOrder(base, "1001", {}, "email=buyer@example.com");
      assertProblem(response, 500, "INTERNAL_ERROR");
      assert.equal(response.text.includes('"order"'), false, fixture);
      assert.equal((response.json as ProblemBody).detail, "The order request could not be completed.");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assertAddressFree(response.text);
      assertGateLogs(logs, errors);
    }
  });

  it("still asks for a reinstall when read_orders is missing and the gate is on", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, loadFixture("order-access-denied.json")));
    const response = await getOrder(base, "1001", {}, "email=buyer@example.com");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.text.includes('"order"'), false);
    assertGateLogs(logs, errors);
  });

  it("omits an address whose country is ZZ or whose required fields are missing", async () => {
    orderDeps.orderAddressGate = true;
    const rows: { fixture: string; shipping: boolean; absent: string[] }[] = [
      { fixture: "order-address-zz.json", shipping: false, absent: ["1 Unknown Way", "ZZ"] },
      { fixture: "order-address-zip-null.json", shipping: false, absent: ["123 Main St"] },
      { fixture: "order-address-country-null.json", shipping: false, absent: ["123 Main St"] },
      { fixture: "order-address-shipping-null.json", shipping: false, absent: ["123 Main St", "Apt 4B"] },
      { fixture: "order-address-missing-city.json", shipping: false, absent: ["123 Main St"] },
    ];
    for (const row of rows) {
      calls.length = 0;
      logs.length = 0;
      errors.length = 0;
      script.push(() => jsonResponse(200, asOrders([loadFixture(row.fixture)])));
      const body = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
      assert.equal(Object.hasOwn(body.order, "shippingAddress"), row.shipping, row.fixture);
      assert.equal(body.order.billingAddress?.line1, "9 Billing Rd", row.fixture);
      assert.equal(body.order.billingAddress?.city, "Munich", row.fixture);
      const text = JSON.stringify(body);
      for (const absent of row.absent) {
        assert.equal(text.includes(absent), false, `${row.fixture} ${absent}`);
      }
      assertGateLogs(logs, errors);
    }

    calls.length = 0;
    const spacedZz = addressFixture();
    (spacedZz.shippingAddress as Record<string, unknown>).countryCodeV2 = " ZZ ";
    script.push(() => jsonResponse(200, asOrders([spacedZz])));
    const zzBody = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
    assert.equal(Object.hasOwn(zzBody.order, "shippingAddress"), false);
    assert.equal(zzBody.order.billingAddress?.line1, "9 Billing Rd");
  });

  it("omits line2 and region when address2 and province are null", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([loadFixture("order-address-optional-blank.json")])));
    const body = assertOpenOrder(await getOrder(base, "1001", {}, "email=buyer@example.com"));
    assert.deepEqual(body.order.shippingAddress, {
      line1: "123 Main St",
      city: "Berlin",
      country: "DE",
      postalCode: "10115",
    });
    assert.deepEqual(body.order.billingAddress, {
      line1: "9 Billing Rd",
      city: "Munich",
      country: "DE",
      postalCode: "80331",
    });
    assert.equal(Object.hasOwn(body.order.shippingAddress ?? {}, "line2"), false);
    assert.equal(Object.hasOwn(body.order.shippingAddress ?? {}, "region"), false);
    assert.equal(Object.hasOwn(body.order.billingAddress ?? {}, "line2"), false);
    assert.equal(Object.hasOwn(body.order.billingAddress ?? {}, "region"), false);
    assertGateLogs(logs, errors);
  });

  it("does not return email, phone, name, or card fragments when the gate is open", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    const response = await getOrder(base, "1001", {}, "email=buyer@example.com");
    const body = assertOpenOrder(response);
    assert.equal(body.order.payment?.method, "shopify_payments");
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false);
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(Object.hasOwn(body, "extensions"), false);
    assert.equal(response.text.includes("@"), false);
    assertNoBuyerSecrets(response.text);
    assertGateLogs(logs, errors);
  });

  it("treats one email parameter as case-sensitive and still opens beside a different name", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([addressFixture()])));
    const body = assertOpenOrder(
      await getOrder(base, "1001", {}, "email=buyer@example.com&Email=other@example.com"),
    );
    assert.equal(body.order.shippingAddress?.line1, "123 Main St");
    assert.equal(JSON.stringify(body).includes("other@example.com"), false);
    assertGateLogs(logs, errors);
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

function asOrders(nodes: unknown[]): unknown {
  return { data: { orders: { nodes } } };
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

function expectAdmin(call: GraphqlCall): void {
  assert.equal(call.url, `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(call.headers["X-Shopify-Access-Token"], ADMIN_TOKEN);
  assert.equal(call.headers["Shopify-Storefront-Buyer-IP"], undefined);
  assert.equal(call.query.includes("orderByIdentifier"), false);
  assert.equal(/\bshippingAddress\b/.test(call.query), false);
  assert.equal(/\bbillingAddress\b/.test(call.query), false);
  assert.equal(call.query.includes("CardPaymentDetails"), false);
  assert.equal(/\bemail\b/.test(call.query), false);
  assert.equal(/\bphone\b/.test(call.query), false);
  assert.equal(/\bcustomer\b/.test(call.query), false);
  assert.equal(/^\s+id$/m.test(call.query), false);
  assert.equal(call.query.includes("legacyResourceId"), true);
}

async function getOrder(
  base: string,
  id: string,
  headers: Record<string, string> = {},
  query = "",
): Promise<HttpResult> {
  const path = id === "" ? "/api/fastbuyjson/orders/" : `/api/fastbuyjson/orders/${encodeURIComponent(id)}`;
  const suffix = query === "" ? "" : query.startsWith("?") ? query : `?${query}`;
  return requestOrder(base, `${path}${suffix}`, headers);
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
  assertSafe(response.text);
  return response.json as OrderBody;
}

function assertOpenOrder(response: HttpResult): OrderBody {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(validateSchema("order-status.json", response.json), true);
  assertNoBuyerSecrets(response.text);
  return response.json as OrderBody;
}

function addressFixture(): Record<string, unknown> {
  return structuredClone(loadFixture("order-address-gate.json")) as Record<string, unknown>;
}

function splitLinePages(order: Record<string, unknown>): { first: Record<string, unknown>; second: Record<string, unknown> } {
  const first = order;
  const connection = first.lineItems as { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
  const rest = connection.nodes.slice(1);
  connection.nodes = connection.nodes.slice(0, 1);
  connection.pageInfo = { hasNextPage: true, endCursor: "line-page-2" };
  const second = orderFixture();
  const secondConnection = second.lineItems as {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: unknown[];
  };
  secondConnection.nodes = rest;
  secondConnection.pageInfo = { hasNextPage: false, endCursor: null };
  return { first, second };
}

function assertPlainOrderSelection(query: string): void {
  assert.equal(/\bemail\b/.test(query), false);
  assert.equal(/\bshippingAddress\b/.test(query), false);
  assert.equal(/\bbillingAddress\b/.test(query), false);
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

function assertNoBuyerSecrets(text: string): void {
  assert.equal(text.toLowerCase().includes("gid://"), false);
  assert.equal(text.includes(ADMIN_TOKEN), false);
  assert.equal(text.includes(REFRESH_TOKEN), false);
  assert.equal(text.includes("buyer@example.com"), false);
  assert.equal(text.includes("customer@example.com"), false);
  assert.equal(text.includes("buyer+tag@example.com"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("Ada Lovelace"), false);
  assert.equal(text.includes("Visa"), false);
  assert.equal(text.includes("lastFourDigits"), false);
  assert.equal(text.includes("CardPaymentDetails"), false);
  assert.equal(text.includes("+15555550100"), false);
  assert.equal(text.includes("999 Display Only"), false);
  assert.equal(text.includes("BE-CODE"), false);
  assert.equal(text.includes("BY-CODE"), false);
  assert.equal(text.includes("Analytical Engines"), false);
  assert.equal(text.includes("Germany"), false);
  assert.equal(text.includes("userId"), false);
}

function assertGateLogs(seenLogs: string[], seenErrors: string[]): void {
  const text = `${seenLogs.join("\n")}\n${seenErrors.join("\n")}`;
  assertAddressFree(text);
  assert.equal(text.includes("email="), false);
  assert.equal(text.includes("@"), false);
}

function assertAddressSelection(query: string): void {
  assert.match(query, /\bemail\b/);
  const blocks = [...query.matchAll(/(?:shipping|billing)Address\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    for (const field of ["address1", "address2", "city", "province", "countryCodeV2", "zip"]) {
      assert.match(block, new RegExp(`\\b${field}\\b`));
    }
    assert.equal(/\bphone\b/.test(block), false);
    assert.equal(/\bname\b/.test(block), false);
    assert.equal(/\bfirstName\b/.test(block), false);
    assert.equal(/\blastName\b/.test(block), false);
    assert.equal(/\bcompany\b/.test(block), false);
    assert.equal(/\blatitude\b/.test(block), false);
    assert.equal(/\blongitude\b/.test(block), false);
    assert.equal(/\bcountryCode\b/.test(block), false);
    assert.equal(/\bprovinceCode\b/.test(block), false);
    assert.equal(/\bcountry\b/.test(block), false);
  }
  assert.equal(/\bphone\b/.test(query), false);
  assert.equal(/\bcustomer\b/.test(query), false);
  assert.equal(/\bdisplayAddress\b/.test(query), false);
  assert.equal(/\bfirstName\b/.test(query), false);
  assert.equal(/\blastName\b/.test(query), false);
  assert.equal(/\blatitude\b/.test(query), false);
  assert.equal(/\blongitude\b/.test(query), false);
  assert.equal(/\bprovinceCode\b/.test(query), false);
  assert.equal(/\bCardPaymentDetails\b/.test(query), false);
  assert.equal(/\bcountryCode\b/.test(query), false);
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
