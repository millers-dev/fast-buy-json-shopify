import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { SHOPIFY_API_VERSION } from "../src/api-version.js";
import {
  customerAccountsEnabled,
  readCustomerSubSecret,
  readTrustedProxyHops,
} from "../src/config.js";
import {
  CUSTOMER_LOGIN_GRANT_SENTENCE,
  clientAddressForLogin,
  customerSub,
  forwardedForEntries,
  normalizeIp,
  sha256Hex,
  signFastBuyJwt,
  verifyFastBuyJwt,
} from "../src/customer-login-crypto.js";
import { CUSTOMER_USER_AGENT } from "../src/customer-login-shopify.js";
import type { ConnectorDeps } from "../src/deps.js";
import { start } from "../src/index.js";
import { OauthStateStore } from "../src/oauth-state.js";
import { SHOPIFY_SCOPES } from "../src/scopes.js";
import { createConnectorServer, listen } from "../src/server.js";
import { signWebhookBody } from "../src/shopify-hmac.js";
import { TokenStore } from "../src/token-store.js";
import { readPackageMetadata } from "../src/version.js";

const metadata = readPackageMetadata(import.meta.url);
const SHOP = "example.myshopify.com";
const APP_URL = "https://app.example.com";
const CLIENT_ID = "dev-dashboard-client-id";
const CLIENT_SECRET = "shpss_test_client_secret_44cd";
const SUB_SECRET = "customer-sub-secret-0123456789abcd";
const JWT_SECRET = "jwt-secret-for-fastbuyjson-tests-32b";
const CUSTOMER_GID = "gid://shopify/Customer/42";
const CUSTOMER_ACCESS = "shcat_customer_access_token_91aa";
const CUSTOMER_ACCESS_2 = "shcat_customer_access_token_second";
const CUSTOMER_REFRESH = "shprt_customer_refresh_must_not_be_stored";
const CUSTOMER_EMAIL = "buyer-secret@example.com";
const ID_TOKEN_MARKER = "id-token-signature-not-stored";
const AUTH_CODE = "customer-auth-code-not-for-logs-77";
const FIXED_NOW = 1_700_000_000_000;
const OPENID = {
  authorization_endpoint: "https://accounts.example.com/authentication/oauth/authorize",
  token_endpoint: "https://accounts.example.com/authentication/oauth/token",
  end_session_endpoint: "https://accounts.example.com/authentication/logout",
  jwks_uri: "https://accounts.example.com/authentication/.well-known/jwks.json",
  issuer: "https://shopify.com/authentication/1",
  grant_types_supported: ["authorization_code", "refresh_token"],
};
const API_DOC = {
  graphql_api: "https://accounts.example.com/customer/api/unstable/graphql",
  mcp_api: "https://accounts.example.com/customer/api/mcp",
};
const GRAPHQL_URL = "https://accounts.example.com/customer/api/2026-10/graphql";

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
});

