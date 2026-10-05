import { isRecord } from "./json.js";

/** Shopify's documented retry guidance: wait one second, then try once more. */
export const SHOPIFY_BACKOFF_MS = 1000;

const GRAPHQL_TIMEOUT_MS = 30_000;

export type ShopifyCall =
  | { kind: "ok"; data: unknown }
  | { kind: "throttled" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

/** Admin order reads. Field-level protected-data denials keep the rest of the payload. */
export type OrderAdminCall =
  | { kind: "ok"; data: unknown }
  | { kind: "throttled" }
  | { kind: "reinstall" }
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

export async function orderAdminGraphql(args: GraphqlArgs): Promise<OrderAdminCall> {
  const first = await orderCallOnce(args);
  if (first.kind !== "throttled") {
    return first;
  }
  await args.sleep(SHOPIFY_BACKOFF_MS);
  return orderCallOnce(args);
}

type FetchedGraphql =
  | { kind: "throttled" }
  | { kind: "failed" }
  | { kind: "http"; status: number; ok: boolean; payload: unknown };

async function callOnce(args: GraphqlArgs): Promise<ShopifyCall> {
  const fetched = await fetchGraphql(args);
  if (fetched.kind !== "http") {
    return fetched;
  }
  if (isUnauthorized(fetched.status, fetched.payload)) {
    return { kind: "unauthorized" };
  }
  if (!fetched.ok || !isRecord(fetched.payload) || !isRecord(fetched.payload.data)) {
    return { kind: "failed" };
  }
  if (hasErrors(fetched.payload)) {
    return { kind: "failed" };
  }
  return { kind: "ok", data: fetched.payload.data };
}

async function orderCallOnce(args: GraphqlArgs): Promise<OrderAdminCall> {
  const fetched = await fetchGraphql(args);
  if (fetched.kind !== "http") {
    return fetched;
  }
  return classifyOrderPayload(fetched.status, fetched.payload);
}

async function fetchGraphql(args: GraphqlArgs): Promise<FetchedGraphql> {
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
  return { kind: "http", status: response.status, ok: response.ok, payload };
}

function classifyOrderPayload(status: number, payload: unknown): OrderAdminCall {
  if (status === 401 || hasRootAccessDenied(payload)) {
    return { kind: "reinstall" };
  }
  if (status < 200 || status >= 300 || !isRecord(payload) || !isRecord(payload.data)) {
    if (isRecord(payload) && hasAccessDenied(payload)) {
      return { kind: "reinstall" };
    }
    return { kind: "failed" };
  }
  if (!hasErrors(payload)) {
    return { kind: "ok", data: payload.data };
  }
  if (errorsAreFieldRedactions(payload.errors) && orderPayloadPopulated(payload.data)) {
    return { kind: "ok", data: payload.data };
  }
  if (hasAccessDenied(payload) && !orderPayloadPopulated(payload.data)) {
    return { kind: "reinstall" };
  }
  return { kind: "failed" };
}

function orderPayloadPopulated(data: Record<string, unknown>): boolean {
  if (isRecord(data.order)) {
    return true;
  }
  if (!isRecord(data.orders) || !Array.isArray(data.orders.nodes)) {
    return false;
  }
  return data.orders.nodes.some((node) => isRecord(node));
}

function hasRootAccessDenied(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) {
    return false;
  }
  return payload.errors.some((error) => {
    if (!isAccessDeniedError(error)) {
      return false;
    }
    return !isRecord(error) || !Array.isArray(error.path) || error.path.length < 2;
  });
}

function errorsAreFieldRedactions(errors: unknown): boolean {
  if (!Array.isArray(errors) || errors.length === 0) {
    return false;
  }
  return errors.every((error) => {
    if (!isAccessDeniedError(error) || !isRecord(error) || !Array.isArray(error.path) || error.path.length < 2) {
      return false;
    }
    const root = error.path[0];
    return root === "order" || root === "orders";
  });
}

function hasAccessDenied(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.errors) && payload.errors.some((error) => isAccessDeniedError(error));
}

function isAccessDeniedError(error: unknown): error is Record<string, unknown> {
  return isRecord(error) && isRecord(error.extensions) && error.extensions.code === "ACCESS_DENIED";
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
