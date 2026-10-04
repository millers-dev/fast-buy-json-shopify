import type { IncomingMessage, ServerResponse } from "node:http";

import { normalizeShopDomain } from "./config.js";
import type { ConnectorDeps } from "./deps.js";
import { verifyOauthHmac, verifyWebhookHmac } from "./shopify-hmac.js";
import { authorizeUrl, requestAuthorizationCode } from "./shopify-token.js";
import { OneShopError } from "./token-store.js";
import { writeJson } from "./http-response.js";

export const AUTH_PATH = "/api/shopify/auth";
export const AUTH_CALLBACK_PATH = "/api/shopify/auth/callback";
export const WEBHOOK_PATH = "/api/shopify/webhooks";

const BODY_LIMIT = 1_000_000;

const WEBHOOK_TOPICS = [
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

const TOPIC_BY_PATH: Record<string, WebhookTopic | "header"> = {
  [WEBHOOK_PATH]: "header",
  [`${WEBHOOK_PATH}/app/uninstalled`]: "app/uninstalled",
  [`${WEBHOOK_PATH}/customers/data_request`]: "customers/data_request",
  [`${WEBHOOK_PATH}/customers/redact`]: "customers/redact",
  [`${WEBHOOK_PATH}/shop/redact`]: "shop/redact",
};

export function isWebhookPath(pathname: string): boolean {
  return Object.hasOwn(TOPIC_BY_PATH, pathname);
}

export function oauthCallbackUrl(appUrl: string): string {
  return `${appUrl}${AUTH_CALLBACK_PATH}`;
}

export async function handleAuthStart(res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  if (deps.app.appUrl === undefined) {
    writeJson(res, 400, { error: "app_url_required" }, noStore);
    return;
  }
  const state = deps.oauthState.issue(deps.app.shopDomain, deps.now());
  const location = authorizeUrl(
    deps.app.shopDomain,
    deps.app.clientId,
    oauthCallbackUrl(deps.app.appUrl),
    state,
  );
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

export async function handleAuthCallback(
  res: ServerResponse,
  url: URL,
  deps: ConnectorDeps,
): Promise<void> {
  const params = readQuery(url);
  if (params === null) {
    writeJson(res, 400, { error: "invalid_oauth_callback" }, noStore);
    return;
  }
  if (!verifyOauthHmac(deps.app.clientSecret, params)) {
    writeJson(res, 401, { error: "invalid_hmac" }, noStore);
    return;
  }
  const shop = params.get("shop");
  const state = params.get("state");
  const code = params.get("code");
  if (shop === undefined || state === undefined || code === undefined || code === "") {
    writeJson(res, 400, { error: "invalid_oauth_callback" }, noStore);
    return;
  }
  let normalizedShop: string;
  try {
    normalizedShop = normalizeShopDomain(shop);
  } catch {
    writeJson(res, 400, { error: "invalid_oauth_callback" }, noStore);
    return;
  }
  if (normalizedShop !== deps.app.shopDomain) {
    writeJson(res, 400, { error: "invalid_oauth_callback" }, noStore);
    return;
  }
  if (!deps.oauthState.consume(state, deps.app.shopDomain, deps.now())) {
    writeJson(res, 400, { error: "invalid_oauth_callback" }, noStore);
    return;
  }
  const installed = await deps.tokens.exclusive(() => installAuthorizationCode(deps, code));
  switch (installed) {
    case "saved":
      writeJson(res, 200, { installed: true, shop: deps.app.shopDomain }, noStore);
      return;
    case "exchange_failed":
      writeJson(res, 502, { error: "token_exchange_failed" }, noStore);
      return;
    case "one_shop":
      writeJson(res, 409, { error: "one_shop" }, noStore);
      return;
    default: {
      const neverInstalled: never = installed;
      throw new Error(`Unhandled install result: ${String(neverInstalled)}`);
    }
  }
}

type InstallResult = "saved" | "exchange_failed" | "one_shop";

async function installAuthorizationCode(deps: ConnectorDeps, code: string): Promise<InstallResult> {
  const exchanged = await requestAuthorizationCode({
    shopDomain: deps.app.shopDomain,
    clientId: deps.app.clientId,
    clientSecret: deps.app.clientSecret,
    code,
    now: deps.now(),
    fetch: deps.fetch,
  });
  if (!exchanged.ok) {
    return "exchange_failed";
  }
  try {
    deps.tokens.save(
      {
        shopDomain: deps.app.shopDomain,
        grantType: "authorization_code",
        accessToken: exchanged.token.accessToken,
        accessExpiresAt: exchanged.token.accessExpiresAt,
        refreshToken: exchanged.token.refreshToken,
        refreshExpiresAt: exchanged.token.refreshExpiresAt,
      },
      deps.now(),
    );
  } catch (error) {
    if (error instanceof OneShopError) {
      return "one_shop";
    }
    throw error;
  }
  return "saved";
}

export async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ConnectorDeps,
): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST", "Cache-Control": "no-store" });
    return;
  }
  let body: Buffer;
  try {
    body = await readRawBody(req);
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) {
      writeJson(res, 413, { error: "payload_too_large" }, noStore);
      return;
    }
    throw error;
  }
  const provided = headerValue(req, "x-shopify-hmac-sha256");
  if (provided === undefined || !verifyWebhookHmac(deps.app.clientSecret, body, provided)) {
    writeJson(res, 401, { error: "invalid_hmac" }, noStore);
    return;
  }
  const topic = resolveTopic(pathname, headerValue(req, "x-shopify-topic"));
  if (topic === null) {
    writeJson(res, 400, { error: "invalid_webhook" }, noStore);
    return;
  }
  const shopHeader = headerValue(req, "x-shopify-shop-domain");
  if (shopHeader === undefined || !shopHeaderMatches(shopHeader, deps.app.shopDomain)) {
    writeJson(res, 400, { error: "invalid_webhook" }, noStore);
    return;
  }
  await deps.tokens.exclusive(async () => {
    if (webhookDeletesShop(topic)) {
      deps.tokens.deleteShop(deps.app.shopDomain);
    }
  });
  writeJson(res, 200, { ok: true }, noStore);
}

