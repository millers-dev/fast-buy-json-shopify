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
  CART_QUERY_DOCUMENT,
} from "../src/cart-query.js";
import {
  CART_BUYER_IDENTITY_UPDATE_DOCUMENT,
  CART_CHECKOUT_URL_DOCUMENT,
  CART_DELIVERY_ADDRESSES_REPLACE_DOCUMENT,
  CART_DELIVERY_GROUPS_DOCUMENT,
  CART_SELECTED_DELIVERY_OPTIONS_UPDATE_DOCUMENT,
} from "../src/checkout-query.js";
import type { ConnectorDeps } from "../src/deps.js";
import { CHECKOUT_CONFIRM_ROUTE, CHECKOUT_INITIATE_ROUTE } from "../src/idempotency.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { createConnectorServer, listen } from "../src/server.js";
import { SHOPIFY_BACKOFF_MS } from "../src/shopify-graphql.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const ADMIN_TOKEN = "shpat_checkout_admin_token";
const REFRESH_TOKEN = "shprt_checkout_refresh_token";
const DELEGATE_TOKEN = "shppa_delegate_checkout_test";
const FIXED_NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const SHOPIFY_CART_ID = "gid://shopify/Cart/c1?key=super-secret-cart-key";
const CART_SECRET = "super-secret-cart-key";
const LINE_GID = "gid://shopify/CartLine/line-a";
const VARIANT_GID = "gid://shopify/ProductVariant/2001";
const CHECKOUT_URL = "https://example.myshopify.com/cart/c/c1";
const GROUP_ID = "gid://shopify/CartDeliveryGroup/g1";
const STREET = "123 Main St";
const BILLING = "999 Billing Rd";
const EMAIL = "ada@example.com";
const PHONE = "+49 30 12345678";
const CARD = "4242424242424242";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GraphqlCall = {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

type ShopifyCart = {
  id: string;
  lines: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
  cost: {
    subtotalAmount: { amount: string; currencyCode: string };
    totalAmount: { amount: string; currencyCode: string };
    totalTaxAmount: { amount: string; currencyCode: string } | null;
    totalDutyAmount: null;
  };
  discountAllocations: unknown[];
};

type InitiateBody = {
  sessionToken: string;
  verificationToken: string;
  expiresAt: string;
  checkoutUrl: string;
  checkoutHandoff: string;
  cart: {
    id: string;
    items: { itemId: string; productId: string }[];
    extensions?: Record<string, unknown>;
  };
};

type ProblemBody = {
  type?: string;
  status: number;
  code: string;
  detail?: string;
  checkoutUrl?: string;
};

type HttpResult = { status: number; headers: Headers; json: unknown; text: string };

const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
let script: Array<() => Response> = [];

describe("checkout documents", () => {
  it("selects checkoutUrl only on the checkout query", () => {
    assert.equal(CART_CHECKOUT_URL_DOCUMENT.includes("checkoutUrl"), true);
    assert.equal(CART_CHECKOUT_URL_DOCUMENT.includes("deliveryGroups"), false);
    assert.equal(CART_CHECKOUT_URL_DOCUMENT.includes("lines("), false);
    for (const document of [
      CART_QUERY_DOCUMENT,
      CART_CREATE_DOCUMENT,
      CART_DISCOUNT_CODES_UPDATE_DOCUMENT,
      CART_BUYER_IDENTITY_UPDATE_DOCUMENT,
      CART_DELIVERY_ADDRESSES_REPLACE_DOCUMENT,
      CART_DELIVERY_GROUPS_DOCUMENT,
      CART_SELECTED_DELIVERY_OPTIONS_UPDATE_DOCUMENT,
    ]) {
      assert.equal(document.includes("checkoutUrl"), false);
    }
    assert.equal(CART_BUYER_IDENTITY_UPDATE_DOCUMENT.includes("cartBuyerIdentityUpdate"), true);
    assert.equal(CART_DELIVERY_ADDRESSES_REPLACE_DOCUMENT.includes("cartDeliveryAddressesReplace"), true);
    assert.equal(CART_SELECTED_DELIVERY_OPTIONS_UPDATE_DOCUMENT.includes("cartSelectedDeliveryOptionsUpdate"), true);
    assert.equal(CHECKOUT_INITIATE_ROUTE, "/checkout/initiate");
    assert.equal(CHECKOUT_CONFIRM_ROUTE, "/checkout/confirm");
  });
});

describe("hosted Shopify checkout", { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let tokens: TokenStore;
  let file: string;
  let now = FIXED_NOW;
  const sleepDelays: number[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;

  before(async () => {
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
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

  it("returns checkoutUrl for the process cart and refuses payment without calling Shopify", async () => {
    const created = await addDefault();
    calls.length = 0;
    pushHandoff({ discount: true, groups: true, select: true });
    const body = initiateBody(created.cart.id, {
      discountCode: "  Save10  ",
      shippingOptionId: "shop-express",
      extensions: { note: "gift" },
    });
    const response = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", body, {
      Authorization: "Bearer not-a-commerce-token",
      "Idempotency-Key": "initiate-1",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("idempotency-replayed"), null);
    assert.equal(validateSchema("checkout-initiate-response.json", response.json), true);
    const initiated = response.json as InitiateBody;
    assert.equal(initiated.checkoutUrl, CHECKOUT_URL);
    assert.equal(initiated.checkoutUrl.startsWith("https://"), true);
    assert.equal(initiated.checkoutHandoff, "shopify_hosted");
    assert.match(initiated.sessionToken, UUID);
    assert.match(initiated.verificationToken, UUID);
    assert.notEqual(initiated.sessionToken, initiated.verificationToken);
    assert.equal(initiated.sessionToken.includes("gid://"), false);
    assert.equal(initiated.expiresAt, new Date(FIXED_NOW + HOUR_MS).toISOString());
    assert.equal(initiated.cart.id, created.cart.id);
    assert.equal(initiated.cart.items[0]?.productId, VARIANT_GID);
    assert.match(initiated.cart.items[0]?.itemId ?? "", UUID);
    assert.deepEqual(initiated.cart.extensions, { note: "gift" });
    assertClean(response.text);
    assert.equal(response.text.includes(EMAIL), false);
    assert.equal(response.text.includes(STREET), false);
    assert.equal(response.text.includes(BILLING), false);

    assert.equal(calls.length, 7);
    const identity = graphqlCall(calls, 0);
    expectStorefront(identity);
    assert.equal(identity.query.includes("cartBuyerIdentityUpdate"), true);
    assert.equal(identity.query.includes("checkoutUrl"), false);
    assert.deepEqual(identity.variables, {
      cartId: SHOPIFY_CART_ID,
      buyerIdentity: { email: EMAIL, phone: PHONE, countryCode: "DE" },
    });
    const address = graphqlCall(calls, 1);
    assert.equal(address.query.includes("cartDeliveryAddressesReplace"), true);
    assert.equal(address.query.includes("checkoutUrl"), false);
    assert.deepEqual(address.variables, {
      cartId: SHOPIFY_CART_ID,
      addresses: [
        {
          selected: true,
          address: {
            deliveryAddress: {
              address1: STREET,
              address2: "Apt 4B",
              city: "Berlin",
              countryCode: "DE",
              zip: "10115",
              phone: PHONE,
              provinceCode: "BE",
              firstName: "Ada",
              lastName: "Lovelace",
            },
          },
        },
      ],
    });
    assert.equal(JSON.stringify(address.variables).includes(BILLING), false);
    const discount = graphqlCall(calls, 2);
    assert.equal(discount.query.includes("cartDiscountCodesUpdate"), true);
    assert.deepEqual(discount.variables.discountCodes, ["Save10"]);
    const groups = graphqlCall(calls, 3);
    assert.equal(groups.query.includes("deliveryGroups"), true);
    assert.equal(groups.query.includes("checkoutUrl"), false);
    const selected = graphqlCall(calls, 4);
    assert.equal(selected.query.includes("cartSelectedDeliveryOptionsUpdate"), true);
    assert.equal(selected.query.includes("complete_checkout"), false);
    assert.deepEqual(selected.variables, {
      cartId: SHOPIFY_CART_ID,
      selectedDeliveryOptions: [{ deliveryGroupId: GROUP_ID, deliveryOptionHandle: "shop-express" }],
    });
    const snapshot = graphqlCall(calls, 5);
    assert.equal(snapshot.query.includes("checkoutUrl"), false);
    assert.equal(snapshot.query, CART_QUERY_DOCUMENT);
    const urlCall = graphqlCall(calls, 6);
    assert.equal(urlCall.query, CART_CHECKOUT_URL_DOCUMENT);
    assert.deepEqual(urlCall.variables, { id: SHOPIFY_CART_ID });
    for (const call of calls) {
      assert.equal(call.body.includes("complete_checkout"), false);
      assert.equal(call.body.includes(CARD), false);
      assert.equal(call.body.includes("paymentDetails"), false);
    }

    const stored = tokens.getCheckoutSession(SHOP, initiated.sessionToken);
    assert.equal(stored?.checkoutUrl, CHECKOUT_URL);
    assert.equal(stored?.verificationToken, initiated.verificationToken);
    assert.equal(stored?.expiresAt, FIXED_NOW + HOUR_MS);
    assert.equal(stored?.cartId, created.cart.id);
    assertPlaintextAbsent(file, [STREET, BILLING, EMAIL, PHONE, CART_SECRET, SHOPIFY_CART_ID, LINE_GID]);
    assert.equal(readFileSync(file).includes(initiated.sessionToken), true);

    calls.length = 0;
    script.push(() => jsonResponse(200, queryResponse(snapshotCart())));
    const cart = await request(base, "GET", "/api/fastbuyjson/cart");
    assert.equal(cart.status, 200);
    assert.equal(cart.text.includes("checkoutUrl"), false);
    assert.equal(cart.text.includes("key="), false);
    assert.equal(cart.text.includes(CHECKOUT_URL), false);
    assert.deepEqual((cart.json as { cart: { extensions?: unknown } }).cart.extensions, { note: "gift" });
    assert.equal(calls.length, 1);
    assert.equal(graphqlCall(calls, 0).query.includes("checkoutUrl"), false);

    calls.length = 0;
    const replay = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", body, {
      "Idempotency-Key": "initiate-1",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.text, response.text);
    assert.equal(calls.length, 0);

    const conflict = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/initiate",
      initiateBody(created.cart.id, { discountCode: "Welcome5" }),
      { "Idempotency-Key": "initiate-1" },
    );
    assertProblem(conflict, 409, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal(calls.length, 0);

    calls.length = 0;
    const confirmBody = confirmPayload(initiated.sessionToken, initiated.verificationToken);
    const confirmed = await request(base, "POST", "/api/fastbuyjson/checkout/confirm", confirmBody, {
      "Idempotency-Key": "confirm-1",
    });
    assertProblem(confirmed, 400, "PAYMENT_METHOD_UNSUPPORTED");
    assert.equal(confirmed.headers.get("idempotency-replayed"), null);
    assert.equal(confirmed.headers.get("content-type"), "application/problem+json; charset=utf-8");
    const problem = confirmed.json as ProblemBody;
    assert.equal(problem.type, "https://fastbuyjson.org/problems/payment-method-unsupported");
    assert.equal(problem.detail?.includes("checkoutUrl"), true);
    assert.equal(problem.checkoutUrl, CHECKOUT_URL);
    assert.equal(calls.length, 0);
    assert.equal(confirmed.text.includes(CARD), false);
    assert.equal(confirmed.text.includes("complete_checkout"), false);
    assert.equal(logs.join("\n").includes(CHECKOUT_URL), false);
    assert.equal(logs.join("\n").includes(initiated.sessionToken), false);
    assert.equal(logs.join("\n").includes(CARD), false);
    assert.equal(logs.join("\n").includes("key="), false);
    assert.equal(readFileSync(file).includes(CARD), false);

    const again = await request(base, "POST", "/api/fastbuyjson/checkout/confirm", confirmBody, {
      "Idempotency-Key": "confirm-1",
    });
    assertProblem(again, 400, "PAYMENT_METHOD_UNSUPPORTED");
    assert.equal(again.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 0);

    const sameKey = await request(base, "POST", "/api/fastbuyjson/checkout/confirm", confirmBody, {
      "Idempotency-Key": "initiate-1",
    });
    assertProblem(sameKey, 409, "IDEMPOTENCY_KEY_CONFLICT");

    tokens.deleteShop(SHOP);
    assert.equal(tokens.getCheckoutSession(SHOP, initiated.sessionToken), null);
    const afterDelete = await request(base, "POST", "/api/fastbuyjson/checkout/confirm", confirmBody);
    assertProblem(afterDelete, 400, "INVALID_CHECKOUT_SESSION");
    assert.equal(afterDelete.text.includes("checkoutUrl"), false);
  });

  it("maps region or state, skips blank discounts, and still returns checkoutUrl", async () => {
    const created = await addDefault();
    calls.length = 0;
    pushHandoff({ discount: false, groups: false, select: false });
    const stateOnly = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/initiate",
      {
        cartId: created.cart.id,
        customerInfo: { email: EMAIL, phoneNumber: PHONE, firstName: "Ada" },
        shippingAddress: {
          line1: STREET,
          city: "Berlin",
          state: "BE",
          country: "DE",
          postalCode: "10115",
        },
        billingAddress: { line1: BILLING, city: "Hamburg", country: "DE", postalCode: "20095" },
        discountCode: "   ",
      },
    );
    assert.equal(stateOnly.status, 200);
    assert.equal((stateOnly.json as InitiateBody).checkoutUrl, CHECKOUT_URL);
    assert.equal(calls.length, 4);
    const address = graphqlCall(calls, 1);
    const delivery = (address.variables.addresses as { address: { deliveryAddress: { provinceCode?: string } } }[])[0]
      ?.address.deliveryAddress;
    assert.equal(delivery?.provinceCode, "BE");
    assert.deepEqual(graphqlCall(calls, 0).variables.buyerIdentity, {
      email: EMAIL,
      phone: PHONE,
      countryCode: "DE",
    });
    assert.equal(calls.some((call) => call.body.includes("cartDiscountCodesUpdate")), false);
    assert.equal(calls.some((call) => call.body.includes("deliveryGroups")), false);
    assert.equal(JSON.stringify(address.variables).includes(BILLING), false);

    calls.length = 0;
    pushHandoff({ discount: false, groups: true, select: false });
    const unmatched = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/initiate",
      initiateBody(created.cart.id, { shippingOptionId: "standard", discountCode: null }),
    );
    assert.equal(unmatched.status, 200);
    assert.equal((unmatched.json as InitiateBody).checkoutHandoff, "shopify_hosted");
    assert.equal(calls.some((call) => call.body.includes("cartDiscountCodesUpdate")), false);
    assert.equal(calls.some((call) => call.body.includes("cartSelectedDeliveryOptionsUpdate")), false);
    assert.equal(calls.some((call) => call.body.includes("deliveryGroups")), true);
    assert.equal((unmatched.json as InitiateBody).checkoutUrl, CHECKOUT_URL);
    const session = tokens.getCheckoutSession(SHOP, (stateOnly.json as InitiateBody).sessionToken);
    assert.equal(session, null);
    const live = tokens.getCheckoutSession(SHOP, (unmatched.json as InitiateBody).sessionToken);
    assert.equal(live?.checkoutUrl, CHECKOUT_URL);
    assertPlaintextAbsent(file, [CHECKOUT_URL, STREET, BILLING, EMAIL, PHONE, CART_SECRET, SHOPIFY_CART_ID, LINE_GID]);
    assert.equal(readFileSync(file).includes((unmatched.json as InitiateBody).sessionToken), true);
  });

  it("rejects an unknown or empty cart before Shopify, and a bad checkout URL stores nothing", async () => {
    const missing = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody("11111111-1111-4111-8111-111111111111"));
    assertProblem(missing, 404, "CART_NOT_FOUND");
    assert.equal(calls.length, 0);
    assert.equal(tokens.getCheckoutSession(SHOP, "11111111-1111-4111-8111-111111111111"), null);

    const created = await addDefault();
    calls.length = 0;
    const other = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody("22222222-2222-4222-8222-222222222222"));
    assertProblem(other, 404, "CART_NOT_FOUND");
    assert.equal((other.json as ProblemBody).detail, "No cart with id 22222222-2222-4222-8222-222222222222");
    assert.equal(calls.length, 0);

    calls.length = 0;
    script.push(() => jsonResponse(200, mutationResponse("cartLinesRemove", emptyCart(snapshotCart()))));
    const cleared = await request(base, "DELETE", "/api/fastbuyjson/cart");
    assert.equal(cleared.status, 200);
    calls.length = 0;
    const empty = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(created.cart.id), {
      "Idempotency-Key": "empty-cart",
    });
    assertProblem(empty, 400, "VALIDATION_ERROR");
    assert.equal((empty.json as ProblemBody).detail, "The cart is empty.");
    assert.equal(calls.length, 0);
    assert.equal(tokens.lookupIdempotency("anonymous", "empty-cart", "unused", now).kind, "miss");

    tokens.clearAnonymousCart();
    const refilled = await addDefault();
    calls.length = 0;
    pushHandoff({ discount: false, groups: false, select: false, checkoutUrl: "http://example.myshopify.com/cart/c/c1" });
    const insecure = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(refilled.cart.id), {
      "Idempotency-Key": "bad-url",
    });
    assertProblem(insecure, 500, "INTERNAL_ERROR");
    assert.equal(insecure.text.includes("checkoutUrl"), false);
    assert.equal(insecure.text.includes("http://"), false);
    assert.equal(tokens.getCheckoutSession(SHOP, "unused"), null);
    assert.equal(tokens.lookupIdempotency("anonymous", "bad-url", "unused", now).kind, "miss");

    calls.length = 0;
    pushHandoff({ discount: false, groups: false, select: false, checkoutUrl: null });
    const absent = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(refilled.cart.id));
    assertProblem(absent, 500, "INTERNAL_ERROR");
    assert.equal(tokens.getCheckoutSession(SHOP, "unused"), null);
  });

  it("maps identity, address, and delivery userErrors to 400 and an inapplicable code to 422", async () => {
    const created = await addDefault();
    calls.length = 0;
    script.push(() =>
      jsonResponse(200, {
        data: {
          cartBuyerIdentityUpdate: {
            cart: null,
            userErrors: [{ field: ["buyerIdentity", "email"], message: `rejected ${SHOPIFY_CART_ID}`, code: "INVALID" }],
          },
        },
      }),
    );
    const identity = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(created.cart.id));
    assertProblem(identity, 400, "VALIDATION_ERROR");
    assert.equal((identity.json as ProblemBody).detail, "Shopify rejected the checkout change.");
    assertClean(identity.text);
    assert.equal(calls.length, 1);
    assert.equal(tokens.getCheckoutSession(SHOP, "unused"), null);

    calls.length = 0;
    script.push(() => jsonResponse(200, ack("cartBuyerIdentityUpdate")));
    script.push(() =>
      jsonResponse(200, {
        data: {
          cartDeliveryAddressesReplace: {
            cart: { totalQuantity: 1 },
            userErrors: [{ field: ["addresses", "0", "address1"], message: "Address is incomplete", code: "INVALID" }],
          },
        },
      }),
    );
    const address = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(created.cart.id, { discountCode: "Save10" }));
    assertProblem(address, 400, "VALIDATION_ERROR");
    assert.equal((address.json as ProblemBody).detail, "Address is incomplete");
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.body.includes("cartDiscountCodesUpdate")), false);

    calls.length = 0;
    script.push(() => jsonResponse(200, ack("cartBuyerIdentityUpdate")));
    script.push(() => jsonResponse(200, ack("cartDeliveryAddressesReplace")));
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [{ code: "NOPE", applicable: false }])));
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [])));
    const rejected = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/initiate",
      initiateBody(created.cart.id, { discountCode: "NOPE", shippingOptionId: "shop-express" }),
    );
    assertProblem(rejected, 422, "INVALID_DISCOUNT_CODE");
    assert.equal(rejected.text.includes("checkoutUrl"), false);
    assert.equal(calls.length, 4);
    assert.deepEqual(graphqlCall(calls, 2).variables.discountCodes, ["NOPE"]);
    assert.deepEqual(graphqlCall(calls, 3).variables.discountCodes, []);
    assert.equal(calls.some((call) => call.body.includes("CartCheckoutUrl")), false);
    assert.equal(tokens.getCheckoutSession(SHOP, "unused"), null);

    calls.length = 0;
    script.push(() => jsonResponse(200, ack("cartBuyerIdentityUpdate")));
    script.push(() => jsonResponse(200, ack("cartDeliveryAddressesReplace")));
    script.push(() => jsonResponse(200, loadFixture("checkout-delivery-groups.json")));
    script.push(() =>
      jsonResponse(200, {
        data: {
          cartSelectedDeliveryOptionsUpdate: {
            cart: { totalQuantity: 1 },
            userErrors: [{ field: ["selectedDeliveryOptions"], message: "Option is unavailable", code: "INVALID" }],
          },
        },
      }),
    );
    const delivery = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/initiate",
      initiateBody(created.cart.id, { shippingOptionId: "shop-express" }),
    );
    assertProblem(delivery, 400, "VALIDATION_ERROR");
    assert.equal(delivery.text.includes("checkoutUrl"), false);
    assert.equal(calls.length, 4);
    assert.equal(tokens.getCheckoutSession(SHOP, "unused"), null);
  });

  it("checks confirm in order and throttles initiate once", async () => {
    const created = await addDefault();
    calls.length = 0;
    pushHandoff({ discount: false, groups: false, select: false });
    const initiated = assertInitiate(
      await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(created.cart.id), {
        "Idempotency-Key": "session-key",
      }),
    );
    calls.length = 0;

    const badMethod = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/confirm",
      {
        sessionToken: initiated.sessionToken,
        paymentDetails: {
          method: "cash_on_delivery",
          transactionVerification: { verificationMethod: "captcha", verificationToken: initiated.verificationToken },
          cardDetails: { cardNumber: CARD },
        },
      },
      { "Idempotency-Key": "session-key" },
    );
    assertProblem(badMethod, 400, "VALIDATION_ERROR");
    assert.notEqual((badMethod.json as ProblemBody).code, "PAYMENT_METHOD_UNSUPPORTED");
    assert.equal(badMethod.text.includes("checkoutUrl"), false);
    assert.equal(calls.length, 0);

    const unknown = await request(base, "POST", "/api/fastbuyjson/checkout/confirm", confirmPayload("33333333-3333-4333-8333-333333333333", initiated.verificationToken));
    assertProblem(unknown, 400, "INVALID_CHECKOUT_SESSION");
    assert.equal(unknown.text.includes("checkoutUrl"), false);
    assert.equal((unknown.json as ProblemBody).checkoutUrl, undefined);

    now = FIXED_NOW + HOUR_MS + 1;
    const expired = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/confirm",
      confirmPayload(initiated.sessionToken, "wrong-verification-token"),
    );
    assertProblem(expired, 400, "CHECKOUT_SESSION_EXPIRED");
    assert.equal(expired.text.includes(CHECKOUT_URL), false);
    assert.equal((expired.json as ProblemBody).checkoutUrl, undefined);

    now = FIXED_NOW + HOUR_MS;
    const boundary = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/confirm",
      confirmPayload(initiated.sessionToken, "wrong-verification-token"),
    );
    assertProblem(boundary, 400, "INVALID_VERIFICATION_TOKEN");
    assert.equal(boundary.text.includes(CHECKOUT_URL), false);

    now = FIXED_NOW;
    const mismatch = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/confirm",
      confirmPayload(initiated.sessionToken, "wrong-verification-token"),
      { "Idempotency-Key": "bad-verify" },
    );
    assertProblem(mismatch, 400, "INVALID_VERIFICATION_TOKEN");
    assert.equal(mismatch.headers.get("idempotency-replayed"), null);
    const retryVerify = await request(
      base,
      "POST",
      "/api/fastbuyjson/checkout/confirm",
      confirmPayload(initiated.sessionToken, initiated.verificationToken),
      { "Idempotency-Key": "bad-verify" },
    );
    assertProblem(retryVerify, 400, "PAYMENT_METHOD_UNSUPPORTED");
    assert.equal((retryVerify.json as ProblemBody).checkoutUrl, CHECKOUT_URL);
    assert.equal(retryVerify.headers.get("idempotency-replayed"), null);
    assert.equal(calls.length, 0);
    assert.equal(logs.join("\n").includes(CARD), false);

    calls.length = 0;
    sleepDelays.length = 0;
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    script.push(() => jsonResponse(200, loadFixture("throttled.json")));
    const limited = await request(base, "POST", "/api/fastbuyjson/checkout/initiate", initiateBody(created.cart.id), {
      "Idempotency-Key": "throttled-initiate",
    });
    assertProblem(limited, 429, "RATE_LIMITED");
    assert.equal((limited.json as ProblemBody).detail, "Shopify throttled the checkout request.");
    assert.deepEqual(sleepDelays, [SHOPIFY_BACKOFF_MS]);
    assert.equal(calls.length, 2);
    assert.equal(limited.headers.get("idempotency-replayed"), null);
    assert.equal(tokens.lookupIdempotency("anonymous", "throttled-initiate", "unused", now).kind, "miss");

    const method = await request(base, "GET", "/api/fastbuyjson/checkout/initiate");
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");
    const orders = await request(base, "GET", "/api/fastbuyjson/orders/ord-1");
    assert.equal(orders.status, 404);
  });

  async function addDefault(): Promise<{ cart: { id: string } } & HttpResult> {
    pushVariant(VARIANT_GID);
    script.push(() => jsonResponse(200, loadFixture("cart-snapshot.json")));
    return assertCart(await request(base, "POST", "/api/fastbuyjson/cart/add", { productId: VARIANT_GID, quantity: 1 }));
  }
});

