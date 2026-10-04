import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { appendLines, readCartResult, readLinePage, toCartResponse, type CartOperation, type CartView, type ShopifyLine } from "./cart-map.js";
import {
  CART_CREATE_DOCUMENT,
  CART_DISCOUNT_CODES_UPDATE_DOCUMENT,
  CART_LINE_PAGE_DOCUMENT,
  CART_LINES_ADD_DOCUMENT,
  CART_LINES_REMOVE_DOCUMENT,
  CART_LINES_UPDATE_DOCUMENT,
  CART_QUERY_DOCUMENT,
} from "./cart-query.js";
import { isMerchandiseGid, resolveMerchandise } from "./cart-resolve.js";
import { publicBuyerIp } from "./buyer-ip.js";
import { prepareCommerceAccess } from "./commerce-token.js";
import { ensureDelegateToken } from "./delegate-token.js";
import type { ConnectorDeps } from "./deps.js";
import { writeJson, writeProblem } from "./http-response.js";
import { ANONYMOUS_SCOPE, CART_ADD_ROUTE, IDEMPOTENCY_TTL_MS, computeIdempotencyFingerprint } from "./idempotency.js";
import { isRecord } from "./json.js";
import {
  DECRYPT_DETAIL,
  cartItemNotFound,
  cartNotFound,
  idempotencyConflict,
  internalError,
  invalidDiscountCode,
  productNotFound,
  rateLimited,
  validationError,
  type FieldError,
  type Problem,
} from "./problems.js";
import { RequestBodyTooLargeError, readRequestBody } from "./read-body.js";
import { defaultSleep, shopifyGraphql, storefrontGraphqlUrl, type ShopifyCall } from "./shopify-graphql.js";
import { TokenDecryptError, type StoredCart, type StoredCartLine } from "./token-store.js";
import { readPackageMetadata } from "./version.js";

const CART_PATH = "/api/fastbuyjson/cart";
const ADDED_MESSAGE = "Item added to cart successfully";
const NO_STORE = "no-store";
const MAX_LINE_PAGES = 20;

const validateAdd = compileSchema("add-to-cart.json");
const validateUpdate = compileSchema("cart-update-item.json");
const validateDiscount = compileSchema("cart-discount.json");

export type CartMatch =
  | { kind: "add" }
  | { kind: "cart" }
  | { kind: "discount" }
  | { kind: "cart-id"; cartId: string }
  | { kind: "item"; itemId: string };

type AddRequest = {
  productId: string;
  quantity: number;
  options?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

type PublicResult = { kind: "json"; status: number; body: unknown } | { kind: "problem"; problem: Problem };

type CallFailure = "throttled" | "unauthorized" | "failed";

let cartTail: Promise<unknown> = Promise.resolve();

export function matchCartRequest(
  method: string,
  pathname: string,
): { match: CartMatch } | { match: "not-allowed"; allow: string } | { match: "ignore" } {
  if (pathname === `${CART_PATH}/add`) {
    return method === "POST" ? { match: { kind: "add" } } : { match: "not-allowed", allow: "POST" };
  }
  if (pathname === CART_PATH) {
    if (method === "GET" || method === "DELETE") {
      return { match: { kind: "cart" } };
    }
    if (method === "POST") {
      return { match: "ignore" };
    }
    return { match: "not-allowed", allow: "GET, DELETE" };
  }
  if (pathname === `${CART_PATH}/discount`) {
    return method === "POST" ? { match: { kind: "discount" } } : { match: "not-allowed", allow: "POST" };
  }
  if (pathname.startsWith(`${CART_PATH}/discount/`)) {
    return { match: "ignore" };
  }
  const itemPrefix = `${CART_PATH}/items/`;
  if (pathname.startsWith(itemPrefix)) {
    const rest = pathname.slice(itemPrefix.length);
    if (rest === "" || rest.includes("/")) {
      return { match: "ignore" };
    }
    const itemId = decodeSegment(rest);
    if (itemId === null || itemId === "") {
      return { match: "ignore" };
    }
    if (method === "PATCH" || method === "DELETE") {
      return { match: { kind: "item", itemId } };
    }
    return { match: "not-allowed", allow: "PATCH, DELETE" };
  }
  if (pathname.startsWith(`${CART_PATH}/`)) {
    const rest = pathname.slice(CART_PATH.length + 1);
    if (rest === "" || rest.includes("/") || rest === "items") {
      return { match: "ignore" };
    }
    const cartId = decodeSegment(rest);
    if (cartId === null || cartId === "") {
      return { match: "ignore" };
    }
    if (method === "GET") {
      return { match: { kind: "cart-id", cartId } };
    }
    return { match: "not-allowed", allow: "GET" };
  }
  return { match: "ignore" };
}

export async function handleCart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
  route: CartMatch,
): Promise<void> {
  switch (route.kind) {
    case "add":
      await addToCart(req, res, deps);
      return;
    case "cart":
      if (req.method === "DELETE") {
        await deleteCart(req, res, deps);
        return;
      }
      await getCart(req, res, deps);
      return;
    case "cart-id":
      await getCart(req, res, deps, route.cartId);
      return;
    case "discount":
      await applyDiscount(req, res, deps);
      return;
    case "item":
      if (req.method === "DELETE") {
        await deleteItem(req, res, deps, route.itemId);
        return;
      }
      await updateItem(req, res, deps, route.itemId);
      return;
    default: {
      const neverRoute: never = route;
      throw new Error(`Unhandled cart route: ${String(neverRoute)}`);
    }
  }
}

