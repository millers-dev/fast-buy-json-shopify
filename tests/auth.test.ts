import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

import { SHOPIFY_API_VERSION } from "../src/api-version.js";
import { ensureClientCredentials, prepareCommerceAccess } from "../src/commerce-token.js";
import { loadShopifyAuth, type ShopifyAuthConfig } from "../src/config.js";
import type { ConnectorDeps } from "../src/deps.js";
import { buildDetectResponse } from "../src/detect.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { DECRYPT_DETAIL, ONE_SHOP_DETAIL, REINSTALL_DETAIL } from "../src/problems.js";
import { SHOPIFY_SCOPE_PARAM, SHOPIFY_SCOPES, STOREFRONT_SCOPES, hasRequiredScopes } from "../src/scopes.js";
import { signOauthParams, signWebhookBody } from "../src/shopify-hmac.js";
import { createConnectorServer, listen } from "../src/server.js";
import { openConnector } from "../src/startup.js";
import { OneShopError, TokenDecryptError, TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const OTHER_SHOP = "other.myshopify.com";
const APP_URL = "https://app.example.com";
const CLIENT_ID = "dev-dashboard-client-id";
const CLIENT_SECRET = "shpss_test_client_secret_44cd";
const ACCESS_TOKEN = "shpat_test_access_token_9f3c";
const REFRESH_TOKEN = "shprt_test_refresh_token_11ab";
const AUTH_CODE = "code_test_authorization_88ee";
const UPSTREAM_LEAK = "shpat_upstream_body_must_not_leak";
const REFRESHED_ACCESS = "shpat_refreshed_access_token_77aa";
const REFRESHED_REFRESH = "shprt_refreshed_refresh_token_77aa";
const OFFLINE_ACCESS = "shpat_non_expiring_offline_token";
const CUSTOMER_EMAIL = "buyer-archive@example.com";
const FIXED_NOW = 1_700_000_000_000;
const SECRETS = [
  CLIENT_SECRET,
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  AUTH_CODE,
  UPSTREAM_LEAK,
  CUSTOMER_EMAIL,
  REFRESHED_ACCESS,
  REFRESHED_REFRESH,
  OFFLINE_ACCESS,
];

const logLines: string[] = [];
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

before(() => {
  const record = (...args: unknown[]) => {
    logLines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  console.debug = record;
});

after(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
  const logs = logLines.join("\n");
  for (const secret of SECRETS) {
    assert.equal(logs.includes(secret), false, secret);
  }
});

describe("auth configuration", () => {
  it("keeps detect-only configuration when no OAuth values are set", () => {
    assert.equal(loadShopifyAuth({ SHOPIFY_SHOP: SHOP, PORT: "3100" }), undefined);
    assert.equal(loadShopifyAuth({ SHOPIFY_API_VERSION: SHOPIFY_API_VERSION }), undefined);
  });

  it("rejects a partial credential set without echoing the secret", () => {
    assert.throws(
      () => loadShopifyAuth({ SHOPIFY_CLIENT_SECRET: CLIENT_SECRET, SHOPIFY_SHOP: SHOP }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : "";
        assert.equal(message.includes(CLIENT_SECRET), false);
        return true;
      },
    );
  });

  it("rejects an http callback origin and a drifted API version", () => {
    const base = {
      SHOPIFY_SHOP: SHOP,
      SHOPIFY_CLIENT_ID: CLIENT_ID,
      SHOPIFY_CLIENT_SECRET: CLIENT_SECRET,
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    assert.throws(() => loadShopifyAuth({ ...base, APP_URL: "http://localhost:3100" }));
    assert.throws(() => loadShopifyAuth({ SHOPIFY_API_VERSION: "2025-01" }));
    const auth = loadShopifyAuth({ ...base, APP_URL: `${APP_URL}/` });
    assert.equal(auth?.appUrl, APP_URL);
    assert.equal(auth?.apiVersion, "2026-10");
  });
});

describe("one-shop token store", () => {
  it("encrypts the token, refuses a second shop, and omits the plaintext from the file", async () => {
    const { store, file, key } = await openStore();
    store.save(sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN), FIXED_NOW);
    assert.equal(store.get()?.accessToken, ACCESS_TOKEN);
    assert.equal(store.get()?.refreshToken, REFRESH_TOKEN);
    assert.equal(store.get()?.shopDomain, SHOP);
    assertPlaintextAbsent(file);

    assert.throws(() => store.save(sampleToken(OTHER_SHOP, "shpat_other_shop_token", null), FIXED_NOW), OneShopError);
    assert.equal(store.get()?.shopDomain, SHOP);
    assert.equal(store.get()?.accessToken, ACCESS_TOKEN);
    assert.equal(readFileSync(file).includes("shpat_other_shop_token"), false);

    store.save(sampleToken(SHOP, "shpat_reinstall_same_shop", REFRESH_TOKEN), FIXED_NOW + 1);
    assert.equal(store.get()?.accessToken, "shpat_reinstall_same_shop");
    assert.equal(store.get()?.shopDomain, SHOP);
    store.close();

    const reopened = await TokenStore.open(file, key);
    assert.equal(reopened.get()?.shopDomain, SHOP);
    reopened.close();

    const wrongKey = await TokenStore.open(file, randomBytes(32));
    assert.throws(() => wrongKey.get(), TokenDecryptError);
    wrongKey.close();
  });
});

describe("OAuth and webhooks", () => {
  it("requests the four unauthenticated scopes plus read_orders and does not log the code or token", async () => {
    await withHarness(async (harness) => {
    const started = await send(harness.base, "/api/shopify/auth");
    assert.equal(started.status, 302);
    const location = new URL(header(started.headers, "location") ?? "");
    assert.equal(location.origin, `https://${SHOP}`);
    assert.equal(location.pathname, "/admin/oauth/authorize");
    assert.deepEqual(location.searchParams.get("scope")?.split(",").sort(), [...SHOPIFY_SCOPES].sort());
    assert.equal(location.searchParams.get("scope"), SHOPIFY_SCOPE_PARAM);
    assert.deepEqual(STOREFRONT_SCOPES, [
      "unauthenticated_read_product_listings",
      "unauthenticated_read_product_inventory",
      "unauthenticated_read_checkouts",
      "unauthenticated_write_checkouts",
    ]);
    const requested = SHOPIFY_SCOPE_PARAM.split(",");
    assert.equal(requested.includes("read_orders"), true);
    assert.equal(requested.includes("write_orders"), false);
    assert.equal(requested.includes("read_all_orders"), false);
    assert.equal(hasRequiredScopes(STOREFRONT_SCOPES.join(",")), true);
    assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(location.searchParams.get("redirect_uri"), `${APP_URL}/api/shopify/auth/callback`);
    assert.equal(location.searchParams.get("client_secret"), null);
    assert.equal(started.text.includes(CLIENT_SECRET), false);
    const state = location.searchParams.get("state");
    assert.equal(typeof state, "string");

    harness.script.push(() =>
      jsonResponse(200, {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scope: SHOPIFY_SCOPE_PARAM,
      }),
    );
    const callback = await send(harness.base, callbackPath({ code: AUTH_CODE, shop: SHOP, state: state ?? "", timestamp: "1" }));
    assert.equal(callback.status, 200);
    assert.equal(callback.text.includes(ACCESS_TOKEN), false);
    assert.equal(callback.text.includes(REFRESH_TOKEN), false);
    assert.equal(callback.text.includes(CLIENT_SECRET), false);
    assert.equal(callback.text.includes(AUTH_CODE), false);
    assert.deepEqual(JSON.parse(callback.text), { installed: true, shop: SHOP });
    assert.equal(harness.calls.length, 1);
    const body = new URLSearchParams(harness.calls[0]?.body);
    assert.equal(body.get("expiring"), "1");
    assert.equal(body.get("code"), AUTH_CODE);
    assert.equal(harness.calls[0]?.url, `https://${SHOP}/admin/oauth/access_token`);
    const stored = harness.tokens.get();
    assert.equal(stored?.grantType, "authorization_code");
    assert.equal(stored?.accessToken, ACCESS_TOKEN);
    assert.equal(stored?.accessExpiresAt, FIXED_NOW + 3_600_000);
    assertPlaintextAbsent(harness.file);

    const detect = await send(harness.base, "/api/fastbuyjson/detect");
    assert.equal(detect.status, 200);
    assert.equal(detect.headers["cache-control"], "public, max-age=300");
    const detectBody = JSON.parse(detect.text) as ReturnType<typeof buildDetectResponse>;
    assert.equal(detectBody.capabilities.checkout.confirmCreatesOrder, false);
    assert.equal(detect.text.includes(ACCESS_TOKEN), false);
    assert.equal(harness.calls.length, 1);

    const cart = await send(harness.base, "/api/fastbuyjson/cart", { method: "POST" });
    assert.equal(cart.status, 404);
    assert.equal(harness.calls.length, 1);
    });
  });

  it("stores nothing when hmac, state, shop, or the token exchange fails", async () => {
    await withHarness(async (harness) => {
    const state = await installState(harness);

    const badHmac = await send(
      harness.base,
      callbackPath({ code: AUTH_CODE, shop: SHOP, state, timestamp: "1", hmac: "0".repeat(64) }),
    );
    assert.equal(badHmac.status, 401);
    assert.equal(harness.tokens.get(), null);
    assert.equal(harness.calls.length, 0);
    assert.equal(badHmac.text.includes(AUTH_CODE), false);

    const badState = await send(harness.base, callbackPath({ code: AUTH_CODE, shop: SHOP, state: "not-the-state", timestamp: "1" }));
    assert.equal(badState.status, 400);
    assert.equal(harness.tokens.get(), null);
    assert.equal(harness.calls.length, 0);

    const foreign = await send(harness.base, callbackPath({ code: AUTH_CODE, shop: OTHER_SHOP, state, timestamp: "1" }));
    assert.equal(foreign.status, 400);
    assert.equal(harness.tokens.get(), null);
    assert.equal(harness.calls.length, 0);
    assertPlaintextAbsent(harness.file);

    harness.script.push(() => jsonResponse(401, { error: "invalid_request", access_token: UPSTREAM_LEAK }));
    const failed = await send(harness.base, callbackPath({ code: AUTH_CODE, shop: SHOP, state, timestamp: "1" }));
    assert.equal(failed.status, 502);
    assert.equal(failed.text.includes(UPSTREAM_LEAK), false);
    assert.equal(failed.text.includes(ACCESS_TOKEN), false);
    assert.equal(failed.text.includes(CLIENT_SECRET), false);
    assert.deepEqual(JSON.parse(failed.text), { error: "token_exchange_failed" });
    assert.equal(harness.tokens.get(), null);
    assert.equal(harness.calls.length, 1);
    });
  });

  it("deletes the shop row on uninstall and shop/redact, and keeps it for customer compliance topics", async () => {
    await withHarness(async (harness) => {
    harness.tokens.save(sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN), FIXED_NOW);

    const payload = Buffer.from(
      JSON.stringify({ shop_domain: SHOP, customer: { email: CUSTOMER_EMAIL, id: 9 } }),
    );
    const dataRequest = await webhook(harness, "/api/shopify/webhooks/customers/data_request", "customers/data_request", payload);
    assert.equal(dataRequest.status, 200);
    assert.equal(dataRequest.text.includes(CUSTOMER_EMAIL), false);
    assert.equal(harness.tokens.get()?.accessToken, ACCESS_TOKEN);
    assert.equal(readFileSync(harness.file).includes(CUSTOMER_EMAIL), false);

    const redact = await webhook(harness, "/api/shopify/webhooks/customers/redact", "customers/redact", payload);
    assert.equal(redact.status, 200);
    assert.equal(harness.tokens.get()?.shopDomain, SHOP);

    const bad = await webhook(harness, "/api/shopify/webhooks/app/uninstalled", "app/uninstalled", payload, "bad-hmac");
    assert.equal(bad.status, 401);
    assert.equal(harness.tokens.get()?.accessToken, ACCESS_TOKEN);

    const foreign = await webhook(
      harness,
      "/api/shopify/webhooks/app/uninstalled",
      "app/uninstalled",
      payload,
      undefined,
      OTHER_SHOP,
    );
    assert.equal(foreign.status, 400);
    assert.equal(harness.tokens.get()?.shopDomain, SHOP);

    const uninstalled = await webhook(harness, "/api/shopify/webhooks/app/uninstalled", "app/uninstalled", payload);
    assert.equal(uninstalled.status, 200);
    assert.equal(uninstalled.text.includes(ACCESS_TOKEN), false);
    assert.equal(harness.tokens.get(), null);

    harness.tokens.save(sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN), FIXED_NOW);
    const shopRedact = await webhook(harness, "/api/shopify/webhooks", "shop/redact", Buffer.from("{}"));
    assert.equal(shopRedact.status, 200);
    assert.equal(harness.tokens.get(), null);
    });
  });

  it("stores a non-expiring offline token when Shopify omits the refresh token", async () => {
    await withHarness(async (harness) => {
      const state = await installState(harness);
      harness.script.push(() => jsonResponse(200, { access_token: OFFLINE_ACCESS, scope: SHOPIFY_SCOPE_PARAM }));
      const callback = await send(harness.base, callbackPath({ code: AUTH_CODE, shop: SHOP, state, timestamp: "1" }));
      assert.equal(callback.status, 200);
      assert.equal(callback.text.includes(OFFLINE_ACCESS), false);
      assert.equal(harness.tokens.get()?.accessToken, OFFLINE_ACCESS);
      assert.equal(harness.tokens.get()?.refreshToken, null);
      assert.equal(harness.tokens.get()?.accessExpiresAt, null);
      const cart = await send(harness.base, "/api/fastbuyjson/cart", { method: "POST" });
      assert.equal(cart.status, 404);
      assert.equal(harness.calls.length, 1);
      assertPlaintextAbsent(harness.file);
    });
  });
});