function initiateBody(cartId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cartId,
    customerInfo: { email: EMAIL, phone: PHONE, firstName: "Ada", lastName: "Lovelace" },
    shippingAddress: {
      line1: STREET,
      line2: "Apt 4B",
      city: "Berlin",
      region: "BE",
      state: "IGNORED",
      country: "DE",
      postalCode: "10115",
    },
    billingAddress: { line1: BILLING, city: "Hamburg", region: "HH", country: "DE", postalCode: "20095" },
    ...extra,
  };
}

function confirmPayload(sessionToken: string, verificationToken: string): Record<string, unknown> {
  return {
    sessionToken,
    paymentDetails: {
      method: "credit_card",
      transactionVerification: {
        verificationMethod: "captcha",
        verificationToken,
      },
      cardDetails: { lastFourDigits: "4242", brand: "Visa", cardNumber: CARD },
      externalPaymentId: "py_should_not_leave_the_process",
    },
  };
}

function pushHandoff(options: { discount: boolean; groups: boolean; select: boolean; checkoutUrl?: string | null }): void {
  script.push(() => jsonResponse(200, ack("cartBuyerIdentityUpdate")));
  script.push(() => jsonResponse(200, ack("cartDeliveryAddressesReplace")));
  if (options.discount) {
    script.push(() => jsonResponse(200, discountResponse(snapshotCart(), [{ code: "Save10", applicable: true }])));
  }
  if (options.groups) {
    script.push(() => jsonResponse(200, loadFixture("checkout-delivery-groups.json")));
  }
  if (options.select) {
    script.push(() => jsonResponse(200, ack("cartSelectedDeliveryOptionsUpdate")));
  }
  script.push(() => jsonResponse(200, queryResponse(snapshotCart())));
  if (options.checkoutUrl === undefined) {
    script.push(() => jsonResponse(200, loadFixture("checkout-url.json")));
    return;
  }
  script.push(() => jsonResponse(200, { data: { cart: { checkoutUrl: options.checkoutUrl } } }));
}

