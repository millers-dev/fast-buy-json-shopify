import { SHOPIFY_API_VERSION } from "./api-version.js";
import {
  CUSTOMER_AUTHORIZE_SCOPE,
  acceptedCustomerGid,
  codeChallengeS256,
} from "./customer-login-crypto.js";
import { isRecord } from "./json.js";
import { readPackageMetadata } from "./version.js";

const REQUEST_TIMEOUT_MS = 30_000;

export const CUSTOMER_USER_AGENT = `fast-buy-json-shopify/${readPackageMetadata().version}`;

export type CustomerDiscovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  graphqlApi: string;
};

export function customerCallbackUrl(appUrl: string): string {
  return `${appUrl}/api/fastbuyjson/auth/customer/callback`;
}

export function customerAuthorizeUrl(args: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}): string {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", CUSTOMER_AUTHORIZE_SCOPE);
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.nonce);
  url.searchParams.set("code_challenge", codeChallengeS256(args.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function discoverCustomerAccounts(
  shopDomain: string,
  fetchImpl: typeof fetch,
): Promise<CustomerDiscovery | null> {
  const openidUrl = `https://${shopDomain}/.well-known/openid-configuration`;
  const apiUrl = `https://${shopDomain}/.well-known/customer-account-api`;
  let openid: Response;
  let api: Response;
  try {
    [openid, api] = await Promise.all([
      fetchImpl(openidUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      fetchImpl(apiUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ]);
  } catch {
    return null;
  }
  if (!openid.ok || !api.ok) {
    await discard(openid);
    await discard(api);
    return null;
  }
  let openidBody: unknown;
  let apiBody: unknown;
  try {
    openidBody = await openid.json();
    apiBody = await api.json();
  } catch {
    return null;
  }
  return parseDiscovery(openidBody, apiBody);
}

export type CustomerTokenExchange =
  | { ok: true; accessToken: string; expiresIn: number; idToken: string }
  | { ok: false; kind: "misconfigured" | "invalid" };

export async function exchangeCustomerCode(args: {
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  origin: string;
  fetchImpl: typeof fetch;
}): Promise<CustomerTokenExchange> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": CUSTOMER_USER_AGENT,
        Origin: args.origin,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: args.clientId,
        redirect_uri: args.redirectUri,
        code: args.code,
        code_verifier: args.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "invalid" };
  }
  if (response.status === 403 || (response.status === 401 && wwwAuthenticateSaysInvalidToken(response))) {
    await discard(response);
    return { ok: false, kind: "misconfigured" };
  }
  if (!response.ok) {
    await discard(response);
    return { ok: false, kind: "invalid" };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "invalid" };
  }
  const token = readCustomerToken(payload);
  if (token === null) {
    return { ok: false, kind: "invalid" };
  }
  return { ok: true, ...token };
}

export async function fetchCustomerId(args: {
  graphqlApi: string;
  accessToken: string;
  origin: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.graphqlApi, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": CUSTOMER_USER_AGENT,
        Origin: args.origin,
        // Customer Account API 2026-10 sends the customer access token itself, not Bearer.
        Authorization: args.accessToken,
      },
      body: JSON.stringify({ query: "query { customer { id } }" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await discard(response);
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.customer)) {
    return null;
  }
  const id = payload.data.customer.id;
  if (typeof id !== "string" || !acceptedCustomerGid(id)) {
    return null;
  }
  return id;
}

export function pinCustomerGraphqlUrl(graphqlApi: string): string | null {
  const url = httpsUrl(graphqlApi);
  if (url === null) {
    return null;
  }
  if (!/^\/customer\/api\/[^/]+\/graphql\/?$/.test(url.pathname)) {
    return null;
  }
  url.pathname = `/customer/api/${SHOPIFY_API_VERSION}/graphql`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseDiscovery(openidBody: unknown, apiBody: unknown): CustomerDiscovery | null {
  if (!isRecord(openidBody) || !isRecord(apiBody)) {
    return null;
  }
  const authorizationEndpoint = httpsUrl(openidBody.authorization_endpoint)?.toString() ?? null;
  const tokenEndpoint = httpsUrl(openidBody.token_endpoint)?.toString() ?? null;
  const graphqlApi = typeof apiBody.graphql_api === "string" ? pinCustomerGraphqlUrl(apiBody.graphql_api) : null;
  if (authorizationEndpoint === null || tokenEndpoint === null || graphqlApi === null) {
    return null;
  }
  return { authorizationEndpoint, tokenEndpoint, graphqlApi };
}

function readCustomerToken(payload: unknown): { accessToken: string; expiresIn: number; idToken: string } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  const idToken = payload.id_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    return null;
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }
  if (typeof idToken !== "string" || idToken === "") {
    return null;
  }
  return { accessToken, expiresIn, idToken };
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url;
}

function wwwAuthenticateSaysInvalidToken(response: Response): boolean {
  const header = response.headers.get("www-authenticate");
  return header !== null && header.toLowerCase().includes("invalid_token");
}

async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The status was already read. A body error does not change the outcome.
  }
}