describe("customer login configuration", () => {
  it("rejects a trusted-proxy hop count that is not an integer from 0 to 10", () => {
    assert.equal(readTrustedProxyHops(undefined), 0);
    assert.equal(readTrustedProxyHops(""), 0);
    assert.equal(readTrustedProxyHops("0"), 0);
    assert.equal(readTrustedProxyHops(" 2 "), 2);
    assert.equal(readTrustedProxyHops("10"), 10);
    for (const value of ["1abc", "-1", "1.5", "11", "   ", "1abc ", "+1"]) {
      assert.throws(() => readTrustedProxyHops(value), /0 to 10/);
      assert.throws(() => start({ SHOPIFY_TRUSTED_PROXY_HOPS: value }), /0 to 10/);
    }
  });

  it("refuses to start when the sub secret is set and shorter than 32 bytes", () => {
    assert.equal(readCustomerSubSecret(undefined), undefined);
    assert.equal(readCustomerSubSecret(""), undefined);
    assert.equal(readCustomerSubSecret("x".repeat(32))?.length, 32);
    assert.throws(() => start({ SHOPIFY_CUSTOMER_SUB_SECRET: "short-secret" }), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = error instanceof Error ? error.message : "";
      assert.equal(message.includes("short-secret"), false);
      assert.match(message, /32 bytes/);
      return true;
    });
  });

  it("treats customer accounts as off unless the value is 1 or true", () => {
    for (const value of [undefined, "", "   ", "0", "false", "off", "yes", "no"]) {
      assert.equal(customerAccountsEnabled(value), false);
    }
    assert.equal(customerAccountsEnabled("1"), true);
    assert.equal(customerAccountsEnabled(" TRUE "), true);
  });

  it("normalizes IPv6 to the lowercase RFC 5952 form and keeps IPv4", () => {
    assert.equal(normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
    assert.equal(normalizeIp("2001:DB8::1"), "2001:db8::1");
    assert.equal(normalizeIp("2001:db8:0:0:1:0:0:1"), "2001:db8::1:0:0:1");
    assert.equal(normalizeIp("::ffff:192.0.2.1"), "::ffff:192.0.2.1");
    assert.equal(normalizeIp("203.0.113.5"), "203.0.113.5");
    assert.equal(normalizeIp("not-an-ip"), null);
    assert.equal(normalizeIp("  203.0.113.5"), null);
    const forwarded = forwardedForEntries([
      "X-Forwarded-For",
      "203.0.113.1, 203.0.113.2",
      "Host",
      "app.example.com",
      "X-Forwarded-For",
      " 203.0.113.3 ",
    ]);
    assert.deepEqual(forwarded, ["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    assert.deepEqual(clientAddressForLogin("127.0.0.1", forwarded, 1), { kind: "ok", key: "203.0.113.3" });
    assert.deepEqual(clientAddressForLogin("127.0.0.1", forwarded, 2), { kind: "ok", key: "203.0.113.2" });
    assert.deepEqual(clientAddressForLogin("127.0.0.1", forwarded, 0), { kind: "ok", key: "127.0.0.1" });
    assert.equal(clientAddressForLogin("127.0.0.1", [], 1).kind, "rejected");
  });

  it("declares the customer callback, javascript origin, and the two customer scopes", () => {
    const toml = readFileSync(join(metadata.root, "shopify.app.toml"), "utf8");
    const scopesLine = toml.split("\n").find((line) => line.startsWith("scopes = "));
    const scopes = scopesLine?.split("=").slice(1).join("=").trim().replaceAll('"', "").split(",") ?? [];
    for (const forbidden of [
      "read_customers",
      "write_customers",
      "customer_write_orders",
      "customer_write_customers",
      "read_all_orders",
    ]) {
      assert.equal(scopes.includes(forbidden), false);
    }
    assert.deepEqual(scopes, [...SHOPIFY_SCOPES]);
    const block = toml.slice(toml.indexOf("[customer_authentication]"));
    const quoted = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    assert.equal(quoted[0], "https://app.example.com/api/fastbuyjson/auth/customer/callback");
    assert.equal(quoted[1], "https://app.example.com");
    assert.equal(new URL(quoted[1] ?? "").origin, quoted[1]);
    assert.match(toml, /Name and Email/);
    assert.match(toml, /Do not declare Phone/);
  });

  it("builds sub as unpadded base64url HMAC and keeps the GID out of the JWT", () => {
    const sub = customerSub(SUB_SECRET, CUSTOMER_GID);
    assert.equal(sub.includes("+"), false);
    assert.equal(sub.includes("/"), false);
    assert.equal(sub.includes("="), false);
    assert.equal(sub.includes("gid://"), false);
    const token = signFastBuyJwt(JWT_SECRET, sub, FIXED_NOW, 3600);
    const claims = verifyFastBuyJwt(JWT_SECRET, token);
    assert.equal(claims?.sub, sub);
    assert.equal(claims?.exp, Math.floor(FIXED_NOW / 1000) + 3600);
    assert.equal(token.includes("gid://"), false);
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as object;
    assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "sub"]);
  });
});