function pushVariant(id: string): void {
  script.push(() => jsonResponse(200, { data: { node: { __typename: "ProductVariant", id } } }));
}

function ack(operation: string): unknown {
  return { data: { [operation]: { cart: { totalQuantity: 1 }, userErrors: [] } } };
}

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
  next.discountAllocations = [];
  return next;
}

function discountResponse(cart: ShopifyCart, discountCodes: { code: string; applicable: boolean }[]): unknown {
  return { data: { cartDiscountCodesUpdate: { cart: { ...cart, discountCodes }, userErrors: [] } } };
}

function mutationResponse(operation: string, cart: ShopifyCart): unknown {
  return { data: { [operation]: { cart, userErrors: [] } } };
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
  return join(mkdtempSync(join(tmpdir(), "fastbuyjson-checkout-")), "tokens.sqlite");
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

function graphqlCall(calls: { url: string; body: string; headers: Record<string, string> }[], index: number): GraphqlCall {
  const call = calls[index];
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

function assertCart(response: HttpResult): { cart: { id: string } } & HttpResult {
  assert.equal(response.status, 200);
  assertClean(response.text);
  const body = response.json as { cart: { id: string } };
  return { ...response, cart: body.cart };
}

function assertInitiate(response: HttpResult): InitiateBody {
  assert.equal(response.status, 200);
  assertClean(response.text);
  return response.json as InitiateBody;
}

function assertProblem(response: HttpResult, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.equal(validateSchema("error.json", response.json), true);
  const body = response.json as ProblemBody;
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assert.equal(response.text.includes("key="), false);
  assert.equal(response.text.includes(SHOPIFY_CART_ID), false);
  assert.equal(response.text.includes(LINE_GID), false);
}

function assertClean(text: string): void {
  assert.equal(text.includes("key="), false);
  assert.equal(text.includes(SHOPIFY_CART_ID), false);
  assert.equal(text.includes(LINE_GID), false);
  assert.equal(text.includes(CART_SECRET), false);
  assert.equal(text.includes(DELEGATE_TOKEN), false);
  assert.equal(text.includes(ADMIN_TOKEN), false);
}

function assertPlaintextAbsent(file: string, secrets: string[]): void {
  const bytes = readFileSync(file);
  for (const secret of secrets) {
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