describe("commerce token refresh", () => {
  it("returns INTERNAL_ERROR with no token when refresh fails, and 404 while the token is usable", async () => {
    await withHarness(async (harness) => {
    harness.tokens.save(
      {
        ...sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN),
        accessExpiresAt: FIXED_NOW - 1_000,
      },
      FIXED_NOW,
    );
    harness.script.push(() => jsonResponse(401, { access_token: UPSTREAM_LEAK, refresh_token: REFRESH_TOKEN }));

    const failed = await send(harness.base, "/api/fastbuyjson/cart", { method: "POST" });
    assert.equal(failed.status, 500);
    assert.match(header(failed.headers, "content-type") ?? "", /^application\/problem\+json/);
    assert.equal(failed.text.includes(ACCESS_TOKEN), false);
    assert.equal(failed.text.includes(REFRESH_TOKEN), false);
    assert.equal(failed.text.includes(UPSTREAM_LEAK), false);
    assert.equal(failed.text.includes(CLIENT_SECRET), false);
    const problem: unknown = JSON.parse(failed.text);
    assert.equal(validateProblem(problem), true);
    assert.deepEqual(problem, {
      type: "https://fastbuyjson.org/problems/internal-error",
      title: "Internal error",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: REINSTALL_DETAIL,
    });
    assert.equal(harness.tokens.get()?.accessToken, null);
    assert.equal(harness.tokens.get()?.refreshToken, null);
    assert.equal(harness.calls.length, 1);
    assert.equal(new URLSearchParams(harness.calls[0]?.body).get("grant_type"), "refresh_token");
    assertPlaintextAbsent(harness.file);

    harness.tokens.save(
      {
        ...sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN),
        accessExpiresAt: FIXED_NOW + 3_600_000,
      },
      FIXED_NOW,
    );
    const deferred = await send(harness.base, "/api/fastbuyjson/cart", { method: "POST" });
    assert.equal(deferred.status, 404);
    assert.equal(harness.calls.length, 1);
    });
  });

  it("replaces an expiring token without putting the new token in the response", async () => {
    await withHarness(async (harness) => {
      harness.tokens.save(
        {
          ...sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN),
          accessExpiresAt: FIXED_NOW - 1_000,
        },
        FIXED_NOW,
      );
      harness.script.push(() =>
        jsonResponse(200, {
          access_token: REFRESHED_ACCESS,
          refresh_token: REFRESHED_REFRESH,
          expires_in: 3600,
          refresh_token_expires_in: 7_776_000,
          scope: SHOPIFY_SCOPE_PARAM,
        }),
      );
      const response = await send(harness.base, "/api/fastbuyjson/cart", { method: "POST" });
      assert.equal(response.status, 404);
      assert.equal(response.text.includes(REFRESHED_ACCESS), false);
      assert.equal(response.text.includes(REFRESHED_REFRESH), false);
      assert.equal(harness.tokens.get()?.accessToken, REFRESHED_ACCESS);
      assert.equal(harness.tokens.get()?.refreshToken, REFRESHED_REFRESH);
      assert.equal(readFileSync(harness.file).includes(REFRESHED_ACCESS), false);
      assert.equal(readFileSync(harness.file).includes(REFRESHED_REFRESH), false);
    });
  });

  it("does not replace a stored shop when the process is configured for another", async () => {
    await withHarness(async (harness) => {
    harness.tokens.save(sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN), FIXED_NOW);
    const response = await send(harness.base, "/api/fastbuyjson/shipping/options");
    assert.equal(response.status, 500);
    const body = JSON.parse(response.text) as { detail?: string; code?: string };
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.equal(body.detail, ONE_SHOP_DETAIL);
    assert.equal(response.text.includes(ACCESS_TOKEN), false);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.tokens.get()?.shopDomain, SHOP);
    assert.equal(harness.tokens.get()?.accessToken, ACCESS_TOKEN);
    }, { shopDomain: OTHER_SHOP });
  });

  it("reports a token store that cannot be decrypted", async () => {
    const file = tempFile();
    const writer = await TokenStore.open(file, randomBytes(32));
    writer.save(sampleToken(SHOP, ACCESS_TOKEN, REFRESH_TOKEN), FIXED_NOW);
    writer.close();
    const tokens = await TokenStore.open(file, randomBytes(32));
    const deps = depsFor(tokens, () => FIXED_NOW, []);
    const access = await prepareCommerceAccess(deps);
    assert.deepEqual(access, { kind: "unavailable", detail: DECRYPT_DETAIL });
    tokens.close();
  });
});

