import { SHOPIFY_SCOPE_PARAM, hasRequiredScopes } from "./scopes.js";

const TOKEN_TIMEOUT_MS = 30_000;

export type AcquiredToken = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
};

export type TokenRequestResult =
  | { ok: true; token: AcquiredToken }
  | { ok: false; status: number | null };

type TokenRequest = {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  body: URLSearchParams;
  now: number;
  fetch: typeof fetch;
  requireRefreshToken: boolean;
  requireAccessExpiry: boolean;
};

export function authorizeUrl(shopDomain: string, clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SHOPIFY_SCOPE_PARAM);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export function tokenEndpoint(shopDomain: string): string {
  return `https://${shopDomain}/admin/oauth/access_token`;
}

export function requestAuthorizationCode(
  args: Omit<TokenRequest, "body" | "requireRefreshToken" | "requireAccessExpiry"> & { code: string },
): Promise<TokenRequestResult> {
  return postToken({
    ...args,
    requireRefreshToken: false,
    requireAccessExpiry: false,
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      expiring: "1",
    }),
  });
}

export function requestClientCredentials(
  args: Omit<TokenRequest, "body" | "requireRefreshToken" | "requireAccessExpiry">,
): Promise<TokenRequestResult> {
  return postToken({
    ...args,
    requireRefreshToken: false,
    requireAccessExpiry: true,
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }),
  });
}

export function requestRefresh(
  args: Omit<TokenRequest, "body" | "requireRefreshToken" | "requireAccessExpiry"> & { refreshToken: string },
): Promise<TokenRequestResult> {
  return postToken({
    ...args,
    requireRefreshToken: true,
    requireAccessExpiry: true,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
    }),
  });
}

async function postToken(args: TokenRequest): Promise<TokenRequestResult> {
  let response: Response;
  try {
    response = await args.fetch(tokenEndpoint(args.shopDomain), {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: args.body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: null };
  }
  if (!response.ok) {
    await discardBody(response);
    return { ok: false, status: response.status };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: response.status };
  }
  const token = readAcquiredToken(payload, args.now, args.requireRefreshToken, args.requireAccessExpiry);
  if (token === null) {
    return { ok: false, status: response.status };
  }
  return { ok: true, token };
}

function readAcquiredToken(
  payload: unknown,
  now: number,
  requireRefreshToken: boolean,
  requireAccessExpiry: boolean,
): AcquiredToken | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    refresh_token_expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof record.access_token !== "string" || record.access_token === "") {
    return null;
  }
  if (typeof record.scope !== "string" || !hasRequiredScopes(record.scope)) {
    return null;
  }
  const accessExpiresAt = readExpiry(record.expires_in, now);
  if (accessExpiresAt === "invalid" || (requireAccessExpiry && accessExpiresAt === null)) {
    return null;
  }
  const refresh = readRefresh(record.refresh_token, record.refresh_token_expires_in, now, requireRefreshToken);
  if (refresh === "invalid") {
    return null;
  }
  return {
    accessToken: record.access_token,
    accessExpiresAt,
    refreshToken: refresh === null ? null : refresh.token,
    refreshExpiresAt: refresh === null ? null : refresh.expiresAt,
  };
}

function readRefresh(
  token: unknown,
  expiresIn: unknown,
  now: number,
  required: boolean,
): { token: string; expiresAt: number | null } | null | "invalid" {
  if (token === undefined || token === null) {
    return required ? "invalid" : null;
  }
  if (typeof token !== "string" || token === "") {
    return "invalid";
  }
  const expiresAt = readExpiry(expiresIn, now);
  if (expiresAt === "invalid") {
    return "invalid";
  }
  return { token, expiresAt };
}

function readExpiry(value: unknown, now: number): number | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "invalid";
  }
  return now + value * 1000;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already the result. The body is not copied into errors or logs.
  }
}
