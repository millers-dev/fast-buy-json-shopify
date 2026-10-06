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
import { CUSTOMER_APP_URL_DETAIL, CUSTOMER_LOGIN_INCOMPLETE_DETAIL, customerSub, signFastBuyJwt } from "../src/customer-login-crypto.js";
import { CUSTOMER_USER_AGENT } from "../src/customer-login-shopify.js";
import type { ConnectorDeps } from "../src/deps.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { ORDER_BY_ID_DOCUMENT, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT, ORDERS_BY_QUERY_ADDRESS_DOCUMENT } from "../src/order-query.js";
import { REINSTALL_DETAIL } from "../src/problems.js";
import { createConnectorServer, listen } from "../src/server.js";
import { SHOPIFY_BACKOFF_MS } from "../src/shopify-graphql.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const APP_URL = "https://app.example.com";
const ADMIN_TOKEN = "shpat_order_admin_token";
const REFRESH_TOKEN = "shprt_order_refresh_token";
const CUSTOMER_ACCESS = "shcat_customer_access_token";
const CUSTOMER_GID = "gid://shopify/Customer/42";
const ORDER_GID = "gid://shopify/Order/1001";
const GRAPHQL_URL = "https://accounts.example.com/customer/api/2026-10/graphql";
const SUB_SECRET = "customer-sub-secret-at-least-32-bytes";
const JWT_SECRET = "jwt-secret-for-fastbuyjson-tests-32b";
const FIXED_NOW = 1_700_000_000_000;
const SUB = customerSub(SUB_SECRET, CUSTOMER_GID);