async function addToCart(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  const parsed = await readValidated(req, validateAdd);
  if (!parsed.ok) {
    writeProblem(res, parsed.problem);
    return;
  }
  const add = readAddRequest(parsed.body);
  if (add === null) {
    writeProblem(res, validationError("The request body is invalid."));
    return;
  }
  const key = headerValue(req, "idempotency-key");
  const fingerprint = computeIdempotencyFingerprint("POST", CART_ADD_ROUTE, parsed.body);
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      if (key !== undefined) {
        const hit = deps.tokens.lookupIdempotency(ANONYMOUS_SCOPE, key, fingerprint, deps.now());
        if (hit.kind === "conflict") {
          writeProblem(res, idempotencyConflict());
          return;
        }
        if (hit.kind === "replay") {
          writePublic(res, hit.status, hit.body, true);
          return;
        }
      }
      const result = await mutateAdd(deps, buyerIp, add);
      if (result.kind === "json" && key !== undefined && !responseLeaks(result.body)) {
        deps.tokens.rememberIdempotency(
          ANONYMOUS_SCOPE,
          key,
          fingerprint,
          result.status,
          result.body,
          deps.now() + IDEMPOTENCY_TTL_MS,
        );
      }
      writeResult(res, result);
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function getCart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
  cartId?: string,
): Promise<void> {
  const drained = await drainBody(req);
  if (drained !== undefined) {
    writeProblem(res, drained);
    return;
  }
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
      if (stored === null || (cartId !== undefined && stored.cartId !== cartId)) {
        writeProblem(res, missingCart(cartId));
        return;
      }
      const ready = await commerceReady(deps);
      if (!ready.ok) {
        writeProblem(res, ready.problem);
        return;
      }
      const call = await storefront(deps, ready.token, buyerIp, CART_QUERY_DOCUMENT, { id: stored.shopifyCartId });
      if (call.kind !== "ok") {
        writeResult(res, await callFailure(deps, call.kind));
        return;
      }
      writeResult(res, await acceptRead(deps, ready.token, buyerIp, stored, readCartResult(call.data, "query")));
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function deleteCart(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  const drained = await drainBody(req);
  if (drained !== undefined) {
    writeProblem(res, drained);
    return;
  }
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
      if (stored === null) {
        writeProblem(res, cartNotFound());
        return;
      }
      const ready = await commerceReady(deps);
      if (!ready.ok) {
        writeProblem(res, ready.problem);
        return;
      }
      if (stored.lines.length === 0) {
        const call = await storefront(deps, ready.token, buyerIp, CART_QUERY_DOCUMENT, { id: stored.shopifyCartId });
        if (call.kind !== "ok") {
          writeResult(res, await callFailure(deps, call.kind));
          return;
        }
        writeResult(res, await acceptRead(deps, ready.token, buyerIp, stored, readCartResult(call.data, "query")));
        return;
      }
      const call = await storefront(deps, ready.token, buyerIp, CART_LINES_REMOVE_DOCUMENT, {
        cartId: stored.shopifyCartId,
        lineIds: stored.lines.map((line) => line.lineGid),
      });
      if (call.kind !== "ok") {
        writeResult(res, await callFailure(deps, call.kind));
        return;
      }
      writeResult(
        res,
        await acceptMutation(deps, ready.token, buyerIp, stored, readCartResult(call.data, "cartLinesRemove"), undefined, false),
      );
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function updateItem(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
  itemId: string,
): Promise<void> {
  const parsed = await readValidated(req, validateUpdate);
  if (!parsed.ok) {
    writeProblem(res, parsed.problem);
    return;
  }
  const quantity = readQuantity(parsed.body);
  if (quantity === null) {
    writeProblem(res, validationError("The request body is invalid."));
    return;
  }
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      const located = locateLine(deps, itemId);
      if (located.kind === "problem") {
        writeProblem(res, located.problem);
        return;
      }
      const ready = await commerceReady(deps);
      if (!ready.ok) {
        writeProblem(res, ready.problem);
        return;
      }
      const call = await storefront(deps, ready.token, buyerIp, CART_LINES_UPDATE_DOCUMENT, {
        cartId: located.stored.shopifyCartId,
        lines: [{ id: located.lineGid, quantity }],
      });
      if (call.kind !== "ok") {
        writeResult(res, await callFailure(deps, call.kind));
        return;
      }
      writeResult(
        res,
        await acceptMutation(deps, ready.token, buyerIp, located.stored, readCartResult(call.data, "cartLinesUpdate"), undefined, false),
      );
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function applyDiscount(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  const requested = await readDiscountRequest(req);
  if (!requested.ok) {
    writeProblem(res, requested.problem);
    return;
  }
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
      if (stored === null) {
        writeProblem(res, cartNotFound());
        return;
      }
      const ready = await commerceReady(deps);
      if (!ready.ok) {
        writeProblem(res, ready.problem);
        return;
      }
      const call = await storefront(deps, ready.token, buyerIp, CART_DISCOUNT_CODES_UPDATE_DOCUMENT, {
        cartId: stored.shopifyCartId,
        discountCodes: requested.codes,
      });
      if (call.kind !== "ok") {
        writeResult(res, await callFailure(deps, call.kind));
        return;
      }
      const parsed = readCartResult(call.data, "cartDiscountCodesUpdate");
      if (parsed.kind === "rejected") {
        const detail = parsed.errors[0]?.message ?? "Shopify rejected the cart change.";
        writeProblem(res, validationError(detail, parsed.errors));
        return;
      }
      const discountCodes = parsed.kind === "ok" || parsed.kind === "invalid" ? parsed.discountCodes : undefined;
      if (discountCodes !== undefined && discountCodes.some((entry) => entry.applicable === false)) {
        const removed = await clearDiscountCodes(deps, ready.token, buyerIp, stored.shopifyCartId);
        writeProblem(res, removed ? invalidDiscountCode() : internalError("The cart request could not be completed."));
        return;
      }
      if (parsed.kind !== "ok" || discountCodes === undefined) {
        writeProblem(res, internalError("The cart request could not be completed."));
        return;
      }
      writeResult(res, await acceptMutation(deps, ready.token, buyerIp, stored, parsed, undefined, false));
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function clearDiscountCodes(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  shopifyCartId: string,
): Promise<boolean> {
  const call = await storefront(deps, token, buyerIp, CART_DISCOUNT_CODES_UPDATE_DOCUMENT, {
    cartId: shopifyCartId,
    discountCodes: [],
  });
  if (call.kind === "unauthorized") {
    await deps.tokens.exclusive(async () => {
      deps.tokens.clearDelegate(deps.app.shopDomain, deps.now());
    });
    return false;
  }
  if (call.kind !== "ok") {
    return false;
  }
  const parsed = readCartResult(call.data, "cartDiscountCodesUpdate");
  return parsed.kind === "ok" && parsed.discountCodes !== undefined && parsed.discountCodes.every((entry) => entry.applicable);
}

async function deleteItem(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps, itemId: string): Promise<void> {
  const drained = await drainBody(req);
  if (drained !== undefined) {
    writeProblem(res, drained);
    return;
  }
  const buyerIp = publicBuyerIp(req.socket.remoteAddress);
  await withCartLock(async () => {
    try {
      const located = locateLine(deps, itemId);
      if (located.kind === "problem") {
        writeProblem(res, located.problem);
        return;
      }
      const ready = await commerceReady(deps);
      if (!ready.ok) {
        writeProblem(res, ready.problem);
        return;
      }
      const call = await storefront(deps, ready.token, buyerIp, CART_LINES_REMOVE_DOCUMENT, {
        cartId: located.stored.shopifyCartId,
        lineIds: [located.lineGid],
      });
      if (call.kind !== "ok") {
        writeResult(res, await callFailure(deps, call.kind));
        return;
      }
      writeResult(
        res,
        await acceptMutation(deps, ready.token, buyerIp, located.stored, readCartResult(call.data, "cartLinesRemove"), undefined, false),
      );
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function mutateAdd(
  deps: ConnectorDeps,
  buyerIp: string | undefined,
  add: AddRequest,
): Promise<PublicResult> {
  if (!isMerchandiseGid(add.productId)) {
    return { kind: "problem", problem: productNotFound(add.productId) };
  }
  const ready = await commerceReady(deps);
  if (!ready.ok) {
    return { kind: "problem", problem: ready.problem };
  }
  const caller = (query: string, variables: Record<string, unknown>) =>
    storefront(deps, ready.token, buyerIp, query, variables);
  const resolved = await resolveMerchandise(caller, add.productId, add.options);
  if (resolved.kind === "not_found") {
    return { kind: "problem", problem: productNotFound(add.productId) };
  }
  if (resolved.kind === "ambiguous") {
    return { kind: "problem", problem: ambiguousVariant() };
  }
  if (resolved.kind !== "ok") {
    return callFailure(deps, resolved.kind);
  }
  const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
  const lines = [{ merchandiseId: resolved.variantId, quantity: add.quantity }];
  const operation: CartOperation = stored === null ? "cartCreate" : "cartLinesAdd";
  const call = await storefront(
    deps,
    ready.token,
    buyerIp,
    stored === null ? CART_CREATE_DOCUMENT : CART_LINES_ADD_DOCUMENT,
    stored === null ? { input: { lines } } : { cartId: stored.shopifyCartId, lines },
  );
  if (call.kind !== "ok") {
    return callFailure(deps, call.kind);
  }
  return acceptMutation(deps, ready.token, buyerIp, stored, readCartResult(call.data, operation), add.extensions, true);
}

async function acceptMutation(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  stored: StoredCart | null,
  parsed: ReturnType<typeof readCartResult>,
  extensions: Record<string, unknown> | undefined,
  announce: boolean,
): Promise<PublicResult> {
  if (parsed.kind === "rejected") {
    const detail = parsed.errors[0]?.message ?? "Shopify rejected the cart change.";
    return { kind: "problem", problem: validationError(detail, parsed.errors) };
  }
  if (parsed.kind === "empty") {
    if (stored !== null) {
      deps.tokens.clearAnonymousCart();
    }
    return { kind: "problem", problem: cartNotFound() };
  }
  if (parsed.kind !== "ok") {
    return { kind: "problem", problem: internalError("The cart request could not be completed.") };
  }
  const completed = await completeLines(deps, token, buyerIp, parsed.shopifyCartId, parsed.view);
  if (completed.kind !== "ok") {
    return callFailure(deps, completed.kind);
  }
  const now = deps.now();
  const cartId = stored?.cartId ?? randomUUID();
  const createdAt = stored?.createdAt ?? now;
  const shopifyCartId = stored?.shopifyCartId ?? parsed.shopifyCartId;
  const assigned = assignLines(stored?.lines ?? [], completed.view.lines);
  const nextExtensions = extensions !== undefined ? cloneExtensions(extensions) : (stored?.extensions ?? null);
  deps.tokens.saveAnonymousCart(deps.app.shopDomain, {
    cartId,
    shopifyCartId,
    extensions: nextExtensions,
    createdAt,
    updatedAt: now,
    lines: assigned.map((entry) => ({ itemId: entry.itemId, lineGid: entry.line.lineGid })),
  });
  return {
    kind: "json",
    status: 200,
    body: toCartResponse({
      cartId,
      createdAt,
      updatedAt: now,
      extensions: nextExtensions,
      lines: assigned,
      view: completed.view,
      ...(announce ? { message: ADDED_MESSAGE } : {}),
    }),
  };
}

export async function acceptRead(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  stored: StoredCart,
  parsed: ReturnType<typeof readCartResult>,
): Promise<PublicResult> {
  if (parsed.kind === "empty") {
    deps.tokens.clearAnonymousCart();
    return { kind: "problem", problem: cartNotFound() };
  }
  if (parsed.kind !== "ok") {
    return { kind: "problem", problem: internalError("The cart request could not be completed.") };
  }
  const completed = await completeLines(deps, token, buyerIp, stored.shopifyCartId, parsed.view);
  if (completed.kind !== "ok") {
    return callFailure(deps, completed.kind);
  }
  const assigned = assignLines(stored.lines, completed.view.lines);
  const nextLines = assigned.map((entry) => ({ itemId: entry.itemId, lineGid: entry.line.lineGid }));
  if (!sameLines(stored.lines, nextLines)) {
    deps.tokens.saveAnonymousCart(deps.app.shopDomain, {
      cartId: stored.cartId,
      shopifyCartId: stored.shopifyCartId,
      extensions: stored.extensions,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lines: nextLines,
    });
  }
  return {
    kind: "json",
    status: 200,
    body: toCartResponse({
      cartId: stored.cartId,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      extensions: stored.extensions,
      lines: assigned,
      view: completed.view,
    }),
  };
}

async function completeLines(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  shopifyCartId: string,
  initial: CartView,
): Promise<{ kind: "ok"; view: CartView } | { kind: CallFailure }> {
  let view = initial;
  for (let page = 0; view.hasNextPage && page < MAX_LINE_PAGES; page += 1) {
    if (view.endCursor === null) {
      return { kind: "failed" };
    }
    const call = await storefront(deps, token, buyerIp, CART_LINE_PAGE_DOCUMENT, {
      id: shopifyCartId,
      after: view.endCursor,
    });
    if (call.kind !== "ok") {
      return { kind: call.kind };
    }
    const more = readLinePage(call.data);
    if (more === null) {
      return { kind: "failed" };
    }
    view = appendLines(view, more);
  }
  if (view.hasNextPage) {
    return { kind: "failed" };
  }
  return { kind: "ok", view };
}

function assignLines(stored: StoredCartLine[], lines: ShopifyLine[]): { itemId: string; line: ShopifyLine }[] {
  const byGid = new Map(stored.map((line) => [line.lineGid, line.itemId]));
  return lines.map((line) => {
    const existing = byGid.get(line.lineGid);
    const itemId = existing ?? randomUUID();
    if (existing === undefined) {
      byGid.set(line.lineGid, itemId);
    }
    return { itemId, line };
  });
}

function sameLines(stored: StoredCartLine[], next: StoredCartLine[]): boolean {
  if (stored.length !== next.length) {
    return false;
  }
  return stored.every((line, index) => line.itemId === next[index]?.itemId && line.lineGid === next[index]?.lineGid);
}

function locateLine(
  deps: ConnectorDeps,
  itemId: string,
): { kind: "ok"; stored: StoredCart; lineGid: string } | { kind: "problem"; problem: Problem } {
  const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
  if (stored === null) {
    return { kind: "problem", problem: cartNotFound() };
  }
  const line = stored.lines.find((entry) => entry.itemId === itemId);
  if (line === undefined) {
    return { kind: "problem", problem: cartItemNotFound(itemId) };
  }
  return { kind: "ok", stored, lineGid: line.lineGid };
}

export async function commerceReady(
  deps: ConnectorDeps,
): Promise<{ ok: true; token: string } | { ok: false; problem: Problem }> {
  const access = await prepareCommerceAccess(deps);
  if (access.kind === "unavailable") {
    return { ok: false, problem: internalError(access.detail) };
  }
  return ensureDelegateToken(deps);
}

async function callFailure(deps: ConnectorDeps, kind: CallFailure): Promise<PublicResult> {
  if (kind === "throttled") {
    return { kind: "problem", problem: rateLimited("Shopify throttled the cart request.") };
  }
  if (kind === "unauthorized") {
    await deps.tokens.exclusive(async () => {
      deps.tokens.clearDelegate(deps.app.shopDomain, deps.now());
    });
  }
  return { kind: "problem", problem: internalError("The cart request could not be completed.") };
}

export function storefront(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  query: string,
  variables: Record<string, unknown>,
): Promise<ShopifyCall> {
  return shopifyGraphql({
    url: storefrontGraphqlUrl(deps.app.shopDomain, deps.app.apiVersion),
    tokenHeader: "Shopify-Storefront-Private-Token",
    token,
    query,
    variables,
    ...(buyerIp !== undefined ? { buyerIp } : {}),
    fetch: deps.fetch,
    sleep: deps.sleep ?? defaultSleep,
  });
}

function ambiguousVariant(): Problem {
  return validationError("options must select exactly one variant.", [
    {
      field: "productId",
      message: "Pass a variant id, or options that select one variant.",
    },
  ]);
}

function missingCart(cartId: string | undefined): Problem {
  if (cartId === undefined || cartId.includes("key=")) {
    return cartNotFound();
  }
  return cartNotFound(`No cart with id ${cartId}`);
}

function readAddRequest(value: unknown): AddRequest | null {
  if (!isRecord(value) || typeof value.productId !== "string" || value.productId === "") {
    return null;
  }
  const quantity = value.quantity === undefined ? 1 : value.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
    return null;
  }
  const request: AddRequest = { productId: value.productId, quantity };
  if (value.options !== undefined) {
    if (!isRecord(value.options)) {
      return null;
    }
    request.options = value.options;
  }
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) {
      return null;
    }
    request.extensions = value.extensions;
  }
  return request;
}

function readQuantity(value: unknown): number | null {
  if (!isRecord(value) || typeof value.quantity !== "number" || !Number.isInteger(value.quantity) || value.quantity < 1) {
    return null;
  }
  return value.quantity;
}

function cloneExtensions(value: Record<string, unknown>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isRecord(parsed) ? parsed : {};
}

async function readDiscountRequest(
  req: IncomingMessage,
): Promise<{ ok: true; codes: string[] } | { ok: false; problem: Problem }> {
  let raw: Buffer;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, problem: validationError("The request body is too large.") };
    }
    throw error;
  }
  const text = raw.toString("utf8");
  if (text.trim() === "") {
    return { ok: true, codes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, problem: validationError("The request body must be JSON.") };
  }
  if (!validateDiscount(parsed)) {
    return { ok: false, problem: validationError("The request body is invalid.", fieldErrors(validateDiscount.errors)) };
  }
  return { ok: true, codes: discountCodesFromBody(parsed) };
}

function discountCodesFromBody(body: unknown): string[] {
  if (!isRecord(body) || !Object.hasOwn(body, "code") || body.code === null) {
    return [];
  }
  if (typeof body.code !== "string") {
    return [];
  }
  const trimmed = body.code.trim();
  return trimmed === "" ? [] : [trimmed];
}

async function readValidated(
  req: IncomingMessage,
  validate: ValidateFunction,
): Promise<{ ok: true; body: unknown } | { ok: false; problem: Problem }> {
  let raw: Buffer;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, problem: validationError("The request body is too large.") };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return { ok: false, problem: validationError("The request body must be JSON.") };
  }
  if (!validate(parsed)) {
    return { ok: false, problem: validationError("The request body is invalid.", fieldErrors(validate.errors)) };
  }
  return { ok: true, body: parsed };
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

function fieldErrors(errors: ErrorObject[] | null | undefined): FieldError[] {
  return (errors ?? []).map((error) => ({
    field: fieldPath(error),
    message: error.message ?? "is invalid",
  }));
}

function fieldPath(error: ErrorObject): string {
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  if (path !== "") {
    return path;
  }
  const missing = error.params.missingProperty;
  if (typeof missing === "string" && missing !== "") {
    return missing;
  }
  return "request";
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers[name];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function writeResult(res: ServerResponse, result: PublicResult): void {
  if (result.kind === "problem") {
    writeProblem(res, result.problem);
    return;
  }
  writePublic(res, result.status, result.body, false);
}

function writePublic(res: ServerResponse, status: number, body: unknown, replay: boolean): void {
  if (responseLeaks(body)) {
    writeProblem(res, internalError("The cart request could not be completed."));
    return;
  }
  const headers: Record<string, string> = { "Cache-Control": NO_STORE };
  if (replay) {
    headers["Idempotency-Replayed"] = "true";
  }
  writeJson(res, status, body, headers);
}

function responseLeaks(body: unknown): boolean {
  const text = JSON.stringify(body);
  return text.includes("key=") || text.includes("checkoutUrl");
}

function writeDecryptOrThrow(res: ServerResponse, error: unknown): void {
  if (error instanceof TokenDecryptError) {
    writeProblem(res, internalError(DECRYPT_DETAIL));
    return;
  }
  throw error;
}

export function withCartLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = cartTail.then(fn, fn);
  cartTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function compileSchema(name: string): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(join(readPackageMetadata(import.meta.url).root, "schemas", name), "utf8"),
  ) as object;
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}
