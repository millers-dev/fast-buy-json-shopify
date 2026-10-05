import type { IncomingMessage, ServerResponse } from "node:http";

import { publicBuyerIp } from "./buyer-ip.js";
import { commerceReady, storefront, withCartLock } from "./cart.js";
import { SHOP_CURRENCY_DOCUMENT } from "./catalog-query.js";
import { MAX_DELIVERY_GROUP_PAGES, readDeliveryGroupPage } from "./delivery-groups.js";
import type { ConnectorDeps } from "./deps.js";
import { writeJson, writeProblem } from "./http-response.js";
import { isRecord } from "./json.js";
import { moneyAmount } from "./money.js";
import { DECRYPT_DETAIL, internalError, rateLimited, validationError, type Problem } from "./problems.js";
import { RequestBodyTooLargeError, readRequestBody } from "./read-body.js";
import { CART_SHIPPING_OPTIONS_DOCUMENT } from "./shipping-query.js";
import { TokenDecryptError } from "./token-store.js";

const OPTIONS_PATH = "/api/fastbuyjson/shipping/options";
const NO_STORE = "no-store";

type ShippingResult = { kind: "json"; status: number; body: unknown } | { kind: "problem"; problem: Problem };

type CallFailure = "throttled" | "unauthorized" | "failed";

type CartLoad =
  | { kind: "cart"; currency: string; options: Record<string, unknown>[] }
  | { kind: "gone" }
  | { kind: "invalid" }
  | { kind: CallFailure };

type DayBounds = {
  minDays: number;
  maxDays: number;
};

type PublicOption = {
  id: string;
  label: string;
  amount: { amount: number; currency: string };
  estimatedDelivery: DayBounds;
  description?: string;
};

export type ShippingMatch = { kind: "options" };

export function matchShippingRequest(
  method: string,
  pathname: string,
): { match: ShippingMatch } | { match: "not-allowed"; allow: string } | { match: "ignore" } {
  if (pathname !== OPTIONS_PATH) {
    return { match: "ignore" };
  }
  return method === "GET" ? { match: { kind: "options" } } : { match: "not-allowed", allow: "GET" };
}