type GraphqlCall = {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

type HttpResult = { status: number; headers: Headers; json: unknown; text: string };

type ProblemBody = { type: string; status: number; code: string; detail?: string };

type OrderBody = {
  order: {
    id: string;
    status: string;
    totals: { subtotal: number; shipping?: number; total: number };
    payment?: { status: string; lastFourDigits?: string; brand?: string };
    shipment?: { trackingNumber?: string; carrier?: string };
    items?: { productId: string }[];
    shippingAddress?: PostalAddress;
    billingAddress?: PostalAddress;
  };
};

type PostalAddress = {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  country: string;
  postalCode: string;
};

describe("customer-mode GET /orders/{orderId}", () => {
  let server: Server;
  let base: string;
  let tokens: TokenStore;
  let orderDeps: ConnectorDeps;
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let script: Array<() => Response> = [];
  const sleepDelays: number[] = [];
  const logs: string[] = [];
  let now = FIXED_NOW;
  let originalLog: typeof console.log;

  before(async () => {
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    const file = join(mkdtempSync(join(tmpdir(), "fastbuyjson-owned-")), "tokens.sqlite");
    tokens = await TokenStore.open(file, randomBytes(32));
    const deps: ConnectorDeps = {
      app: {
        shopDomain: SHOP,
        clientId: "dev-dashboard-client-id",
        clientSecret: "shpss_test_client_secret_44cd",
        apiVersion: SHOPIFY_API_VERSION,
        appUrl: APP_URL,
      },
      tokens,
      oauthState: new OauthStateStore(),
      now: () => now,
      customerAccounts: true,
      customerSubSecret: SUB_SECRET,
      jwtSecret: JWT_SECRET,
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
    now = FIXED_NOW;
    orderDeps.customerAccounts = true;
    orderDeps.customerSubSecret = SUB_SECRET;
    orderDeps.jwtSecret = JWT_SECRET;
    orderDeps.orderAddressGate = false;
    orderDeps.app.appUrl = APP_URL;
    tokens.save(sampleToken(), FIXED_NOW);
    tokens.customer.saveSession(SHOP, SUB, CUSTOMER_ACCESS, FIXED_NOW + 3_600_000, GRAPHQL_URL);
  });

  after(async () => {
    console.log = originalLog;
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("requires a bearer JWT and does not return an order", async () => {
    const response = await getOrder(base, "1001");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assertProblem(response, 401, "AUTHENTICATION_REQUIRED");
    const body = response.json as ProblemBody;
    assert.equal(body.type, "https://fastbuyjson.org/problems/authentication-required");
    assert.equal(Object.hasOwn(response.json as object, "order"), false);
    assert.equal(calls.length, 0);
    assertSafe(response.text);
  });

  it("rejects a malformed, wrongly signed, or expired JWT", async () => {
    const malformed = await getOrder(base, "1001", { Authorization: "Bearer not-a-jwt" });
    assertProblem(malformed, 401, "INVALID_TOKEN");
    assert.equal(malformed.headers.get("www-authenticate"), "Bearer");

    const wrong = await getOrder(base, "1001", { Authorization: `Bearer ${signFastBuyJwt("other-secret-not-the-jwt-secret", SUB, FIXED_NOW, 3600)}` });
    assertProblem(wrong, 401, "INVALID_TOKEN");

    const expired = signFastBuyJwt(JWT_SECRET, SUB, FIXED_NOW - 7_200_000, 3600);
    const stale = await getOrder(base, "1001", { Authorization: `Bearer ${expired}` });
    assertProblem(stale, 401, "INVALID_TOKEN");
    assert.equal(calls.length, 0);
    assert.equal(tokens.customer.countSessions(), 1);
    assertSafe(malformed.text + wrong.text + stale.text);
  });

  it("rejects a bearer scheme that is not a JWT and a missing session", async () => {
    const basic = await getOrder(base, "1001", { Authorization: "Basic abc" });
    assertProblem(basic, 401, "INVALID_TOKEN");
    const bare = await getOrder(base, "1001", { Authorization: "Bearer" });
    assertProblem(bare, 401, "INVALID_TOKEN");

    tokens.customer.deleteSession(SUB);
    const missing = await getOrder(base, "1001", authHeaders());
    assertProblem(missing, 401, "INVALID_TOKEN");
    assert.equal(calls.length, 0);
  });

  it("rejects an expired customer access token without calling Shopify", async () => {
    tokens.customer.saveSession(SHOP, SUB, CUSTOMER_ACCESS, FIXED_NOW - 1, GRAPHQL_URL);
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 401, "INVALID_TOKEN");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal(tokens.customer.countSessions(), 0);
    assert.equal(calls.length, 0);
  });

  it("returns 500 when a signing secret is missing instead of an anonymous order", async () => {
    delete orderDeps.jwtSecret;
    const response = await getOrder(base, "1001");
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, CUSTOMER_LOGIN_INCOMPLETE_DETAIL);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(calls.length, 0);
    assert.equal(response.text.includes(SUB_SECRET), false);
    assert.equal(response.text.includes("gid://"), false);
  });

  it("maps one owned order with both addresses and omits card fields", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(deliveredWithSecrets())));
    const response = await getOrder(base, "1001", authHeaders());
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(body.order.status, "delivered");
    assert.equal(JSON.stringify(body.order.totals.subtotal), "19.99");
    assert.equal(body.order.payment?.status, "approved");
    assert.equal(body.order.shipment?.trackingNumber, "TRACK-DELIVERED");
    assert.equal(body.order.shipment?.carrier, "DHL");
    assert.deepEqual(body.order.shippingAddress, SHIPPING);
    assert.deepEqual(body.order.billingAddress, BILLING);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false);
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(response.text.includes("gid://"), false);
    assert.equal(response.text.includes("123 Main St"), true);
    assert.equal(response.text.includes("4242"), false);
    assert.equal(response.text.includes("Visa"), false);
    assertNoBuyerIdentity(response.text);

    assert.equal(calls.length, 2);
    const owned = graphqlCall(calls, 0);
    expectCustomer(owned);
    assert.equal(owned.query.includes("orders(first: 2"), true);
    assert.equal(owned.query.includes("order(id:"), false);
    assert.equal(owned.query.includes("1001"), false);
    assert.equal(owned.variables.query, "name:#1001");
    assert.equal(/\bemail\b/.test(owned.query), false);
    const admin = graphqlCall(calls, 1);
    expectOwnedAdmin(admin);
    assert.equal(admin.query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
    assert.equal(admin.variables.id, ORDER_GID);
    assert.equal(logs.some((line) => line.includes("order status 200 1001 customer-accounts-on")), true);
    assertSafe(response.text);
    assertSafe(logs.join("\n"));
    assertAddressFreeLogs(logs.join("\n"));
  });

  it("uses the client token for a confirmation number and the order name for a GID", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(deliveredWithSecrets())));
    const named = assertOrder(await getOrder(base, "XPAV284CT", authHeaders()));
    assert.equal(named.order.id, "XPAV284CT");
    assert.equal(
      graphqlCall(calls, 0).variables.query,
      'name:"XPAV284CT" OR name:"#XPAV284CT" OR confirmation_number:"XPAV284CT"',
    );

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    const renamed = deliveredWithSecrets();
    renamed.name = "#EN1001";
    script.push(() => jsonResponse(200, asOrder(renamed)));
    const gid = assertOrder(await getOrder(base, ORDER_GID, authHeaders()));
    assert.equal(gid.order.id, "EN1001");
    assert.equal(graphqlCall(calls, 0).variables.query, "id:1001");
    assert.equal(graphqlCall(calls, 1).variables.id, ORDER_GID);
    assert.equal(logs.some((line) => line.includes("gid lookup")), true);
    assert.equal(logs.some((line) => line.includes("gid://")), false);
    assert.equal(gid.order.id.includes("gid://"), false);
  });

  it("falls through from name:#digits to id:digits and then Admin order(id:)", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-none.json")));
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    const order = deliveredWithSecrets();
    order.name = "#EN1001";
    script.push(() => jsonResponse(200, asOrder(order)));
    const body = assertOrder(await getOrder(base, "#1001", authHeaders()));
    assert.equal(body.order.id, "EN1001");
    assert.equal(calls.length, 3);
    assert.equal(graphqlCall(calls, 0).variables.query, "name:#1001");
    assert.equal(graphqlCall(calls, 1).variables.query, "id:1001");
    expectOwnedAdmin(graphqlCall(calls, 2));
    assert.equal(calls.filter((call) => call.url.includes("/admin/")).length, 1);
  });

  it("returns one 404 when ownership finds nothing or two orders and does not call Admin", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-none.json")));
    script.push(() => jsonResponse(200, loadFixture("customer-orders-none.json")));
    const none = await getOrder(base, "1001", authHeaders());
    assertNotFound(none);
    assert.equal(calls.length, 2);
    assert.equal(graphqlCall(calls, 0).variables.query, "name:#1001");
    assert.equal(graphqlCall(calls, 1).variables.query, "id:1001");
    assert.equal(calls.every((call) => call.url === GRAPHQL_URL), true);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-none.json")));
    const search = await getOrder(base, "XPAV284CT", authHeaders());
    assertNotFound(search);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, GRAPHQL_URL);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-two.json")));
    const many = await getOrder(base, "1001", authHeaders());
    assertNotFound(many);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.includes("/admin/"), false);
    assert.equal(many.text.toLowerCase().includes("another customer"), false);
    assert.equal((none.json as ProblemBody).detail, (many.json as ProblemBody).detail);
    assert.deepEqual(none.json, search.json);
    assert.equal(tokens.customer.countSessions(), 1);
  });

  it("returns the same 404 when the owned GID does not match or Admin order(id:) is null", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-wrong-gid.json")));
    const mismatch = await getOrder(base, ORDER_GID, authHeaders());
    assertNotFound(mismatch);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, GRAPHQL_URL);

    calls.length = 0;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, { data: { order: null } }));
    const missing = await getOrder(base, ORDER_GID, authHeaders());
    assertNotFound(missing);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.url.includes("/admin/"), true);
    assert.deepEqual(mismatch.json, missing.json);
    assert.equal(missing.text.toLowerCase().includes("another customer"), false);
    assert.equal(missing.text.includes("window"), false);
  });

  it("maps addresses when the email does not match and the address gate is on", async () => {
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(loadFixture("order-address-gate.json"))));
    const response = await getOrder(base, "1001", authHeaders(), "email=other@example.com");
    const body = assertOrder(response);
    assert.deepEqual(body.order.shippingAddress, SHIPPING);
    assert.deepEqual(body.order.billingAddress, BILLING);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "lastFourDigits"), false);
    assert.equal(Object.hasOwn(body.order.payment ?? {}, "brand"), false);
    const admin = graphqlCall(calls, 1);
    assert.equal(admin.query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
    assert.notEqual(admin.query, ORDERS_BY_QUERY_ADDRESS_DOCUMENT);
    assert.equal(/\bemail\b/.test(admin.query), false);
    assert.equal(admin.query.includes("CardPaymentDetails"), false);
    assertNoBuyerIdentity(response.text);
    assert.equal(response.text.includes("4242"), false);
    assert.equal(logs.join("\n").includes("email="), false);
    assertAddressFreeLogs(logs.join("\n"));
    assertSafe(response.text);
  });

  it("returns 401 when the Customer Account API rejects the access token", async () => {
    script.push(() => jsonResponse(401, { errors: [{ message: "invalid_token" }] }));
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 401, "INVALID_TOKEN");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, GRAPHQL_URL);
    assert.equal(tokens.customer.countSessions(), 1);
    assert.equal(response.text.includes(CUSTOMER_ACCESS), false);
  });

  it("asks for a reinstall when customer_read_orders is missing and does not call Admin", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-scope.json")));
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.includes("/admin/"), false);
    assert.equal(response.text.includes(CUSTOMER_ACCESS), false);
    assert.equal(response.text.includes(ADMIN_TOKEN), false);
    assert.equal(response.text.includes("gid://"), false);
    assert.equal(tokens.customer.countSessions(), 1);
    assert.equal(tokens.get()?.accessToken, ADMIN_TOKEN);
  });

  it("returns 500 when the ownership query errors and does not return a partial order", async () => {
    script.push(() => jsonResponse(200, { errors: [{ message: "something else" }], data: { customer: null } }));
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, "The order request could not be completed.");
    assert.notEqual((response.json as ProblemBody).detail, REINSTALL_DETAIL);
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(response.json as object, "order"), false);
    assert.equal(tokens.customer.countSessions(), 1);
  });

  it("deletes the session when customer id does not match the JWT sub", async () => {
    script.push(() => jsonResponse(200, loadFixture("customer-orders-other-customer.json")));
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 401, "INVALID_TOKEN");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal(tokens.customer.countSessions(), 0);
    assert.equal(tokens.customer.getSession(SHOP, SUB), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.includes("/admin/"), false);
    assert.equal(response.text.includes("gid://"), false);
    assert.equal(response.text.includes(CUSTOMER_ACCESS), false);
  });

  it("backs off once on a Customer Account API throttle and then maps the order", async () => {
    script.push(() => jsonResponse(429, { errors: [{ extensions: { code: "THROTTLED" } }] }));
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(deliveredWithSecrets())));
    const response = await getOrder(base, "1001", authHeaders());
    assert.equal(response.status, 200);
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.filter((call) => call.url === GRAPHQL_URL).length, 2);
    assert.equal(calls.filter((call) => call.url.includes("/admin/")).length, 1);
  });

  it("returns 429 when the ownership query stays throttled and does not call Admin", async () => {
    script.push(() => jsonResponse(200, { errors: [{ extensions: { code: "THROTTLED" } }] }));
    script.push(() => jsonResponse(429, {}));
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 429, "RATE_LIMITED");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.every((call) => call.url === GRAPHQL_URL), true);
    assert.equal(response.text.includes(CUSTOMER_ACCESS), false);
  });

  it("does not call the Customer Account API for a rejected order id once the JWT is valid", async () => {
    const response = await getOrder(base, "gid://shopify/Product/1", authHeaders());
    assertNotFound(response);
    assert.equal(calls.length, 0);
    assert.equal(logs.some((line) => line.includes("gid://")), false);
  });

  it("omits an address whose country is ZZ or whose required field is missing", async () => {
    const rows = ["order-address-zz.json", "order-address-zip-null.json", "order-address-country-null.json", "order-address-shipping-null.json", "order-address-missing-city.json"];
    for (const fixture of rows) {
      calls.length = 0;
      logs.length = 0;
      script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
      script.push(() => jsonResponse(200, asOrder(loadFixture(fixture))));
      const response = await getOrder(base, "1001", authHeaders(), "email=buyer@example.com");
      const body = assertOrder(response);
      assert.equal(Object.hasOwn(body.order, "shippingAddress"), false, fixture);
      assert.equal(body.order.billingAddress?.line1, "9 Billing Rd", fixture);
      assert.equal(body.order.billingAddress?.city, "Munich", fixture);
      assert.equal(response.text.includes("1 Unknown Way"), false, fixture);
      assert.equal(response.text.includes("123 Main St"), false, fixture);
      assert.equal(response.text.includes("ZZ"), false, fixture);
      assertNoBuyerIdentity(response.text);
      assertAddressFreeLogs(logs.join("\n"));
      assert.equal(graphqlCall(calls, 1).query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT, fixture);
    }
  });

  it("omits a redacted shipping address and still maps billing", async () => {
    const zip = addressFixture();
    const shipping = zip.shippingAddress as Record<string, unknown>;
    shipping.zip = null;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, ownedAddressError(zip, ["shippingAddress", "zip"])));
    const zipBody = assertOrder(await getOrder(base, "1001", authHeaders()));
    assert.equal(Object.hasOwn(zipBody.order, "shippingAddress"), false);
    assert.deepEqual(zipBody.order.billingAddress, BILLING);
    assert.equal(JSON.stringify(zipBody).includes("123 Main St"), false);
    assertAddressFreeLogs(logs.join("\n"));

    calls.length = 0;
    logs.length = 0;
    const whole = addressFixture();
    whole.shippingAddress = null;
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, ownedAddressError(whole, ["shippingAddress"])));
    const wholeResponse = await getOrder(base, "1001", authHeaders());
    const wholeBody = assertOrder(wholeResponse);
    assert.equal(wholeResponse.status, 200);
    assert.equal(Object.hasOwn(wholeBody.order, "shippingAddress"), false);
    assert.equal(wholeBody.order.billingAddress?.city, "Munich");
    assert.equal(wholeResponse.text.includes("123 Main St"), false);
    assertAddressFreeLogs(logs.join("\n"));
  });

  it("returns 500 when an error path is email, another field, or missing", async () => {
    const cases: { name: string; body: unknown }[] = [
      { name: "email", body: ownedAddressError(addressFixture(), ["email"]) },
      { name: "fulfillments", body: ownedAddressError(addressFixture(), ["fulfillments"]) },
      { name: "no-path", body: { data: { order: addressFixture() }, errors: [{ message: "Something went wrong." }] } },
    ];
    for (const row of cases) {
      calls.length = 0;
      logs.length = 0;
      script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
      script.push(() => jsonResponse(200, row.body));
      const response = await getOrder(base, "1001", authHeaders());
      assertProblem(response, 500, "INTERNAL_ERROR");
      assert.equal((response.json as ProblemBody).detail, "The order request could not be completed.");
      assert.equal(Object.hasOwn(response.json as object, "order"), false, row.name);
      assert.equal(response.text.includes("123 Main St"), false, row.name);
      assert.equal(response.text.includes("buyer@example.com"), false, row.name);
      assertAddressFreeLogs(logs.join("\n"));
    }
  });

  it("keeps the address selection off later line-item pages", async () => {
    const pages = splitOwnedLines(addressedAdminOrder());
    script.push(() => jsonResponse(200, loadFixture("customer-orders-one.json")));
    script.push(() => jsonResponse(200, asOrder(pages.first)));
    script.push(() => jsonResponse(200, asOrder(pages.second)));
    const body = assertOrder(await getOrder(base, "1001", authHeaders()));
    assert.deepEqual(
      body.order.items?.map((item) => item.productId),
      ["variant-sku", "line-only-sku", "2003"],
    );
    assert.deepEqual(body.order.shippingAddress, SHIPPING);
    assert.deepEqual(body.order.billingAddress, BILLING);
    assert.equal(calls.length, 3);
    assert.equal(graphqlCall(calls, 1).query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
    assert.equal(graphqlCall(calls, 2).query, ORDER_BY_ID_DOCUMENT);
    assert.equal(graphqlCall(calls, 2).variables.after, "line-page-2");
    assert.equal(/\bshippingAddress\b/.test(graphqlCall(calls, 2).query), false);
    assert.equal(/\bbillingAddress\b/.test(graphqlCall(calls, 2).query), false);
    assert.equal(/\bemail\b/.test(graphqlCall(calls, 2).query), false);
    assertNoBuyerIdentity(JSON.stringify(body));
  });

  it("keeps anonymous order reads when the flag is off", async () => {
    orderDeps.customerAccounts = false;
    script.push(() => jsonResponse(200, asOrders([loadFixture("order-admin.json")])));
    const response = await getOrder(base, "1001", { Authorization: "Bearer demo.jwt.leftover" });
    const body = assertOrder(response);
    assert.equal(body.order.id, "1001");
    assert.equal(body.order.status, "confirmed");
    assert.equal(calls.length, 1);
    expectAdmin(graphqlCall(calls, 0));
    assert.equal(graphqlCall(calls, 0).variables.query, 'name:"#1001"');
    assert.equal(logs.some((line) => line.includes("customer-accounts-on")), false);
    assert.equal(response.headers.get("www-authenticate"), null);
  });

  it("keeps the email gate when customer accounts are off", async () => {
    orderDeps.customerAccounts = false;
    orderDeps.orderAddressGate = true;
    script.push(() => jsonResponse(200, asOrders([loadFixture("order-address-gate.json")])));
    const opened = assertOrder(await getOrder(base, "1001", { Authorization: "Bearer demo.jwt.leftover" }, "email=buyer@example.com"));
    assert.deepEqual(opened.order.shippingAddress, SHIPPING);
    assert.deepEqual(opened.order.billingAddress, BILLING);
    assert.equal(graphqlCall(calls, 0).query, ORDERS_BY_QUERY_ADDRESS_DOCUMENT);
    assert.equal(calls.length, 1);
    assertNoBuyerIdentity(JSON.stringify(opened));

    calls.length = 0;
    logs.length = 0;
    script.push(() => jsonResponse(200, asOrders([loadFixture("order-address-gate.json")])));
    const closed = assertOrder(await getOrder(base, "1001", {}, "email=other@example.com"));
    assert.equal(Object.hasOwn(closed.order, "shippingAddress"), false);
    assert.equal(Object.hasOwn(closed.order, "billingAddress"), false);
    assert.equal(closed.order.id, "1001");
    assert.equal(JSON.stringify(closed).includes("123 Main St"), false);
  });

  it("asks the buyer to log in again when the session has no Customer Account API URL", async () => {
    tokens.customer.saveSession(SHOP, SUB, CUSTOMER_ACCESS, FIXED_NOW + 3_600_000);
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 401, "INVALID_TOKEN");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal(tokens.customer.countSessions(), 0);
    assert.equal(tokens.customer.getSession(SHOP, SUB), null);
    assert.equal(calls.length, 0);
    assert.equal(response.text.includes("gid://"), false);
    assert.equal(response.text.includes(CUSTOMER_ACCESS), false);
  });

  it("returns 500 when APP_URL is missing and does not call Shopify", async () => {
    delete orderDeps.app.appUrl;
    const response = await getOrder(base, "1001", authHeaders());
    assertProblem(response, 500, "INTERNAL_ERROR");
    assert.equal((response.json as ProblemBody).detail, CUSTOMER_APP_URL_DETAIL);
    assert.equal(calls.length, 0);
  });
});

