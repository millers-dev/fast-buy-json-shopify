import { REFRESH_SKEW_MS } from "./commerce-token.js";
import { DELEGATE_DOCUMENT } from "./catalog-query.js";
import type { ConnectorDeps } from "./deps.js";
import { adminGraphqlUrl, defaultSleep, shopifyGraphql } from "./shopify-graphql.js";
import { isRecord } from "./json.js";
import { DECRYPT_DETAIL, ONE_SHOP_DETAIL, REINSTALL_DETAIL, internalError, rateLimited, type Problem } from "./problems.js";
import { SHOPIFY_SCOPES } from "./scopes.js";
import { TokenDecryptError } from "./token-store.js";

export type DelegateResult = { ok: true; token: string } | { ok: false; problem: Problem };

export async function ensureDelegateToken(deps: ConnectorDeps): Promise<DelegateResult> {
  return deps.tokens.exclusive(async () => mintOrReuse(deps));
}

async function mintOrReuse(deps: ConnectorDeps): Promise<DelegateResult> {
  const problem = installedProblem(deps);
  if (problem !== undefined) {
    return { ok: false, problem };
  }
  const row = deps.tokens.get();
  if (row === null || row.accessToken === null) {
    return { ok: false, problem: internalError(REINSTALL_DETAIL) };
  }
  try {
    const existing = deps.tokens.getDelegate();
    if (existing !== null && delegateUsable(existing.expiresAt, deps.now())) {
      return { ok: true, token: existing.accessToken };
    }
  } catch (error) {
    if (error instanceof TokenDecryptError) {
      return { ok: false, problem: internalError(DECRYPT_DETAIL) };
    }
    throw error;
  }
  const call = await shopifyGraphql({
    url: adminGraphqlUrl(deps.app.shopDomain, deps.app.apiVersion),
    tokenHeader: "X-Shopify-Access-Token",
    token: row.accessToken,
    query: DELEGATE_DOCUMENT,
    variables: { scopes: [...SHOPIFY_SCOPES] },
    fetch: deps.fetch,
    sleep: deps.sleep ?? defaultSleep,
  });
  if (call.kind === "throttled") {
    return { ok: false, problem: rateLimited() };
  }
  if (call.kind === "unauthorized") {
    deps.tokens.clearAccessToken(deps.app.shopDomain, deps.now());
    return { ok: false, problem: internalError(REINSTALL_DETAIL) };
  }
  if (call.kind !== "ok") {
    return { ok: false, problem: internalError("Storefront access could not be prepared.") };
  }
  const minted = readDelegate(call.data);
  if (minted === "user_error") {
    return { ok: false, problem: internalError(REINSTALL_DETAIL) };
  }
  if (minted === null) {
    return { ok: false, problem: internalError("Storefront access could not be prepared.") };
  }
  const expiresAt = delegateExpiry(minted.expiresIn, row.accessExpiresAt, deps.now());
  const saved = deps.tokens.saveDelegate(deps.app.shopDomain, minted.accessToken, expiresAt, deps.now());
  if (!saved) {
    return { ok: false, problem: internalError(ONE_SHOP_DETAIL) };
  }
  return { ok: true, token: minted.accessToken };
}

export function installedProblem(deps: ConnectorDeps): Problem | undefined {
  try {
    const row = deps.tokens.get();
    if (row === null || row.accessToken === null || row.shopDomain !== deps.app.shopDomain) {
      return internalError(REINSTALL_DETAIL);
    }
    return undefined;
  } catch (error) {
    if (error instanceof TokenDecryptError) {
      return internalError(DECRYPT_DETAIL);
    }
    throw error;
  }
}

function delegateUsable(expiresAt: number | null, now: number): boolean {
  if (expiresAt === null) {
    return true;
  }
  return now < expiresAt - REFRESH_SKEW_MS;
}

function delegateExpiry(expiresIn: number | null, parentExpiresAt: number | null, now: number): number | null {
  const fromToken = expiresIn === null ? null : now + expiresIn * 1000;
  if (fromToken === null) {
    return parentExpiresAt;
  }
  if (parentExpiresAt === null) {
    return fromToken;
  }
  return Math.min(fromToken, parentExpiresAt);
}

function readDelegate(data: unknown): { accessToken: string; expiresIn: number | null } | "user_error" | null {
  if (!isRecord(data)) {
    return null;
  }
  const payload = data.delegateAccessTokenCreate;
  if (!isRecord(payload)) {
    return null;
  }
  if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
    return "user_error";
  }
  const token = payload.delegateAccessToken;
  if (!isRecord(token) || typeof token.accessToken !== "string" || token.accessToken === "") {
    return null;
  }
  if (token.expiresIn === undefined || token.expiresIn === null) {
    return { accessToken: token.accessToken, expiresIn: null };
  }
  if (typeof token.expiresIn !== "number" || !Number.isInteger(token.expiresIn) || token.expiresIn <= 0) {
    return null;
  }
  return { accessToken: token.accessToken, expiresIn: token.expiresIn };
}