function webhookDeletesShop(topic: WebhookTopic): boolean {
  switch (topic) {
    case "app/uninstalled":
    case "shop/redact":
      return true;
    case "customers/data_request":
    case "customers/redact":
      return false;
    default: {
      const neverTopic: never = topic;
      throw new Error(`Unhandled webhook topic: ${String(neverTopic)}`);
    }
  }
}

function resolveTopic(pathname: string, header: string | undefined): WebhookTopic | null {
  const mapped = TOPIC_BY_PATH[pathname];
  if (mapped === undefined) {
    return null;
  }
  if (mapped === "header") {
    return header !== undefined && isWebhookTopic(header) ? header : null;
  }
  if (header !== undefined && header !== mapped) {
    return null;
  }
  return mapped;
}

function isWebhookTopic(value: string): value is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly string[]).includes(value);
}

function readQuery(url: URL): Map<string, string> | null {
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (params.has(key)) {
      return null;
    }
    params.set(key, value);
  }
  return params;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function shopHeaderMatches(header: string, shopDomain: string): boolean {
  try {
    return normalizeShopDomain(header) === shopDomain;
  } catch {
    return false;
  }
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      fn();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        req.destroy();
        finish(() => {
          reject(new WebhookBodyTooLargeError());
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finish(() => {
        resolve(Buffer.concat(chunks));
      });
    };
    const onError = (error: Error) => {
      finish(() => {
        reject(error);
      });
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

class WebhookBodyTooLargeError extends Error {
  constructor() {
    super("webhook body is too large");
    this.name = "WebhookBodyTooLargeError";
  }
}