function deliveredWithSecrets(): Record<string, unknown> {
  const order = structuredClone(loadFixture("order-delivered.json")) as Record<string, unknown>;
  const addressed = loadFixture("order-address-gate.json") as Record<string, unknown>;
  order.email = addressed.email;
  order.shippingAddress = addressed.shippingAddress;
  order.billingAddress = addressed.billingAddress;
  order.transactions = addressed.transactions;
  return order;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${signFastBuyJwt(JWT_SECRET, SUB, FIXED_NOW, 3600)}` };
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

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(metadata.root, "tests", "fixtures", name), "utf8")) as unknown;
}

function asOrder(order: unknown): unknown {
  return { data: { order } };
}

function asOrders(nodes: unknown[]): unknown {
  return { data: { orders: { nodes } } };
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
    variables: parsed.variables as Record<string, unknown>,
  };
}

function expectCustomer(call: GraphqlCall): void {
  assert.equal(call.url, GRAPHQL_URL);
  assert.equal(call.headers.Authorization, CUSTOMER_ACCESS);
  assert.equal(call.headers.Authorization?.startsWith("Bearer "), false);
  assert.equal(call.headers["User-Agent"], CUSTOMER_USER_AGENT);
  assert.equal(call.headers.Origin, APP_URL);
  assert.equal(call.url.includes("myshopify.com"), false);
}

function expectAdmin(call: GraphqlCall): void {
  assert.equal(call.url, `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(call.headers["X-Shopify-Access-Token"], ADMIN_TOKEN);
  assert.equal(/\bshippingAddress\b/.test(call.query), false);
  assert.equal(/\bbillingAddress\b/.test(call.query), false);
  assert.equal(/\bemail\b/.test(call.query), false);
  assert.equal(call.query.includes("CardPaymentDetails"), false);
}

