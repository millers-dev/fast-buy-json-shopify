import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

import { SHOPIFY_API_VERSION } from "../src/api-version.js";
import { loadConfig, orderAddressGateEnabled, readPort } from "../src/config.js";
import type { ConnectorDeps } from "../src/deps.js";
import { applyOrderAddressGate } from "../src/index.js";
import { buildDetectResponse, type DetectResponse } from "../src/detect.js";
import {
  BASE_PATH,
  DEFAULT_PORT,
  DETECT_PATH,
  createConnectorServer,
  listen,
} from "../src/server.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SEED_MARKERS = [
  "freeShippingThreshold",
  "defaultRate",
  "SAVE10",
  "WELCOME5",
  "jurisdiction",
  "credit_card",
  "complete_checkout",
];

describe("buildDetectResponse", () => {
  it("advertises the v1 discover shape and refuses to create an order", () => {
    const body = buildDetectResponse({
      implementationVersion: "0.1.0",
      shopDomain: "Example.MyShopify.com",
    });

    assert.equal(body.standard, "FastBuyJSON");
    assert.equal(body.specVersion, "1.0.0");
    assert.equal(body.implementationVersion, "0.1.0");
    assert.deepEqual(body.supportedFeatures, [
      "anonymous_cart",
      "idempotency",
      "schema_validation",
      "pagination",
      "hosted_checkout",
    ]);
    assert.deepEqual(body.endpoints, ["products", "cart", "checkout", "orders"]);
    assert.deepEqual(body.authentication, { methods: ["anonymous"] });
    assert.equal(body.capabilities.checkout.confirmCreatesOrder, false);
    assert.deepEqual(body.capabilities, {
      tax: { mode: "shopify_estimated" },
      shipping: { source: "shopify_delivery_groups" },
      discounts: { stackable: false, maxCodes: 1 },
      checkout: { handoff: "shopify_hosted", confirmCreatesOrder: false },
    });
    assert.deepEqual(body.merchantInfo, {
      name: "example.myshopify.com",
      url: "https://example.myshopify.com",
    });
    assertSeedCatalogAbsent(body);
  });

  it("omits merchantInfo when no shop is configured", () => {
    const body = buildDetectResponse({ implementationVersion: "0.1.0" });
    assert.equal(body.merchantInfo, undefined);
    assert.equal(Object.hasOwn(body, "merchantInfo"), false);
  });

  it("uses the connector package version", () => {
    const body = buildDetectResponse({ implementationVersion: metadata.version });
    assert.equal(body.implementationVersion, metadata.version);
    assert.equal(metadata.version, "0.1.0");
  });
});

describe("config", () => {
  it("reads the shop domain and keeps secrets out of the detect body", () => {
    const config = loadConfig(
      {
        SHOPIFY_SHOP: " example.myshopify.com ",
        SHOPIFY_CLIENT_SECRET: "super-secret",
      },
      "0.1.0",
    );
    const body = buildDetectResponse(config);
    assert.equal(JSON.stringify(body).includes("super-secret"), false);
    assert.equal(body.merchantInfo?.url, "https://example.myshopify.com");
  });

  it("rejects a shop value that is not a bare domain", () => {
    assert.throws(() => loadConfig({ SHOPIFY_SHOP: "https://example.myshopify.com" }, "0.1.0"));
    assert.throws(() => loadConfig({ SHOPIFY_SHOP: "not a domain" }, "0.1.0"));
    assert.throws(() => buildDetectResponse({ implementationVersion: "0.1.0", shopDomain: "bad host" }));
  });

  it("turns the order address gate on only for 1 or true", () => {
    assert.equal(orderAddressGateEnabled(undefined), false);
    for (const value of ["", "   ", "0", "false", "FALSE", "off", "yes", "no", "2", "truee", " truee "]) {
      assert.equal(orderAddressGateEnabled(value), false, JSON.stringify(value));
    }
    for (const value of ["1", " 1 ", "true", "TRUE", " True "]) {
      assert.equal(orderAddressGateEnabled(value), true, JSON.stringify(value));
    }
  });

  it("boot copies SHOPIFY_ORDER_ADDRESS_GATE onto deps", () => {
    const deps = { orderAddressGate: true } as ConnectorDeps;
    applyOrderAddressGate(deps, {});
    assert.equal(deps.orderAddressGate, false);
    applyOrderAddressGate(deps, { SHOPIFY_ORDER_ADDRESS_GATE: "" });
    assert.equal(deps.orderAddressGate, false);
    applyOrderAddressGate(deps, { SHOPIFY_ORDER_ADDRESS_GATE: "off" });
    assert.equal(deps.orderAddressGate, false);
    applyOrderAddressGate(deps, { SHOPIFY_ORDER_ADDRESS_GATE: " true " });
    assert.equal(deps.orderAddressGate, true);
    applyOrderAddressGate(deps, { SHOPIFY_ORDER_ADDRESS_GATE: "1" });
    assert.equal(deps.orderAddressGate, true);
  });

  it("defaults the listen port to 3100", () => {
    assert.equal(DEFAULT_PORT, 3100);
    assert.equal(BASE_PATH, "/api/fastbuyjson");
    assert.equal(DETECT_PATH, "/api/fastbuyjson/detect");
    assert.equal(readPort({}, DEFAULT_PORT), 3100);
    assert.equal(readPort({ PORT: " 4310 " }, DEFAULT_PORT), 4310);
    assert.throws(() => readPort({ PORT: "nope" }, DEFAULT_PORT));
  });
});

