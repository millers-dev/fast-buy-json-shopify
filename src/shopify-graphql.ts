import { isRecord } from "./json.js";

/** Shopify's documented retry guidance: wait one second, then try once more. */
export const SHOPIFY_BACKOFF_MS = 1000;

const GRAPHQL_TIMEOUT_MS = 30_000;

export type ShopifyCall =
  | { kind: "ok"; data: unknown }
  | { kind: "throttled" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

export function adminGraphqlUrl(shopDomain: string, apiVersion: string): string {
  return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
}

export function storefrontGraphqlUrl(shopDomain: string, apiVersion: string): string {
  return `https://${shopDomain}/api/${apiVersion}/graphql.json`;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type GraphqlArgs = {
  url: string;
  tokenHeader: "X-Shopify-Access-Token" | "Shopify-Storefront-Private-Token";
  token: string;
  query: string;
  variables: Record<string, unknown>;
  buyerIp?: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

export async function shopifyGraphql(args: GraphqlArgs): Promise<ShopifyCall> {
  const first = await callOnce(args);
  if (first.kind !== "throttled") {
    return first;
  }
  await args.sleep(SHOPIFY_BACKOFF_MS);
  return callOnce(args);
}

async function callOnce(args: GraphqlArgs): Promise<ShopifyCall> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    [args.tokenHeader]: args.token,
  };
  if (args.tokenHeader === "Shopify-Storefront-Private-Token" && args.buyerIp !== undefined) {
    headers["Shopify-Storefront-Buyer-IP"] = args.buyerIp;
  }
  let response: Response;
  try {
    response = await args.fetch(args.url, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({ query: args.query, variables: args.variables }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
  } catch {
    return { kind: "failed" };
  }
  const payload = await readPayload(response);
  if (isThrottled(response.status, payload)) {
    return { kind: "throttled" };
  }
  if (isUnauthorized(response.status, payload)) {
    return { kind: "unauthorized" };
  }
  if (!response.ok || !isRecord(payload) || !isRecord(payload.data)) {
    return { kind: "failed" };
  }
  if (hasErrors(payload)) {
    return { kind: "failed" };
  }
  return { kind: "ok", data: payload.data };
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isThrottled(status: number, payload: unknown): boolean {
  if (status === 429) {
    return true;
  }
  return errorCode(payload) === "THROTTLED";
}

function isUnauthorized(status: number, payload: unknown): boolean {
  if (status === 401) {
    return true;
  }
  return errorCode(payload) === "ACCESS_DENIED";
}

function hasErrors(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.errors) && payload.errors.length > 0;
}

function errorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) {
    return undefined;
  }
  for (const error of payload.errors) {
    if (!isRecord(error) || !isRecord(error.extensions)) {
      continue;
    }
    if (typeof error.extensions.code === "string") {
      return error.extensions.code;
    }
  }
  return undefined;
}
