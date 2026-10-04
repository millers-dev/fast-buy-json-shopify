import { DECRYPT_DETAIL, ONE_SHOP_DETAIL, REINSTALL_DETAIL } from "./problems.js";
import { requestClientCredentials, requestRefresh } from "./shopify-token.js";
import { OneShopError, TokenDecryptError, type ShopTokenRecord } from "./token-store.js";
import type { ConnectorDeps } from "./deps.js";

export const REFRESH_SKEW_MS = 60_000;

export type CommerceAccess =
  | { kind: "ready" }
  | { kind: "unavailable"; detail: string };

export function needsRefresh(row: ShopTokenRecord, now: number): boolean {
  if (row.accessToken === null) {
    return true;
  }
  if (row.accessExpiresAt === null) {
    return false;
  }
  return now >= row.accessExpiresAt - REFRESH_SKEW_MS;
}

export async function prepareCommerceAccess(deps: ConnectorDeps): Promise<CommerceAccess> {
  return deps.tokens.exclusive(async () => prepareLocked(deps));
}

export async function ensureClientCredentials(
  deps: ConnectorDeps,
): Promise<{ ok: true } | { ok: false; reason: "request_failed" | "one_shop" | "decrypt" }> {
  return deps.tokens.exclusive(async () => {
    let row: ShopTokenRecord | null;
    try {
      row = deps.tokens.get();
    } catch (error) {
      if (error instanceof TokenDecryptError) {
        return { ok: false, reason: "decrypt" };
      }
      throw error;
    }
    if (row !== null && row.shopDomain !== deps.app.shopDomain) {
      return { ok: false, reason: "one_shop" };
    }
    if (row !== null && row.grantType === "client_credentials" && !needsRefresh(row, deps.now())) {
      return { ok: true };
    }
    const acquired = await requestClientCredentials({
      shopDomain: deps.app.shopDomain,
      clientId: deps.app.clientId,
      clientSecret: deps.app.clientSecret,
      now: deps.now(),
      fetch: deps.fetch,
    });
    if (!acquired.ok) {
      if (row !== null && needsRefresh(row, deps.now())) {
        deps.tokens.clearAccessToken(row.shopDomain, deps.now());
      }
      return { ok: false, reason: "request_failed" };
    }
    try {
      deps.tokens.save(
        {
          shopDomain: deps.app.shopDomain,
          grantType: "client_credentials",
          accessToken: acquired.token.accessToken,
          accessExpiresAt: acquired.token.accessExpiresAt,
          refreshToken: null,
          refreshExpiresAt: null,
        },
        deps.now(),
      );
    } catch (error) {
      if (error instanceof OneShopError) {
        return { ok: false, reason: "one_shop" };
      }
      throw error;
    }
    return { ok: true };
  });
}

async function prepareLocked(deps: ConnectorDeps): Promise<CommerceAccess> {
  let row: ShopTokenRecord | null;
  try {
    row = deps.tokens.get();
  } catch (error) {
    if (error instanceof TokenDecryptError) {
      return { kind: "unavailable", detail: DECRYPT_DETAIL };
    }
    throw error;
  }
  if (row === null) {
    return { kind: "ready" };
  }
  if (row.shopDomain !== deps.app.shopDomain) {
    return { kind: "unavailable", detail: ONE_SHOP_DETAIL };
  }
  if (!needsRefresh(row, deps.now())) {
    return { kind: "ready" };
  }
  const renewed = await renewToken(deps, row);
  if (!renewed) {
    return { kind: "unavailable", detail: REINSTALL_DETAIL };
  }
  return { kind: "ready" };
}

async function renewToken(deps: ConnectorDeps, row: ShopTokenRecord): Promise<boolean> {
  switch (row.grantType) {
    case "client_credentials":
      return renewClientCredentials(deps, row);
    case "authorization_code":
      return renewAuthorizationCode(deps, row);
    default: {
      const neverGrant: never = row.grantType;
      throw new Error(`Unhandled grant: ${String(neverGrant)}`);
    }
  }
}

async function renewClientCredentials(deps: ConnectorDeps, row: ShopTokenRecord): Promise<boolean> {
  const acquired = await requestClientCredentials({
    shopDomain: deps.app.shopDomain,
    clientId: deps.app.clientId,
    clientSecret: deps.app.clientSecret,
    now: deps.now(),
    fetch: deps.fetch,
  });
  if (!acquired.ok) {
    deps.tokens.clearAccessToken(row.shopDomain, deps.now());
    return false;
  }
  return storeRenewed(deps, "client_credentials", acquired.token.accessToken, acquired.token.accessExpiresAt, null, null);
}

async function renewAuthorizationCode(deps: ConnectorDeps, row: ShopTokenRecord): Promise<boolean> {
  if (row.refreshToken === null) {
    deps.tokens.clearAccessToken(row.shopDomain, deps.now());
    return false;
  }
  const acquired = await requestRefresh({
    shopDomain: deps.app.shopDomain,
    clientId: deps.app.clientId,
    clientSecret: deps.app.clientSecret,
    refreshToken: row.refreshToken,
    now: deps.now(),
    fetch: deps.fetch,
  });
  if (!acquired.ok) {
    deps.tokens.clearAccessToken(row.shopDomain, deps.now());
    if (acquired.status === 401) {
      deps.tokens.clearRefreshToken(row.shopDomain, deps.now());
    }
    return false;
  }
  return storeRenewed(
    deps,
    "authorization_code",
    acquired.token.accessToken,
    acquired.token.accessExpiresAt,
    acquired.token.refreshToken,
    acquired.token.refreshExpiresAt,
  );
}

function storeRenewed(
  deps: ConnectorDeps,
  grantType: ShopTokenRecord["grantType"],
  accessToken: string,
  accessExpiresAt: number | null,
  refreshToken: string | null,
  refreshExpiresAt: number | null,
): boolean {
  try {
    deps.tokens.save(
      {
        shopDomain: deps.app.shopDomain,
        grantType,
        accessToken,
        accessExpiresAt,
        refreshToken,
        refreshExpiresAt,
      },
      deps.now(),
    );
  } catch (error) {
    if (error instanceof OneShopError) {
      return false;
    }
    throw error;
  }
  return true;
}