describe("scaffold pins", () => {
  it("pins Shopify API 2026-10", () => {
    assert.equal(SHOPIFY_API_VERSION, "2026-10");
  });

  it("vendors FastBuyJSON schemas from tag 1.0.0", () => {
    const source = readFileSync(join(metadata.root, "schemas", "SOURCE"), "utf8");
    assert.match(source, /tag 1\.0\.0/);
    assert.match(source, /396846ef0cfc18fe8a12dc2e8a99245531fcda97/);
    const files = readdirSync(join(metadata.root, "schemas")).filter((name) => name.endsWith(".json"));
    assert.ok(files.includes("detect-response.json"));
    assert.ok(files.includes("product.json"));
    assert.ok(files.includes("error.json"));
    assert.equal(files.length, 30);
  });
});

describe("GET /api/fastbuyjson/detect", () => {
  let server: Server;
  let base: string;
  let shopifyFetches = 0;
  const originalFetch = globalThis.fetch;

  before(async () => {
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("http://127.0.0.1:")) {
        shopifyFetches += 1;
      }
      return originalFetch(input, init);
    };
    server = createConnectorServer({
      implementationVersion: metadata.version,
      shopDomain: "example.myshopify.com",
    });
    const port = await listen(server, 0, "127.0.0.1");
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns a schema-valid body and the public cache header", async () => {
    const response = await fetch(`${base}/api/fastbuyjson/detect`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);

    const body: unknown = await response.json();
    assert.equal(validateDetect(body), true);
    assert.equal(shopifyFetches, 0);
    const detect = body as DetectResponse;
    assert.equal(detect.capabilities.checkout.confirmCreatesOrder, false);
    assert.equal(detect.implementationVersion, metadata.version);
    assertSeedCatalogAbsent(detect);
  });

  it("ignores the query string and does not call Shopify", async () => {
    const response = await fetch(`${base}/api/fastbuyjson/detect?shop=other.myshopify.com`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as DetectResponse;
    assert.equal(body.merchantInfo?.url, "https://example.myshopify.com");
    assert.equal(shopifyFetches, 0);
  });

  it("answers only the detect route", async () => {
    const missing = await fetch(`${base}/api/fastbuyjson/cart`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");

    const method = await fetch(`${base}/api/fastbuyjson/detect`, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET");
  });
});

function assertSeedCatalogAbsent(body: DetectResponse): void {
  const encoded = JSON.stringify(body);
  for (const marker of SEED_MARKERS) {
    assert.equal(encoded.includes(marker), false, marker);
  }
  assert.equal(JSON.stringify(body.capabilities.shipping).includes("standard"), false);
  assert.equal(JSON.stringify(body.capabilities.shipping).includes("express"), false);
  assert.equal(body.capabilities.tax.mode, "shopify_estimated");
  const endpoints: readonly string[] = body.endpoints;
  assert.equal(endpoints.includes("orders"), true);
  assert.equal(endpoints.includes("auth"), false);
  assert.equal(Object.hasOwn(body, "auth"), false);
}

function validateDetect(body: unknown): boolean {
  const schema = JSON.parse(
    readFileSync(join(metadata.root, "schemas", "detect-response.json"), "utf8"),
  ) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  // The CJS build is a function whose `.default` is that same function. Node's
  // type view of the default import is the module namespace.
  const addFormats = addFormatsModule.default;
  addFormats(ajv, ["uri"]);
  const validate = ajv.compile(schema);
  const ok = validate(body);
  assert.deepEqual(validate.errors ?? [], []);
  return ok;
}