describe("customer login handoff", () => {
  it("keeps /detect free of auth while the flag is off and still serves start", async () => {
    await withHarness(async (harness) => {
      const detect = await send(harness.base, "/api/fastbuyjson/detect");
      assert.equal(detect.status, 200);
      assert.equal(detect.headers["cache-control"], "public, max-age=300");
      const body = JSON.parse(detect.text) as { endpoints: string[]; authentication: { methods: string[] } };
      assert.equal(body.endpoints.includes("auth"), false);
      assert.deepEqual(body.authentication.methods, ["anonymous"]);
      const started = await startLogin(harness);
      assert.equal(started.status, 200);
      assert.equal(new URL(started.body.loginUrl).search, "");
      assert.equal(started.body.loginUrl.includes(started.body.pollToken), false);
      assert.equal(started.body.loginUrl.includes("pollToken"), false);
      assert.match(started.body.userCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    });
  });

  it("does not advertise auth when the flag is on", async () => {
    await withHarness(async (harness) => {
      harness.deps.customerAccounts = true;
      const detect = await send(harness.base, "/api/fastbuyjson/detect");
      const body = JSON.parse(detect.text) as { endpoints: string[]; authentication: { methods: string[] } };
      assert.equal(body.endpoints.includes("auth"), false);
      assert.deepEqual(body.authentication.methods, ["anonymous"]);
    }, { customerAccounts: true });
  });

  it("does not hold the token store lock during discovery", async () => {
    await withHarness(async (harness) => {
      let releaseDiscovery = (): void => {};
      const released = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      let markEntered = (): void => {};
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      harness.delayDiscovery = async () => {
        markEntered();
        await released;
      };
      const pending = send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
      try {
        const reached = await Promise.race([
          entered.then(() => "entered" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), 2_000);
          }),
        ]);
        assert.equal(reached, "entered");
        const locked = await Promise.race([
          harness.tokens.exclusive(async () => "free" as const),
          new Promise<"held">((resolve) => {
            setTimeout(() => resolve("held"), 500);
          }),
        ]);
        assert.equal(locked, "free");
        releaseDiscovery();
        const response = await pending;
        assert.equal(response.status, 200);
        assert.equal(harness.tokens.customer.countLive(FIXED_NOW), 1);
      } finally {
        releaseDiscovery();
      }
    });
  });

  it("returns 500 when discovery is missing or not JSON and writes no poll row", async () => {
    await withHarness(async (harness) => {
      harness.openidStatus = 404;
      const missing = await send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
      assert.equal(missing.status, 500);
      const body = JSON.parse(missing.text) as { code: string; detail: string };
      assert.equal(body.code, "INTERNAL_ERROR");
      assert.match(body.detail, /customer accounts must be enabled/i);
      assert.match(body.detail, /discovery failed/i);
      assert.equal(missing.text.includes("pollToken"), false);
      assert.equal(harness.tokens.customer.countLive(FIXED_NOW), 0);
      harness.openidStatus = 200;
      harness.openidBody = "not-json";
      const bad = await send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
      assert.equal(bad.status, 500);
      assert.match(bad.text, /customer accounts must be enabled/i);
      assert.equal(harness.tokens.customer.countLive(FIXED_NOW), 0);
    });
  });

  it("returns 500 when APP_URL is missing and does not call discovery", async () => {
    await withHarness(async (harness) => {
      const response = await send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
      assert.equal(response.status, 500);
      assert.match(response.text, /https APP_URL/);
      assert.equal(harness.calls.length, 0);
      assert.equal(harness.tokens.customer.countLive(FIXED_NOW), 0);
    }, { appUrl: false });
  });

  it("shows the user code once, binds the host cookie, and redirects with S256", async () => {
    await withHarness(async (harness) => {
      const started = await startLogin(harness);
      assert.equal(started.headers["cache-control"], "no-store");
      const loginPath = new URL(started.body.loginUrl).pathname;
      const opened = await send(harness.base, loginPath);
      assert.equal(opened.status, 200);
      assert.equal(opened.headers.location, undefined);
      assert.equal(opened.headers["cache-control"], "no-store");
      assert.equal(opened.headers["referrer-policy"], "no-referrer");
      assert.equal(opened.text.includes(started.body.userCode), true);
      assert.equal(opened.text.includes(CUSTOMER_LOGIN_GRANT_SENTENCE), true);
      assert.equal(opened.text.includes(started.body.pollToken), false);
      const cookieHeader = setCookie(opened.headers);
      assert.match(
        cookieHeader,
        /^__Host-fastbuyjson-login=[A-Za-z0-9_-]+; HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=600$/,
      );
      assert.equal(/domain=/i.test(cookieHeader), false);
      const cookie = cookieValue(cookieHeader);

      const again = await send(harness.base, loginPath);
      const unknown = await send(harness.base, "/api/fastbuyjson/auth/customer/login/aaaaaaaaaaaaaaaaaaaaaa");
      assert.equal(again.status, 400);
      assert.equal(unknown.status, 400);
      assert.equal(again.text, unknown.text);
      assert.equal(again.headers["set-cookie"], undefined);
      assert.equal(unknown.headers["set-cookie"], undefined);
      assert.equal(again.headers.location, undefined);
      assert.equal(unknown.headers.location, undefined);

      const bare = await send(harness.base, `${loginPath}/continue`, { method: "POST" });
      assert.equal(bare.status, 400);
      assert.equal(bare.headers.location, undefined);
      assert.equal(harness.calls.some((call) => call.url === OPENID.token_endpoint), false);

      const continued = await send(harness.base, `${loginPath}/continue`, {
        method: "POST",
        headers: { Cookie: `${cookieHeader.split(";")[0]}` },
      });
      assert.equal(continued.status, 302);
      assert.equal(continued.headers["cache-control"], "no-store");
      const location = new URL(header(continued.headers, "location") ?? "");
      assert.equal(location.origin, "https://accounts.example.com");
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("client_secret"), null);
      assert.equal(location.searchParams.has("prompt"), false);
      assert.equal(location.searchParams.get("scope"), "openid email customer-account-api:full");
      assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(location.searchParams.get("redirect_uri"), `${APP_URL}/api/fastbuyjson/auth/customer/callback`);
      assert.equal(location.toString().includes(started.body.pollToken), false);
      assert.equal(cookie.length > 0, true);
    });
  });

  it("exchanges the code once, stores sub and the access token, and returns the JWT once", async () => {
    await withHarness(async (harness) => {
      const logFrom = logLines.length;
      const done = await completeLogin(harness, {
        accessToken: CUSTOMER_ACCESS,
        expiresIn: 7200,
        refreshToken: CUSTOMER_REFRESH,
        email: CUSTOMER_EMAIL,
        customerId: CUSTOMER_GID,
      });
      const tokenCall = harness.calls.find((call) => call.url === OPENID.token_endpoint);
      assert.ok(tokenCall);
      assert.equal(tokenCall.headers.get("user-agent"), CUSTOMER_USER_AGENT);
      assert.equal(tokenCall.headers.get("origin"), APP_URL);
      assert.equal(tokenCall.headers.get("authorization"), null);
      const form = new URLSearchParams(tokenCall.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_secret"), null);
      assert.equal(form.get("code"), AUTH_CODE);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "", "ascii").digest("base64url");
      assert.equal(challenge, done.location.searchParams.get("code_challenge"));
      const graphql = harness.calls.find((call) => call.url === GRAPHQL_URL);
      assert.ok(graphql);
      assert.equal(graphql.headers.get("authorization"), CUSTOMER_ACCESS);
      assert.equal(graphql.headers.get("authorization")?.startsWith("Bearer "), false);
      assert.equal(graphql.headers.get("user-agent"), CUSTOMER_USER_AGENT);
      assert.equal(graphql.headers.get("origin"), APP_URL);
      assert.equal(/email/i.test(graphql.body), false);
      assert.equal(harness.calls.some((call) => call.url.includes("logout")), false);
      assert.equal(harness.calls.some((call) => call.body.includes("refresh_token")), false);
      assert.equal(graphql.url.includes("myshopify.com"), false);

      assert.equal(done.callback.status, 200);
      assert.equal(done.callback.headers["referrer-policy"], "no-referrer");
      assert.equal(done.callback.text.includes(done.jwt), false);
      assert.equal(done.callback.text.includes(done.pollToken), false);
      assert.equal(done.callback.text.includes("gid://"), false);
      assert.equal(harness.tokens.customer.countSessions(), 1);
      const sub = customerSub(SUB_SECRET, CUSTOMER_GID);
      const session = harness.tokens.customer.getSession(SHOP, sub);
      assert.equal(session?.accessToken, CUSTOMER_ACCESS);
      assert.equal(session?.expiresAt, FIXED_NOW + 7_200_000);
      assertPlaintextAbsent(harness.file, [CUSTOMER_REFRESH, CUSTOMER_EMAIL, CUSTOMER_GID, ID_TOKEN_MARKER, done.pollToken, done.jwt, AUTH_CODE, done.userCode]);

      const claims = verifyFastBuyJwt(JWT_SECRET, done.jwt);
      assert.equal(claims?.sub, sub);
      assert.equal(claims?.exp !== undefined ? claims.exp - claims.iat : 0, 3600);
      assert.equal(done.jwt.includes("gid://"), false);
      assert.equal(Object.hasOwn(done.pollBody, "refresh_token"), false);

      const again = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ pollToken: done.pollToken })),
      });
      assert.equal(again.status, 401);
      assert.equal(again.text.includes(done.jwt), false);
      const logs = logLines.slice(logFrom).join("\n");
      assert.equal(logs.includes(done.pollToken), false);
      assert.equal(logs.includes(AUTH_CODE), false);
      assert.equal(logs.includes(done.userCode), false);
      assert.equal(logs.includes(done.jwt), false);
    });
  });

  it("drops a refresh token and does not call the refresh grant", async () => {
    await withHarness(async (harness) => {
      await completeLogin(harness, {
        accessToken: CUSTOMER_ACCESS,
        expiresIn: 100,
        refreshToken: CUSTOMER_REFRESH,
        email: CUSTOMER_EMAIL,
        customerId: CUSTOMER_GID,
      });
      assert.equal(harness.calls.some((call) => call.body.includes("grant_type=refresh_token")), false);
      assert.equal(harness.calls.some((call) => new URLSearchParams(call.body).get("grant_type") === "refresh_token"), false);
      assertPlaintextAbsent(harness.file, [CUSTOMER_REFRESH, CUSTOMER_EMAIL]);
      const session = harness.tokens.customer.getSession(SHOP, customerSub(SUB_SECRET, CUSTOMER_GID));
      assert.equal(session?.accessToken, CUSTOMER_ACCESS);
      assert.equal(session?.expiresAt, FIXED_NOW + 100_000);
    });
  });

  it("stores no session when the id_token nonce does not match", async () => {
    await withHarness(async (harness) => {
      const done = await completeLogin(harness, {
        accessToken: CUSTOMER_ACCESS,
        expiresIn: 3600,
        customerId: CUSTOMER_GID,
        nonce: "wrong-nonce-value-not-the-request",
      });
      assert.equal(done.pollStatus, 401);
      assert.equal(harness.tokens.customer.countSessions(), 0);
      assert.equal(harness.calls.some((call) => call.url === GRAPHQL_URL), false);
    });
  });

  it("stores no JWT when Customer.id is not a customer GID", async () => {
    await withHarness(async (harness) => {
      const done = await completeLogin(harness, {
        accessToken: CUSTOMER_ACCESS,
        expiresIn: 3600,
        customerId: "gid://shopify/Order/42",
      });
      assert.equal(done.pollStatus, 401);
      assert.equal(harness.tokens.customer.countSessions(), 0);
      assert.equal(done.pollText.includes("access_token"), false);
    });
  });

  it("returns 500 from login completion when a signing secret is unset", async () => {
    await withHarness(async (harness) => {
      const started = await startLogin(harness);
      const opened = await openLogin(harness, started.body.loginUrl);
      const location = await continueLogin(harness, started.body.loginUrl, opened.cookie);
      const before = harness.calls.length;
      const callback = await send(harness.base, callbackPath(location), { headers: { Cookie: opened.cookie } });
      assert.equal(callback.status, 500);
      assert.equal(callback.text.includes("access_token"), false);
      assert.match(callback.text, /could not be completed/);
      assert.equal(harness.calls.length, before);
      const polled = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
      });
      assert.equal(polled.status, 500);
      assert.match(polled.text, /could not be completed/);
      assert.equal(harness.tokens.customer.countSessions(), 0);
    }, { subSecret: false });
  });

  it("marks state used before the token request and does not exchange it twice", async () => {
    await withHarness(async (harness) => {
      const started = await startLogin(harness);
      const opened = await openLogin(harness, started.body.loginUrl);
      const location = await continueLogin(harness, started.body.loginUrl, opened.cookie);
      const state = location.searchParams.get("state") ?? "";
      let sawUsed = false;
      harness.onToken = () => {
        sawUsed = harness.tokens.customer.isStateUsed(sha256Hex(state));
        return tokenResponse({
          access_token: CUSTOMER_ACCESS,
          expires_in: 3600,
          id_token: idToken(location.searchParams.get("nonce") ?? ""),
        });
      };
      harness.onGraphql = () => jsonResponse(200, { data: { customer: { id: CUSTOMER_GID } } });
      const first = await send(harness.base, callbackPath(location), { headers: { Cookie: opened.cookie } });
      assert.equal(first.status, 200);
      assert.equal(sawUsed, true);
      const calls = harness.calls.length;
      const second = await send(harness.base, callbackPath(location), { headers: { Cookie: opened.cookie } });
      assert.equal(second.status, 400);
      assert.equal(harness.calls.length, calls);
    });
  });

  it("does not exchange a code without the login cookie or with another login's cookie", async () => {
    await withHarness(async (harness) => {
      const first = await startLogin(harness);
      const firstOpen = await openLogin(harness, first.body.loginUrl);
      const second = await startLogin(harness);
      const secondOpen = await openLogin(harness, second.body.loginUrl);
      const firstLocation = await continueLogin(harness, first.body.loginUrl, firstOpen.cookie);
      const secondLocation = await continueLogin(harness, second.body.loginUrl, secondOpen.cookie);
      const before = harness.calls.length;
      const missing = await send(harness.base, callbackPath(firstLocation));
      assert.equal(missing.status, 400);
      assert.equal(harness.calls.length, before);
      const crossed = await send(harness.base, callbackPath(secondLocation), { headers: { Cookie: firstOpen.cookie } });
      assert.equal(crossed.status, 400);
      assert.equal(harness.calls.length, before);
      assert.equal(harness.tokens.customer.countSessions(), 0);
      const pending = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: second.body.pollToken })),
      });
      assert.equal(pending.status, 200);
      assert.deepEqual(JSON.parse(pending.text), { status: "pending" });
    });
  });

  it("rejects pollToken in the query string or the path and answers pending from the body", async () => {
    await withHarness(async (harness) => {
      const started = await startLogin(harness);
      const pending = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
      });
      assert.equal(pending.status, 200);
      assert.deepEqual(JSON.parse(pending.text), { status: "pending" });
      const fromQuery = await send(
        harness.base,
        `/api/fastbuyjson/auth/customer/poll?pollToken=${encodeURIComponent(started.body.pollToken)}`,
        { method: "POST", body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })) },
      );
      assert.equal(fromQuery.status, 401);
      assert.equal(fromQuery.text.includes(started.body.pollToken), false);
      const fromPath = await send(
        harness.base,
        `/api/fastbuyjson/auth/customer/poll/${encodeURIComponent(started.body.pollToken)}`,
        { method: "POST" },
      );
      assert.equal(fromPath.status, 401);
      const still = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
      });
      assert.equal(still.status, 429);
      assert.equal(still.text.includes("access_token"), false);
    });
  });

  it("rate limits a second poll inside 2 seconds and an unknown or expired poll token", async () => {
    await withHarness(async (harness) => {
      const started = await startLogin(harness);
      const first = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
      });
      assert.equal(first.status, 200);
      const second = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
      });
      assert.equal(second.status, 429);
      assert.equal(second.text.includes("access_token"), false);
      harness.setNow(FIXED_NOW + 10 * 60 * 1000);
      const expired = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
      });
      assert.equal(expired.status, 401);
      const unknown = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
        method: "POST",
        body: Buffer.from(JSON.stringify({ pollToken: "bbbbbbbbbbbbbbbbbbbbbb" })),
      });
      assert.equal(unknown.status, 401);
    });
  });

  it("returns 500 when the token endpoint is 403 or 401 invalid_token", async () => {
    await withHarness(async (harness) => {
      harness.tokenStatus = 403;
      const forbidden = await completeLogin(harness, { accessToken: CUSTOMER_ACCESS, expiresIn: 3600, customerId: CUSTOMER_GID });
      assert.equal(forbidden.pollStatus, 500);
      assert.match(forbidden.pollText, /misconfigured/);
      assert.equal(harness.tokens.customer.countSessions(), 0);
    });
    await withHarness(async (harness) => {
      harness.tokenStatus = 401;
      harness.tokenWwwAuthenticate = 'Bearer error="invalid_token"';
      const invalid = await completeLogin(harness, { accessToken: CUSTOMER_ACCESS, expiresIn: 3600, customerId: CUSTOMER_GID });
      assert.equal(invalid.pollStatus, 500);
      assert.match(invalid.pollText, /misconfigured/);
      assert.equal(invalid.pollText.includes(CUSTOMER_ACCESS), false);
    });
  });

  it("limits start to 10 per socket and shares that bucket when hops are unset", async () => {
    await withHarness(async (harness) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
          method: "POST",
          headers: { "X-Forwarded-For": attempt < 5 ? "203.0.113.5" : "198.51.100.8" },
        });
        assert.equal(response.status, 200);
      }
      const blocked = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "198.51.100.9" },
      });
      assert.equal(blocked.status, 429);
      assert.equal(harness.tokens.customer.countLive(FIXED_NOW), 10);
    });
  });

  it("buckets X-Forwarded-For from the right when hops is 1 and fails closed otherwise", async () => {
    await withHarness(async (harness) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
          method: "POST",
          headers: { "X-Forwarded-For": `10.0.0.1, 203.0.113.10` },
        });
        assert.equal(response.status, 200);
      }
      const same = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.1.1.1, 203.0.113.10" },
      });
      assert.equal(same.status, 429);
      const other = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.0.0.1, 203.0.113.11" },
      });
      assert.equal(other.status, 200);
      const padded = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "  203.0.113.12  " },
      });
      assert.equal(padded.status, 200);
      const missing = await send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
      assert.equal(missing.status, 429);
      const bad = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "not-an-ip" },
      });
      assert.equal(bad.status, 429);
      const before = harness.tokens.customer.countLive(FIXED_NOW);
      harness.deps.trustedProxyHops = 2;
      const short = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "203.0.113.13" },
      });
      assert.equal(short.status, 429);
      assert.equal(harness.tokens.customer.countLive(FIXED_NOW), before);
    }, { hops: 1 });
  });

  it("shares one IPv6 bucket across RFC 5952 spellings", async () => {
    await withHarness(async (harness) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
          method: "POST",
          headers: { "X-Forwarded-For": "2001:0db8:0000:0000:0000:0000:0000:0001" },
        });
        assert.equal(response.status, 200);
      }
      const same = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "2001:DB8::1" },
      });
      assert.equal(same.status, 429);
      const other = await send(harness.base, "/api/fastbuyjson/auth/customer/start", {
        method: "POST",
        headers: { "X-Forwarded-For": "2001:db8::2" },
      });
      assert.equal(other.status, 200);
    }, { hops: 1 });
  });

  it("refuses the 101st live poll row", async () => {
    await withHarness(async (harness) => {
      for (let index = 0; index < 100; index += 1) {
        harness.tokens.customer.insertPoll({
          shopDomain: SHOP,
          loginIdHash: sha256Hex(`login-${index}`),
          pollTokenHash: sha256Hex(`poll-${index}`),
          expiresAt: FIXED_NOW + 60_000,
          createdAt: FIXED_NOW,
          authorizationEndpoint: OPENID.authorization_endpoint,
          tokenEndpoint: OPENID.token_endpoint,
          graphqlApi: GRAPHQL_URL,
          userCode: "ABCD-EFGH",
          oauthNonce: "n".repeat(22),
          codeVerifier: "v".repeat(43),
        });
      }
      const response = await send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
      assert.equal(response.status, 429);
      assert.equal(harness.tokens.customer.countLive(FIXED_NOW), 100);
      assert.equal(harness.calls.length, 0);
    });
  });

  it("keeps one session row when the same customer logs in again", async () => {
    await withHarness(async (harness) => {
      const first = await completeLogin(harness, {
        accessToken: CUSTOMER_ACCESS,
        expiresIn: 3600,
        customerId: CUSTOMER_GID,
      });
      harness.setNow(FIXED_NOW + 5_000);
      const second = await completeLogin(harness, {
        accessToken: CUSTOMER_ACCESS_2,
        expiresIn: 1800,
        customerId: CUSTOMER_GID,
      });
      assert.equal(harness.tokens.customer.countSessions(), 1);
      assert.equal(harness.tokens.customer.getSession(SHOP, customerSub(SUB_SECRET, CUSTOMER_GID))?.accessToken, CUSTOMER_ACCESS_2);
      assert.equal(verifyFastBuyJwt(JWT_SECRET, first.jwt)?.sub, customerSub(SUB_SECRET, CUSTOMER_GID));
      assert.equal(verifyFastBuyJwt(JWT_SECRET, second.jwt)?.exp, Math.floor((FIXED_NOW + 5_000) / 1000) + 1800);
    });
  });

  it("deletes the session on customers/redact, customers/data_request, and shop/redact", async () => {
    await withHarness(async (harness) => {
      const sub = customerSub(SUB_SECRET, CUSTOMER_GID);
      harness.tokens.customer.saveSession(SHOP, sub, CUSTOMER_ACCESS, FIXED_NOW + 60_000);
      const payload = Buffer.from(JSON.stringify({
        shop_domain: SHOP,
        customer: { id: 42, email: CUSTOMER_EMAIL, phone: "555-0100" },
        orders_to_redact: [1001],
      }));
      const dataRequest = await webhook(harness, "/api/shopify/webhooks/customers/data_request", "customers/data_request", payload);
      assert.equal(dataRequest.status, 200);
      assert.deepEqual(JSON.parse(dataRequest.text), { ok: true });
      assert.equal(dataRequest.text.includes(CUSTOMER_EMAIL), false);
      assert.equal(dataRequest.text.includes("gid://"), false);
      assert.equal(harness.tokens.customer.countSessions(), 0);

      harness.tokens.customer.saveSession(SHOP, sub, CUSTOMER_ACCESS, FIXED_NOW + 60_000);
      const redact = await webhook(harness, "/api/shopify/webhooks/customers/redact", "customers/redact", payload);
      assert.equal(redact.status, 200);
      assert.equal(harness.tokens.customer.countSessions(), 0);
      assert.equal(redact.text.includes(CUSTOMER_EMAIL), false);

      harness.tokens.customer.saveSession(SHOP, sub, CUSTOMER_ACCESS, FIXED_NOW + 60_000);
      const shopRedact = await webhook(harness, "/api/shopify/webhooks/shop/redact", "shop/redact", Buffer.from("{}"));
      assert.equal(shopRedact.status, 200);
      assert.equal(harness.tokens.customer.countSessions(), 0);
    });
  });
});