describe("client credentials", () => {
  it("stores an encrypted admin token on startup and skips a second request before expiry", async () => {
    const file = tempFile();
    const auth = authConfig();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      calls.push(body);
      return jsonResponse(200, {
        access_token: ACCESS_TOKEN,
        expires_in: 86_399,
        scope: SHOPIFY_SCOPE_PARAM,
      });
    };
    const first = await openConnector(auth, {
      databasePath: file,
      fetch: fetchImpl,
      now: () => FIXED_NOW,
    });
    assert.equal(calls.length, 1);
    assert.equal(new URLSearchParams(calls[0]).get("grant_type"), "client_credentials");
    assert.equal(first.tokens.get()?.grantType, "client_credentials");
    assert.equal(first.tokens.get()?.accessToken, ACCESS_TOKEN);
    assert.equal(first.tokens.get()?.refreshToken, null);
    assertPlaintextAbsent(file);
    first.tokens.close();

    const secondFetch: typeof fetch = async () => {
      throw new Error("client credentials should not run again before expiry");
    };
    const second = await openConnector(auth, {
      databasePath: file,
      fetch: secondFetch,
      now: () => FIXED_NOW + 1_000,
    });
    assert.equal(second.tokens.get()?.accessToken, ACCESS_TOKEN);
    second.tokens.close();
  });

  it("does not call Shopify when APP_URL selects the authorization-code grant", async () => {
    const file = tempFile();
    const auth = authConfig();
    const withUrl: ShopifyAuthConfig = { ...auth, appUrl: APP_URL };
    const deps = await openConnector(withUrl, {
      databasePath: file,
      fetch: async () => {
        throw new Error("authorization-code startup must not request a token");
      },
      now: () => FIXED_NOW,
    });
    assert.equal(deps.tokens.get(), null);
    deps.tokens.close();
  });

  it("clears the cached access token when client-credentials renewal fails", async () => {
    const { store, file } = await openStore();
    store.save(
      {
        shopDomain: SHOP,
        grantType: "client_credentials",
        accessToken: ACCESS_TOKEN,
        accessExpiresAt: FIXED_NOW - 1,
        refreshToken: null,
        refreshExpiresAt: null,
      },
      FIXED_NOW,
    );
    const deps = depsFor(store, () => FIXED_NOW, []);
    deps.fetch = async () => jsonResponse(400, { access_token: UPSTREAM_LEAK });
    const renewed = await ensureClientCredentials(deps);
    assert.deepEqual(renewed, { ok: false, reason: "request_failed" });
    assert.equal(store.get()?.accessToken, null);
    assertPlaintextAbsent(file);
    const access = await prepareCommerceAccess(deps);
    assert.deepEqual(access, { kind: "unavailable", detail: REINSTALL_DETAIL });
    store.close();
  });
});