function expectOwnedAdmin(call: GraphqlCall): void {
  assert.equal(call.url, `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(call.headers["X-Shopify-Access-Token"], ADMIN_TOKEN);
  assert.equal(call.query, ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT);
  assertOwnerAddressSelection(call.query);
  assert.equal(call.query.includes("CardPaymentDetails"), false);
}

function assertOwnerAddressSelection(query: string): void {
  assert.equal(/\bemail\b/.test(query), false);
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
    assert.equal(/\bcountry\b/.test(block), false);
    assert.equal(/\bcountryCode\b/.test(block), false);
    assert.equal(/\bprovinceCode\b/.test(block), false);
  }
  assert.equal(/\bphone\b/.test(query), false);
  assert.equal(/\bcustomer\b/.test(query), false);
  assert.equal(/\bdisplayAddress\b/.test(query), false);
  assert.equal(/\bCardPaymentDetails\b/.test(query), false);
}

const SHIPPING: PostalAddress = {
  line1: "123 Main St",
  line2: "Apt 4B",
  city: "Berlin",
  region: "Berlin",
  country: "DE",
  postalCode: "10115",
};

const BILLING: PostalAddress = {
  line1: "9 Billing Rd",
  line2: "Suite 2",
  city: "Munich",
  region: "Bavaria",
  country: "DE",
  postalCode: "80331",
};

function addressFixture(): Record<string, unknown> {
  return structuredClone(loadFixture("order-address-gate.json")) as Record<string, unknown>;
}

function addressedAdminOrder(): Record<string, unknown> {
  const order = structuredClone(loadFixture("order-admin.json")) as Record<string, unknown>;
  const addressed = addressFixture();
  order.email = addressed.email;
  order.shippingAddress = addressed.shippingAddress;
  order.billingAddress = addressed.billingAddress;
  order.transactions = addressed.transactions;
  return order;
}

function ownedAddressError(order: Record<string, unknown>, path: unknown[]): unknown {
  return {
    data: { order },
    errors: [
      {
        message: "Access denied for address field.",
        path: ["order", ...path],
        extensions: { code: "ACCESS_DENIED" },
      },
    ],
  };
}

function splitOwnedLines(order: Record<string, unknown>): { first: Record<string, unknown>; second: Record<string, unknown> } {
  const first = order;
  const connection = first.lineItems as { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
  const rest = connection.nodes.slice(1);
  connection.nodes = connection.nodes.slice(0, 1);
  connection.pageInfo = { hasNextPage: true, endCursor: "line-page-2" };
  const second = structuredClone(loadFixture("order-admin.json")) as Record<string, unknown>;
  const secondConnection = second.lineItems as { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
  secondConnection.nodes = rest;
  secondConnection.pageInfo = { hasNextPage: false, endCursor: null };
  return { first, second };
}

function assertNoBuyerIdentity(text: string): void {
  assert.equal(text.includes("buyer@example.com"), false);
  assert.equal(text.includes("customer@example.com"), false);
  assert.equal(text.includes("@"), false);
  assert.equal(text.includes("Ada Lovelace"), false);
  assert.equal(text.includes("+15555550100"), false);
  assert.equal(text.includes("999 Display Only"), false);
  assert.equal(text.includes("Germany"), false);
  assert.equal(text.includes("BE-CODE"), false);
  assert.equal(text.includes("Visa"), false);
  assert.equal(text.includes("4242"), false);
  assert.equal(text.includes("userId"), false);
}

function assertAddressFreeLogs(text: string): void {
  assert.equal(text.includes("123 Main St"), false);
  assert.equal(text.includes("9 Billing Rd"), false);
  assert.equal(text.includes("buyer@example.com"), false);
  assert.equal(text.includes("email="), false);
  assert.equal(text.includes("@"), false);
}

async function getOrder(
  base: string,
  id: string,
  headers: Record<string, string> = {},
  query = "",
): Promise<HttpResult> {
  const suffix = query === "" ? "" : `?${query}`;
  const response = await fetch(`${base}/api/fastbuyjson/orders/${encodeURIComponent(id)}${suffix}`, { headers });
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
  assert.equal(validateSchema("order-status.json", response.json), true);
  assertSafe(response.text);
  return response.json as OrderBody;
}

function assertNotFound(response: HttpResult): void {
  assertProblem(response, 404, "ORDER_NOT_FOUND");
  const body = response.json as ProblemBody;
  assert.equal(body.type, "https://fastbuyjson.org/problems/order-not-found");
  assert.equal(body.detail, "No order matches that id.");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("www-authenticate"), null);
}

function assertProblem(response: HttpResult, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.equal(validateSchema("error.json", response.json), true);
  const body = response.json as ProblemBody;
  assert.equal(body.status, status);
  assert.equal(body.code, code);
}

function assertSafe(text: string): void {
  assert.equal(text.toLowerCase().includes("gid://"), false);
  assert.equal(text.includes(ADMIN_TOKEN), false);
  assert.equal(text.includes(REFRESH_TOKEN), false);
  assert.equal(text.includes(CUSTOMER_ACCESS), false);
  assert.equal(text.includes(SUB_SECRET), false);
  assert.equal(text.includes(JWT_SECRET), false);
}

function validateSchema(name: string, body: unknown): boolean {
  const schema = JSON.parse(readFileSync(join(metadata.root, "schemas", name), "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormatsModule.default(ajv, ["date", "uri", "date-time", "email"]);
  const validate = ajv.compile(schema);
  const ok = validate(body);
  assert.deepEqual(validate.errors ?? [], []);
  return ok === true;
}
