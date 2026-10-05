import { createHash } from "node:crypto";

/** Contract retention for a stored 2xx Idempotency-Key. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Buyer identity for this connector. Bearer tokens are ignored. */
export const ANONYMOUS_SCOPE = "anonymous";

/** Route path inside `/api/fastbuyjson`, matching the contract fingerprint. */
export const CART_ADD_ROUTE = "/cart/add";

/** Route paths inside `/api/fastbuyjson`, matching the contract fingerprint. */
export const CHECKOUT_INITIATE_ROUTE = "/checkout/initiate";
export const CHECKOUT_CONFIRM_ROUTE = "/checkout/confirm";

export function canonicalJson(body: unknown): string {
  if (body === undefined || body === null) {
    return stableStringify({});
  }
  return stableStringify(body);
}

export function computeIdempotencyFingerprint(method: string, routePath: string, body: unknown): string {
  const payload = `${method}\n${routePath}\n${canonicalJson(body)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