type Call = { url: string; headers: Headers; body: string };

type Harness = {
  base: string;
  file: string;
  tokens: TokenStore;
  deps: ConnectorDeps;
  calls: Call[];
  setNow: (value: number) => void;
  openidStatus: number;
  openidBody: unknown;
  tokenStatus: number;
  tokenWwwAuthenticate: string | undefined;
  onToken: (() => Response) | undefined;
  onGraphql: (() => Response) | undefined;
  delayDiscovery: (() => Promise<void>) | null;
  close: () => Promise<void>;
};

async function withHarness(
  fn: (harness: Harness) => Promise<void>,
  options: { appUrl?: false; hops?: number; subSecret?: false; customerAccounts?: boolean } = {},
): Promise<void> {
  const file = join(mkdtempSync(join(tmpdir(), "fastbuyjson-customer-")), "tokens.sqlite");
  const tokens = await TokenStore.open(file, Buffer.from("k".repeat(32)));
  const calls: Call[] = [];
  let now = FIXED_NOW;
  const harness = {
    file,
    tokens,
    calls,
    openidStatus: 200,
    openidBody: OPENID,
    tokenStatus: 200,
    delayDiscovery: null,
    setNow: (value: number) => {
      now = value;
    },
  } as Harness;
  const app = {
    shopDomain: SHOP,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiVersion: SHOPIFY_API_VERSION,
    ...(options.appUrl === false ? {} : { appUrl: APP_URL }),
  };
  const deps: ConnectorDeps = {
    app,
    tokens,
    oauthState: new OauthStateStore(),
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const body = requestBody(init?.body);
      calls.push({ url, headers, body });
      if (url.endsWith("/.well-known/openid-configuration")) {
        if (harness.delayDiscovery !== null) {
          await harness.delayDiscovery();
        }
        if (harness.openidStatus !== 200) {
          return new Response("missing", { status: harness.openidStatus });
        }
        if (typeof harness.openidBody === "string") {
          return new Response(harness.openidBody, { status: 200, headers: { "Content-Type": "text/plain" } });
        }
        return jsonResponse(200, harness.openidBody);
      }
      if (url.endsWith("/.well-known/customer-account-api")) {
        return jsonResponse(200, API_DOC);
      }
      if (url === OPENID.token_endpoint) {
        if (harness.onToken !== undefined) {
          return harness.onToken();
        }
        const response = jsonResponse(harness.tokenStatus, { error: "no-token-script" });
        if (harness.tokenWwwAuthenticate !== undefined) {
          response.headers.set("www-authenticate", harness.tokenWwwAuthenticate);
        }
        return response;
      }
      if (url === GRAPHQL_URL) {
        if (harness.onGraphql !== undefined) {
          return harness.onGraphql();
        }
        return jsonResponse(500, { error: "no-graphql-script" });
      }
      return jsonResponse(500, { error: "unexpected-url" });
    },
    now: () => now,
    customerAccounts: options.customerAccounts === true,
    trustedProxyHops: options.hops ?? 0,
    ...(options.subSecret === false ? {} : { customerSubSecret: SUB_SECRET, jwtSecret: JWT_SECRET }),
  };
  harness.deps = deps;
  const server = createConnectorServer({ implementationVersion: metadata.version, shopDomain: SHOP }, deps);
  const port = await listen(server, 0, "127.0.0.1");
  harness.base = `http://127.0.0.1:${port}`;
  harness.close = async () => {
    tokens.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

type Started = {
  status: number;
  headers: IncomingHttpHeaders;
  body: { loginUrl: string; pollToken: string; userCode: string; expiresAt: string };
};

async function startLogin(harness: Harness): Promise<Started> {
  const response = await send(harness.base, "/api/fastbuyjson/auth/customer/start", { method: "POST" });
  assert.equal(response.status, 200);
  return { status: response.status, headers: response.headers, body: JSON.parse(response.text) as Started["body"] };
}

async function openLogin(harness: Harness, loginUrl: string): Promise<{ cookie: string; text: string }> {
  const opened = await send(harness.base, new URL(loginUrl).pathname);
  assert.equal(opened.status, 200);
  return { cookie: setCookie(opened.headers).split(";")[0] ?? "", text: opened.text };
}

async function continueLogin(harness: Harness, loginUrl: string, cookie: string): Promise<URL> {
  const continued = await send(harness.base, `${new URL(loginUrl).pathname}/continue`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(continued.status, 302);
  return new URL(header(continued.headers, "location") ?? "");
}

async function completeLogin(
  harness: Harness,
  input: {
    accessToken: string;
    expiresIn: number;
    refreshToken?: string;
    email?: string;
    customerId: string;
    nonce?: string;
  },
): Promise<{
  jwt: string;
  pollToken: string;
  userCode: string;
  pollStatus: number;
  pollText: string;
  pollBody: Record<string, unknown>;
  callback: { status: number; text: string; headers: IncomingHttpHeaders };
  location: URL;
}> {
  const started = await startLogin(harness);
  const opened = await openLogin(harness, started.body.loginUrl);
  const location = await continueLogin(harness, started.body.loginUrl, opened.cookie);
  const nonce = input.nonce ?? location.searchParams.get("nonce") ?? "";
  harness.onToken = () => {
    const payload: Record<string, unknown> = {
      access_token: input.accessToken,
      expires_in: input.expiresIn,
      id_token: idToken(nonce, input.email === undefined ? {} : { email: input.email }),
    };
    if (input.refreshToken !== undefined) {
      payload.refresh_token = input.refreshToken;
    }
    const response = jsonResponse(harness.tokenStatus, payload);
    if (harness.tokenWwwAuthenticate !== undefined) {
      response.headers.set("www-authenticate", harness.tokenWwwAuthenticate);
    }
    return response;
  };
  harness.onGraphql = () => jsonResponse(200, { data: { customer: { id: input.customerId } } });
  const callback = await send(harness.base, callbackPath(location), { headers: { Cookie: opened.cookie } });
  harness.setNow(harness.deps.now() + 2_000);
  const polled = await send(harness.base, "/api/fastbuyjson/auth/customer/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Buffer.from(JSON.stringify({ pollToken: started.body.pollToken })),
  });
  const pollBody = JSON.parse(polled.text) as Record<string, unknown>;
  return {
    jwt: typeof pollBody.access_token === "string" ? pollBody.access_token : "",
    pollToken: started.body.pollToken,
    userCode: started.body.userCode,
    pollStatus: polled.status,
    pollText: polled.text,
    pollBody,
    callback: { status: callback.status, text: callback.text, headers: callback.headers },
    location,
  };
}

function callbackPath(location: URL): string {
  const url = new URL("/api/fastbuyjson/auth/customer/callback", APP_URL);
  url.searchParams.set("code", AUTH_CODE);
  url.searchParams.set("state", location.searchParams.get("state") ?? "");
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function idToken(nonce: string, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ nonce, ...extra }), "utf8").toString("base64url");
  return `${header}.${payload}.${ID_TOKEN_MARKER}`;
}

function tokenResponse(body: unknown): Response {
  return jsonResponse(200, body);
}

function requestBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  return "";
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
  options: { method?: string; headers?: Record<string, string | string[]>; body?: Buffer } = {},
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

function setCookie(headers: IncomingHttpHeaders): string {
  const value = headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : value;
  assert.equal(typeof cookie, "string");
  return cookie ?? "";
}

function cookieValue(headerValue: string): string {
  return /^__Host-fastbuyjson-login=([^;]+)/.exec(headerValue)?.[1] ?? "";
}

function assertPlaintextAbsent(file: string, secrets: string[]): void {
  if (!existsSync(file)) {
    return;
  }
  const bytes = readFileSync(file);
  for (const secret of secrets) {
    assert.equal(bytes.includes(secret), false, secret);
  }
}

async function webhook(
  harness: Harness,
  path: string,
  topic: string,
  body: Buffer,
): Promise<{ status: number; text: string }> {
  return send(harness.base, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": signWebhookBody(CLIENT_SECRET, body),
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-Topic": topic,
    },
    body,
  });
}