type FetchCall = { url: string; body: string };
type Scripted = () => Response | Promise<Response>;

type Harness = {
  base: string;
  file: string;
  tokens: TokenStore;
  calls: FetchCall[];
  script: Scripted[];
  close: () => Promise<void>;
};

async function withHarness(
  fn: (harness: Harness) => Promise<void>,
  options: { shopDomain?: string } = {},
): Promise<void> {
  const harness = await startHarness(options);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

async function startHarness(options: { shopDomain?: string } = {}): Promise<Harness> {
  const file = tempFile();
  const key = randomBytes(32);
  const tokens = await TokenStore.open(file, key);
  const calls: FetchCall[] = [];
  const script: Scripted[] = [];
  const deps: ConnectorDeps = {
    app: {
      shopDomain: options.shopDomain ?? SHOP,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiVersion: SHOPIFY_API_VERSION,
      appUrl: APP_URL,
    },
    tokens,
    oauthState: new OauthStateStore(),
    now: () => FIXED_NOW,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      calls.push({ url, body });
      const next = script.shift();
      if (next === undefined) {
        throw new Error("unexpected Shopify request");
      }
      return next();
    },
  };
  const server = createConnectorServer({ implementationVersion: metadata.version, shopDomain: deps.app.shopDomain }, deps);
  const port = await listen(server, 0, "127.0.0.1");
  return {
    base: `http://127.0.0.1:${port}`,
    file,
    tokens,
    calls,
    script,
    close: async () => {
      tokens.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function depsFor(tokens: TokenStore, now: () => number, script: Scripted[]): ConnectorDeps {
  return {
    app: {
      shopDomain: SHOP,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiVersion: SHOPIFY_API_VERSION,
    },
    tokens,
    oauthState: new OauthStateStore(),
    now,
    fetch: async () => {
      const next = script.shift();
      if (next === undefined) {
        return jsonResponse(500, { access_token: UPSTREAM_LEAK });
      }
      return next();
    },
  };
}

function authConfig(): ShopifyAuthConfig {
  return {
    shopDomain: SHOP,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    encryptionKey: randomBytes(32),
    apiVersion: SHOPIFY_API_VERSION,
  };
}

function sampleToken(shopDomain: string, accessToken: string, refreshToken: string | null) {
  return {
    shopDomain,
    grantType: "authorization_code" as const,
    accessToken,
    accessExpiresAt: FIXED_NOW + 3_600_000,
    refreshToken,
    refreshExpiresAt: refreshToken === null ? null : FIXED_NOW + 7_776_000_000,
  };
}

async function openStore(): Promise<{ store: TokenStore; file: string; key: Buffer }> {
  const file = tempFile();
  const key = randomBytes(32);
  const store = await TokenStore.open(file, key);
  return { store, file, key };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fastbuyjson-shopify-")), "tokens.sqlite");
}

function assertPlaintextAbsent(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  const bytes = readFileSync(file);
  for (const secret of SECRETS) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, secret);
  }
}

async function installState(harness: Harness): Promise<string> {
  const started = await send(harness.base, "/api/shopify/auth");
  const location = new URL(header(started.headers, "location") ?? "");
  const state = location.searchParams.get("state");
  assert.equal(typeof state, "string");
  return state ?? "";
}

function callbackPath(params: Record<string, string>): string {
  const entries = new Map(Object.entries(params).filter(([key]) => key !== "hmac"));
  const hmac = params.hmac ?? signOauthParams(CLIENT_SECRET, entries);
  const search = new URLSearchParams(params);
  search.set("hmac", hmac);
  return `/api/shopify/auth/callback?${search.toString()}`;
}

async function webhook(
  harness: Harness,
  path: string,
  topic: string,
  body: Buffer,
  hmac?: string,
  shop: string = SHOP,
): Promise<{ status: number; text: string }> {
  return send(harness.base, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac ?? signWebhookBody(CLIENT_SECRET, body),
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-Topic": topic,
    },
    body,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function send(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.end(options.body);
      return;
    }
    req.end();
  });
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function validateProblem(body: unknown): boolean {
  const schema = JSON.parse(readFileSync(join(metadata.root, "schemas", "error.json"), "utf8")) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  const addFormats = addFormatsModule.default;
  addFormats(ajv, ["uri"]);
  const validate = ajv.compile(schema);
  const ok = validate(body);
  assert.deepEqual(validate.errors ?? [], []);
  return ok;
}