export async function handleShipping(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  const drained = await drainBody(req);
  if (drained !== undefined) {
    writeProblem(res, drained);
    return;
  }
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      const result = await loadOptions(deps, buyerIp);
      writeResult(res, result);
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

/**
 * Map Storefront delivery options onto the shipping-options response.
 * `omittedOptionCount` is omitted when nothing was skipped.
 * A repeated handle is kept only for the first option that can be included, and that duplicate is not counted as omitted.
 */
export function shippingOptionsBody(currency: string, options: readonly Record<string, unknown>[]): Record<string, unknown> {
  const mapped = mapDeliveryOptions(options);
  const body: Record<string, unknown> = {
    currency,
    options: mapped.options,
  };
  if (mapped.omittedOptionCount > 0) {
    body.omittedOptionCount = mapped.omittedOptionCount;
  }
  return body;
}

async function loadOptions(deps: ConnectorDeps, buyerIp: string | undefined): Promise<ShippingResult> {
  const ready = await commerceReady(deps);
  if (!ready.ok) {
    return { kind: "problem", problem: ready.problem };
  }
  const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
  if (stored === null) {
    return shopOptions(deps, ready.token, buyerIp);
  }
  const loaded = await loadCartOptions(deps, ready.token, buyerIp, stored.shopifyCartId);
  switch (loaded.kind) {
    case "cart":
      return { kind: "json", status: 200, body: shippingOptionsBody(loaded.currency, loaded.options) };
    case "gone":
      return shopOptions(deps, ready.token, buyerIp);
    case "invalid":
      return { kind: "problem", problem: internalError("The shipping request could not be completed.") };
    case "throttled":
    case "unauthorized":
    case "failed":
      return callFailure(deps, loaded.kind);
    default: {
      const neverLoaded: never = loaded;
      return { kind: "problem", problem: internalError(`The shipping request could not be completed (${String(neverLoaded)}).`) };
    }
  }
}

async function loadCartOptions(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  shopifyCartId: string,
): Promise<CartLoad> {
  const groups: Record<string, unknown>[][] = [];
  let currency: string | null = null;
  let after: string | null = null;
  for (let page = 0; page < MAX_DELIVERY_GROUP_PAGES; page += 1) {
    const call = await storefront(deps, token, buyerIp, CART_SHIPPING_OPTIONS_DOCUMENT, {
      id: shopifyCartId,
      after,
    });
    if (call.kind !== "ok") {
      return { kind: call.kind };
    }
    const parsed = readDeliveryGroupPage(call.data, readShippingGroup);
    switch (parsed.kind) {
      case "gone":
        return { kind: "gone" };
      case "invalid":
        return { kind: "invalid" };
      case "missing": {
        const code = parsed.cart === null ? null : readCartCurrency(parsed.cart);
        if (code === null) {
          return { kind: "invalid" };
        }
        return { kind: "cart", currency: code, options: [] };
      }
      case "ok": {
        const code = readCartCurrency(parsed.cart);
        if (code === null) {
          return { kind: "invalid" };
        }
        currency = code;
        groups.push(...parsed.groups);
        if (!parsed.hasNextPage || parsed.endCursor === null) {
          return { kind: "cart", currency, options: groups.flat() };
        }
        after = parsed.endCursor;
        break;
      }
      default: {
        const neverPage: never = parsed;
        throw new Error(`Unhandled delivery group page: ${String(neverPage)}`);
      }
    }
  }
  if (currency === null) {
    return { kind: "invalid" };
  }
  return { kind: "cart", currency, options: groups.flat() };
}

async function shopOptions(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
): Promise<ShippingResult> {
  const call = await storefront(deps, token, buyerIp, SHOP_CURRENCY_DOCUMENT, {});
  if (call.kind !== "ok") {
    return callFailure(deps, call.kind);
  }
  const currency = readShopCurrency(call.data);
  if (currency === null) {
    return { kind: "problem", problem: internalError("The shipping request could not be completed.") };
  }
  return { kind: "json", status: 200, body: shippingOptionsBody(currency, []) };
}

function mapDeliveryOptions(options: readonly Record<string, unknown>[]): {
  options: PublicOption[];
  omittedOptionCount: number;
} {
  const published: PublicOption[] = [];
  const seen = new Set<string>();
  let omittedOptionCount = 0;
  for (const option of options) {
    const days = readDayBounds(option);
    const mapped = days === null ? null : toPublicOption(option, days);
    if (mapped === null) {
      omittedOptionCount += 1;
      continue;
    }
    if (seen.has(mapped.id)) {
      continue;
    }
    seen.add(mapped.id);
    published.push(mapped);
  }
  return { options: published, omittedOptionCount };
}

function toPublicOption(option: Record<string, unknown>, days: DayBounds): PublicOption | null {
  if (typeof option.handle !== "string" || option.handle === "" || typeof option.title !== "string") {
    return null;
  }
  const amount = readCost(option.estimatedCost);
  if (amount === null) {
    return null;
  }
  const mapped: PublicOption = {
    id: option.handle,
    label: option.title,
    amount,
    estimatedDelivery: { minDays: days.minDays, maxDays: days.maxDays },
  };
  if (typeof option.description === "string" && option.description !== "") {
    mapped.description = option.description;
  }
  return mapped;
}

/**
 * Integer day bounds already present on the option or one nested object.
 * 2026-10 does not select a field that provides them. Dates, titles, and descriptions are not converted.
 */
function readDayBounds(option: Record<string, unknown>): DayBounds | null {
  const direct = integerPair(option.minDays, option.maxDays);
  if (direct !== null) {
    return direct;
  }
  for (const value of Object.values(option)) {
    if (!isRecord(value)) {
      continue;
    }
    const nested = integerPair(value.minDays, value.maxDays);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function integerPair(minDays: unknown, maxDays: unknown): DayBounds | null {
  if (!isDayCount(minDays) || !isDayCount(maxDays)) {
    return null;
  }
  return { minDays, maxDays };
}

function isDayCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readShippingGroup(value: unknown): Record<string, unknown>[] | null {
  if (!isRecord(value) || !Array.isArray(value.deliveryOptions)) {
    return null;
  }
  const options: Record<string, unknown>[] = [];
  for (const option of value.deliveryOptions) {
    if (!isRecord(option) || typeof option.handle !== "string" || option.handle === "") {
      return null;
    }
    options.push(option);
  }
  return options;
}

function readCartCurrency(cart: Record<string, unknown>): string | null {
  if (!isRecord(cart.cost) || !isRecord(cart.cost.totalAmount)) {
    return null;
  }
  return currencyCode(cart.cost.totalAmount.currencyCode);
}

function readShopCurrency(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.shop) || !isRecord(data.shop.paymentSettings)) {
    return null;
  }
  return currencyCode(data.shop.paymentSettings.currencyCode);
}

function readCost(value: unknown): { amount: number; currency: string } | null {
  if (!isRecord(value) || typeof value.amount !== "string") {
    return null;
  }
  const currency = currencyCode(value.currencyCode);
  if (currency === null) {
    return null;
  }
  const amount = moneyAmount(value.amount, currency);
  if (amount === null) {
    return null;
  }
  return { amount, currency };
}

function currencyCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toUpperCase();
  return code === "" ? null : code;
}

async function callFailure(deps: ConnectorDeps, kind: CallFailure): Promise<ShippingResult> {
  switch (kind) {
    case "throttled":
      return { kind: "problem", problem: rateLimited("Shopify throttled the shipping request.") };
    case "unauthorized":
      await deps.tokens.exclusive(async () => {
        deps.tokens.clearDelegate(deps.app.shopDomain, deps.now());
      });
      return { kind: "problem", problem: internalError("The shipping request could not be completed.") };
    case "failed":
      return { kind: "problem", problem: internalError("The shipping request could not be completed.") };
    default: {
      const neverKind: never = kind;
      return { kind: "problem", problem: internalError(`The shipping request could not be completed (${String(neverKind)}).`) };
    }
  }
}

async function drainBody(req: IncomingMessage): Promise<Problem | undefined> {
  try {
    await readRequestBody(req);
    return undefined;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return validationError("The request body is too large.");
    }
    throw error;
  }
}

function writeResult(res: ServerResponse, result: ShippingResult): void {
  if (result.kind === "problem") {
    writeProblem(res, result.problem);
    return;
  }
  if (responseLeaks(result.body)) {
    writeProblem(res, internalError("The shipping request could not be completed."));
    return;
  }
  writeJson(res, result.status, result.body, { "Cache-Control": NO_STORE });
}

function responseLeaks(body: unknown): boolean {
  const text = JSON.stringify(body);
  return (
    text.includes("key=") ||
    text.includes("checkoutUrl") ||
    text.includes("paymentDetails") ||
    text.includes("sessionToken") ||
    text.includes("verificationToken") ||
    text.includes("gid://shopify/Cart/") ||
    text.includes("gid://shopify/CartLine/") ||
    text.includes("gid://shopify/CartDeliveryGroup/")
  );
}

function writeDecryptOrThrow(res: ServerResponse, error: unknown): void {
  if (error instanceof TokenDecryptError) {
    writeProblem(res, internalError(DECRYPT_DETAIL));
    return;
  }
  throw error;
}
