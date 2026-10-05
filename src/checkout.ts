import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { publicBuyerIp } from "./buyer-ip.js";
import { readCartResult } from "./cart-map.js";
import { acceptRead, commerceReady, storefront, withCartLock } from "./cart.js";
import { CART_DISCOUNT_CODES_UPDATE_DOCUMENT, CART_QUERY_DOCUMENT } from "./cart-query.js";
import {
  CART_BUYER_IDENTITY_UPDATE_DOCUMENT,
  CART_CHECKOUT_URL_DOCUMENT,
  CART_DELIVERY_ADDRESSES_REPLACE_DOCUMENT,
  CART_DELIVERY_GROUPS_DOCUMENT,
  CART_SELECTED_DELIVERY_OPTIONS_UPDATE_DOCUMENT,
} from "./checkout-query.js";
import type { ConnectorDeps } from "./deps.js";
import { writeJson, writeProblem } from "./http-response.js";
import {
  ANONYMOUS_SCOPE,
  CHECKOUT_CONFIRM_ROUTE,
  CHECKOUT_INITIATE_ROUTE,
  IDEMPOTENCY_TTL_MS,
  computeIdempotencyFingerprint,
} from "./idempotency.js";
import { isRecord } from "./json.js";
import {
  DECRYPT_DETAIL,
  cartNotFound,
  checkoutSessionExpired,
  idempotencyConflict,
  internalError,
  invalidCheckoutSession,
  invalidDiscountCode,
  invalidVerificationToken,
  paymentMethodUnsupported,
  rateLimited,
  validationError,
  type FieldError,
  type Problem,
} from "./problems.js";
import { RequestBodyTooLargeError, readRequestBody } from "./read-body.js";
import { TokenDecryptError } from "./token-store.js";
import { readPackageMetadata } from "./version.js";

const INITIATE_PATH = "/api/fastbuyjson/checkout/initiate";
const CONFIRM_PATH = "/api/fastbuyjson/checkout/confirm";
const NO_STORE = "no-store";
const HANDOFF = "shopify_hosted";
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_GROUP_PAGES = 5;

const validateInitiate = compileSchema("checkout-initiate.json");
const validateConfirm = compileSchema("checkout-confirm.json");

export type CheckoutMatch = { kind: "initiate" } | { kind: "confirm" };

type CheckoutResult = { kind: "json"; status: number; body: unknown } | { kind: "problem"; problem: Problem };

type CallFailure = "throttled" | "unauthorized" | "failed";

type Shipping = {
  line1: string;
  city: string;
  country: string;
  postalCode: string;
  line2?: string;
  province?: string;
};

type InitiateRequest = {
  cartId: string;
  email: string;
  phone: string;
  shipping: Shipping;
  firstName?: string;
  lastName?: string;
  shippingOptionId?: string;
  discountCode?: string;
  extensions?: Record<string, unknown>;
};

type ConfirmRequest = {
  sessionToken: string;
  verificationToken: string;
};

type DeliveryGroup = {
  id: string;
  handles: string[];
};

type GroupPage =
  | { kind: "ok"; groups: DeliveryGroup[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: "missing" }
  | { kind: "gone" }
  | { kind: "invalid" };

type MutationRead = { kind: "ok" } | { kind: "rejected"; errors: FieldError[] } | { kind: "invalid" };

export function matchCheckoutRequest(
  method: string,
  pathname: string,
): { match: CheckoutMatch } | { match: "not-allowed"; allow: string } | { match: "ignore" } {
  if (pathname === INITIATE_PATH) {
    return method === "POST" ? { match: { kind: "initiate" } } : { match: "not-allowed", allow: "POST" };
  }
  if (pathname === CONFIRM_PATH) {
    return method === "POST" ? { match: { kind: "confirm" } } : { match: "not-allowed", allow: "POST" };
  }
  return { match: "ignore" };
}

export async function handleCheckout(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
  route: CheckoutMatch,
): Promise<void> {
  switch (route.kind) {
    case "initiate":
      await initiateCheckout(req, res, deps);
      return;
    case "confirm":
      await confirmCheckout(req, res, deps);
      return;
    default: {
      const neverRoute: never = route;
      throw new Error(`Unhandled checkout route: ${String(neverRoute)}`);
    }
  }
}

async function initiateCheckout(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  const parsed = await readInitiate(req);
  if (!parsed.ok) {
    writeProblem(res, parsed.problem);
    return;
  }
  const key = headerValue(req, "idempotency-key");
  const fingerprint = computeIdempotencyFingerprint("POST", CHECKOUT_INITIATE_ROUTE, parsed.body);
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
      const result = await performInitiate(deps, buyerIp, parsed.request);
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

async function confirmCheckout(req: IncomingMessage, res: ServerResponse, deps: ConnectorDeps): Promise<void> {
  const parsed = await readConfirm(req);
  if (!parsed.ok) {
    writeProblem(res, parsed.problem);
    return;
  }
  const key = headerValue(req, "idempotency-key");
  const fingerprint = computeIdempotencyFingerprint("POST", CHECKOUT_CONFIRM_ROUTE, parsed.body);
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
      const session = deps.tokens.getCheckoutSession(deps.app.shopDomain, parsed.request.sessionToken);
      if (session === null) {
        writeProblem(res, invalidCheckoutSession());
        return;
      }
      if (deps.now() > session.expiresAt) {
        writeProblem(res, checkoutSessionExpired());
        return;
      }
      if (!tokenMatches(session.verificationToken, parsed.request.verificationToken)) {
        writeProblem(res, invalidVerificationToken());
        return;
      }
      if (!isUsableCheckoutUrl(session.checkoutUrl)) {
        writeProblem(res, internalError("The checkout request could not be completed."));
        return;
      }
      writeProblem(res, paymentMethodUnsupported(session.checkoutUrl));
    } catch (error) {
      writeDecryptOrThrow(res, error);
    }
  });
}

async function performInitiate(
  deps: ConnectorDeps,
  buyerIp: string | undefined,
  request: InitiateRequest,
): Promise<CheckoutResult> {
  const stored = deps.tokens.getAnonymousCart(deps.app.shopDomain);
  if (stored === null || stored.cartId !== request.cartId) {
    return { kind: "problem", problem: cartNotFound(`No cart with id ${request.cartId}`) };
  }
  if (stored.lines.length === 0) {
    return { kind: "problem", problem: validationError("The cart is empty.") };
  }
  const ready = await commerceReady(deps);
  if (!ready.ok) {
    return { kind: "problem", problem: ready.problem };
  }
  const identity = await mutateCheckout(deps, ready.token, buyerIp, CART_BUYER_IDENTITY_UPDATE_DOCUMENT, {
    cartId: stored.shopifyCartId,
    buyerIdentity: {
      email: request.email,
      phone: request.phone,
      countryCode: request.shipping.country,
    },
  }, "cartBuyerIdentityUpdate");
  if (identity.kind !== "ok") {
    return identity.kind === "problem" ? identity : checkoutCallResult(deps, identity.kind);
  }
  const addressed = await mutateCheckout(deps, ready.token, buyerIp, CART_DELIVERY_ADDRESSES_REPLACE_DOCUMENT, {
    cartId: stored.shopifyCartId,
    addresses: [deliveryAddressInput(request)],
  }, "cartDeliveryAddressesReplace");
  if (addressed.kind !== "ok") {
    return addressed.kind === "problem" ? addressed : checkoutCallResult(deps, addressed.kind);
  }
  if (request.discountCode !== undefined) {
    const discounted = await applyDiscountCode(deps, ready.token, buyerIp, stored.shopifyCartId, request.discountCode);
    if (discounted !== undefined) {
      return { kind: "problem", problem: discounted };
    }
  }
  if (request.shippingOptionId !== undefined) {
    const selected = await selectDelivery(deps, ready.token, buyerIp, stored.shopifyCartId, request.shippingOptionId);
    if (selected !== undefined) {
      return selected;
    }
  }
  const snapshotCall = await storefront(deps, ready.token, buyerIp, CART_QUERY_DOCUMENT, { id: stored.shopifyCartId });
  if (snapshotCall.kind !== "ok") {
    return checkoutCallResult(deps, snapshotCall.kind);
  }
  const snapshot = await acceptRead(deps, ready.token, buyerIp, stored, readCartResult(snapshotCall.data, "query"));
  if (snapshot.kind !== "json" || !isRecord(snapshot.body) || !isRecord(snapshot.body.cart)) {
    return snapshot.kind === "problem"
      ? snapshot
      : { kind: "problem", problem: internalError("The checkout request could not be completed.") };
  }
  const urlCall = await storefront(deps, ready.token, buyerIp, CART_CHECKOUT_URL_DOCUMENT, { id: stored.shopifyCartId });
  if (urlCall.kind !== "ok") {
    return checkoutCallResult(deps, urlCall.kind);
  }
  const checkoutUrl = readCheckoutUrl(urlCall.data);
  if (checkoutUrl === null) {
    return { kind: "problem", problem: internalError("The checkout request could not be completed.") };
  }
  const now = deps.now();
  const expiresAt = now + SESSION_TTL_MS;
  const sessionToken = randomUUID();
  const verificationToken = randomUUID();
  const cart = request.extensions === undefined ? snapshot.body.cart : { ...snapshot.body.cart, extensions: request.extensions };
  const body = {
    sessionToken,
    verificationToken,
    expiresAt: new Date(expiresAt).toISOString(),
    cart,
    checkoutUrl,
    checkoutHandoff: HANDOFF,
  };
  if (responseLeaks(body)) {
    return { kind: "problem", problem: internalError("The checkout request could not be completed.") };
  }
  deps.tokens.saveCheckoutSession(deps.app.shopDomain, {
    cartId: stored.cartId,
    sessionToken,
    verificationToken,
    expiresAt,
    checkoutUrl,
  });
  if (request.extensions !== undefined) {
    const current = deps.tokens.getAnonymousCart(deps.app.shopDomain);
    if (current !== null) {
      deps.tokens.saveAnonymousCart(deps.app.shopDomain, {
        cartId: current.cartId,
        shopifyCartId: current.shopifyCartId,
        extensions: request.extensions,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        lines: current.lines,
      });
    }
  }
  return { kind: "json", status: 200, body };
}

async function mutateCheckout(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  query: string,
  variables: Record<string, unknown>,
  field: string,
): Promise<{ kind: "ok" } | { kind: "problem"; problem: Problem } | { kind: CallFailure }> {
  const call = await storefront(deps, token, buyerIp, query, variables);
  if (call.kind !== "ok") {
    return { kind: call.kind };
  }
  const parsed = readCheckoutMutation(call.data, field);
  if (parsed.kind === "rejected") {
    const detail = parsed.errors[0]?.message ?? "Shopify rejected the checkout change.";
    return { kind: "problem", problem: validationError(detail, parsed.errors) };
  }
  if (parsed.kind !== "ok") {
    return { kind: "problem", problem: internalError("The checkout request could not be completed.") };
  }
  return { kind: "ok" };
}

async function applyDiscountCode(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  shopifyCartId: string,
  code: string,
): Promise<Problem | undefined> {
  const call = await storefront(deps, token, buyerIp, CART_DISCOUNT_CODES_UPDATE_DOCUMENT, {
    cartId: shopifyCartId,
    discountCodes: [code],
  });
  if (call.kind !== "ok") {
    return checkoutFailure(deps, call.kind);
  }
  const parsed = readCartResult(call.data, "cartDiscountCodesUpdate");
  if (parsed.kind === "rejected") {
    const detail = parsed.errors[0]?.message ?? "Shopify rejected the checkout change.";
    return validationError(detail, parsed.errors);
  }
  const discountCodes = parsed.kind === "ok" || parsed.kind === "invalid" ? parsed.discountCodes : undefined;
  if (discountCodes !== undefined && discountCodes.some((entry) => entry.applicable === false)) {
    const removed = await clearDiscountCodes(deps, token, buyerIp, shopifyCartId);
    return removed ? invalidDiscountCode() : internalError("The checkout request could not be completed.");
  }
  if (parsed.kind !== "ok" || discountCodes === undefined) {
    return internalError("The checkout request could not be completed.");
  }
  return undefined;
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

async function selectDelivery(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  shopifyCartId: string,
  shippingOptionId: string,
): Promise<CheckoutResult | undefined> {
  const groups = await readDeliveryGroups(deps, token, buyerIp, shopifyCartId);
  if (groups.kind === "failure") {
    return groups.result;
  }
  if (groups.kind !== "groups") {
    return undefined;
  }
  const selected = groups.groups.flatMap((group) =>
    group.handles.includes(shippingOptionId)
      ? [{ deliveryGroupId: group.id, deliveryOptionHandle: shippingOptionId }]
      : [],
  );
  if (selected.length === 0) {
    return undefined;
  }
  const updated = await mutateCheckout(
    deps,
    token,
    buyerIp,
    CART_SELECTED_DELIVERY_OPTIONS_UPDATE_DOCUMENT,
    { cartId: shopifyCartId, selectedDeliveryOptions: selected },
    "cartSelectedDeliveryOptionsUpdate",
  );
  if (updated.kind === "ok") {
    return undefined;
  }
  return updated.kind === "problem" ? updated : checkoutCallResult(deps, updated.kind);
}

async function readDeliveryGroups(
  deps: ConnectorDeps,
  token: string,
  buyerIp: string | undefined,
  shopifyCartId: string,
): Promise<{ kind: "groups"; groups: DeliveryGroup[] } | { kind: "skip" } | { kind: "failure"; result: CheckoutResult }> {
  const groups: DeliveryGroup[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
    const call = await storefront(deps, token, buyerIp, CART_DELIVERY_GROUPS_DOCUMENT, {
      id: shopifyCartId,
      after,
    });
    if (call.kind !== "ok") {
      return { kind: "failure", result: await checkoutCallResult(deps, call.kind) };
    }
    const parsed = readGroupPage(call.data);
    if (parsed.kind === "missing") {
      return { kind: "skip" };
    }
    if (parsed.kind === "gone" || parsed.kind === "invalid") {
      return { kind: "failure", result: { kind: "problem", problem: internalError("The checkout request could not be completed.") } };
    }
    groups.push(...parsed.groups);
    if (!parsed.hasNextPage || parsed.endCursor === null) {
      return { kind: "groups", groups };
    }
    after = parsed.endCursor;
  }
  return { kind: "groups", groups };
}

function deliveryAddressInput(request: InitiateRequest): Record<string, unknown> {
  const delivery: Record<string, unknown> = {
    address1: request.shipping.line1,
    city: request.shipping.city,
    countryCode: request.shipping.country,
    zip: request.shipping.postalCode,
    phone: request.phone,
  };
  if (request.shipping.line2 !== undefined) {
    delivery.address2 = request.shipping.line2;
  }
  if (request.shipping.province !== undefined) {
    delivery.provinceCode = request.shipping.province;
  }
  if (request.firstName !== undefined) {
    delivery.firstName = request.firstName;
  }
  if (request.lastName !== undefined) {
    delivery.lastName = request.lastName;
  }
  return {
    selected: true,
    address: { deliveryAddress: delivery },
  };
}

function readCheckoutMutation(data: unknown, field: string): MutationRead {
  if (!isRecord(data)) {
    return { kind: "invalid" };
  }
  const payload = data[field];
  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) {
    return { kind: "invalid" };
  }
  const errors = readErrors(payload.userErrors);
  if (errors === "invalid") {
    return { kind: "invalid" };
  }
  if (errors.length > 0) {
    return { kind: "rejected", errors };
  }
  if (!isRecord(payload.cart)) {
    return { kind: "invalid" };
  }
  return { kind: "ok" };
}

function readGroupPage(data: unknown): GroupPage {
  if (!isRecord(data) || !Object.hasOwn(data, "cart")) {
    return { kind: "invalid" };
  }
  if (data.cart === null) {
    return { kind: "gone" };
  }
  if (!isRecord(data.cart) || !Object.hasOwn(data.cart, "deliveryGroups")) {
    return { kind: "missing" };
  }
  const connection = data.cart.deliveryGroups;
  if (connection === null) {
    return { kind: "missing" };
  }
  if (!isRecord(connection) || !isRecord(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== "boolean") {
    return { kind: "invalid" };
  }
  if (!Array.isArray(connection.nodes)) {
    return { kind: "invalid" };
  }
  const endCursor = connection.pageInfo.endCursor;
  const cursor = typeof endCursor === "string" && endCursor !== "" ? endCursor : null;
  if (connection.pageInfo.hasNextPage && cursor === null) {
    return { kind: "invalid" };
  }
  const groups: DeliveryGroup[] = [];
  for (const node of connection.nodes) {
    const group = readGroup(node);
    if (group === null) {
      return { kind: "invalid" };
    }
    groups.push(group);
  }
  return { kind: "ok", groups, hasNextPage: connection.pageInfo.hasNextPage, endCursor: cursor };
}

function readGroup(value: unknown): DeliveryGroup | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "" || !Array.isArray(value.deliveryOptions)) {
    return null;
  }
  const handles: string[] = [];
  for (const option of value.deliveryOptions) {
    if (!isRecord(option) || typeof option.handle !== "string" || option.handle === "") {
      return null;
    }
    handles.push(option.handle);
  }
  return { id: value.id, handles };
}

function readCheckoutUrl(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.cart) || typeof data.cart.checkoutUrl !== "string") {
    return null;
  }
  return isUsableCheckoutUrl(data.cart.checkoutUrl) ? data.cart.checkoutUrl : null;
}

function isUsableCheckoutUrl(url: string): boolean {
  if (!url.startsWith("https://") || url.includes("key=")) {
    return false;
  }
  if (url.includes("gid://shopify/Cart/") || url.includes("gid://shopify/CartLine/")) {
    return false;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function readErrors(value: unknown[]): FieldError[] | "invalid" {
  const errors: FieldError[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.message !== "string" || entry.message.trim() === "") {
      return "invalid";
    }
    errors.push({
      field: errorField(entry.field),
      message: publicMessage(entry.message),
    });
  }
  return errors;
}

function errorField(value: unknown): string {
  if (!Array.isArray(value)) {
    return "cart";
  }
  const parts = value.filter((part): part is string => typeof part === "string" && part !== "" && !part.includes("key="));
  return parts.length > 0 ? parts.join(".") : "cart";
}

function publicMessage(message: string): string {
  if (
    message.includes("key=") ||
    message.includes("checkoutUrl") ||
    message.includes("gid://shopify/Cart/") ||
    message.includes("gid://shopify/CartLine/")
  ) {
    return "Shopify rejected the checkout change.";
  }
  return message;
}

async function checkoutCallResult(deps: ConnectorDeps, kind: CallFailure): Promise<CheckoutResult> {
  return { kind: "problem", problem: await checkoutFailure(deps, kind) };
}

async function checkoutFailure(deps: ConnectorDeps, kind: CallFailure): Promise<Problem> {
  switch (kind) {
    case "throttled":
      return rateLimited("Shopify throttled the checkout request.");
    case "unauthorized":
      await deps.tokens.exclusive(async () => {
        deps.tokens.clearDelegate(deps.app.shopDomain, deps.now());
      });
      return internalError("The checkout request could not be completed.");
    case "failed":
      return internalError("The checkout request could not be completed.");
    default: {
      const neverKind: never = kind;
      return internalError(`The checkout request could not be completed (${String(neverKind)}).`);
    }
  }
}

async function readInitiate(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown; request: InitiateRequest } | { ok: false; problem: Problem }> {
  const loaded = await readJson(req);
  if (!loaded.ok) {
    return loaded;
  }
  const schemaBody = withoutNullDiscount(loaded.body);
  if (!validateInitiate(schemaBody)) {
    return { ok: false, problem: validationError("The request body is invalid.", fieldErrors(validateInitiate.errors)) };
  }
  const request = readInitiateRequest(loaded.body);
  if (request === null) {
    return { ok: false, problem: validationError("The request body is invalid.") };
  }
  return { ok: true, body: loaded.body, request };
}

async function readConfirm(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown; request: ConfirmRequest } | { ok: false; problem: Problem }> {
  const loaded = await readJson(req);
  if (!loaded.ok) {
    return loaded;
  }
  if (!validateConfirm(loaded.body)) {
    return { ok: false, problem: validationError("The request body is invalid.", fieldErrors(validateConfirm.errors)) };
  }
  const request = readConfirmRequest(loaded.body);
  if (request === null) {
    return { ok: false, problem: validationError("The request body is invalid.") };
  }
  return { ok: true, body: loaded.body, request };
}

function withoutNullDiscount(body: unknown): unknown {
  if (!isRecord(body) || body.discountCode !== null) {
    return body;
  }
  const copy: Record<string, unknown> = { ...body };
  delete copy.discountCode;
  return copy;
}

function readInitiateRequest(value: unknown): InitiateRequest | null {
  if (!isRecord(value) || typeof value.cartId !== "string" || value.cartId.trim() === "") {
    return null;
  }
  if (!isRecord(value.customerInfo) || !isRecord(value.shippingAddress)) {
    return null;
  }
  const email = requiredText(value.customerInfo.email);
  const phone = optionalText(value.customerInfo.phone) ?? optionalText(value.customerInfo.phoneNumber);
  const shipping = readShipping(value.shippingAddress);
  if (email === null || phone === undefined || shipping === null) {
    return null;
  }
  const request: InitiateRequest = { cartId: value.cartId.trim(), email, phone, shipping };
  const firstName = optionalText(value.customerInfo.firstName);
  if (firstName !== undefined) {
    request.firstName = firstName;
  }
  const lastName = optionalText(value.customerInfo.lastName);
  if (lastName !== undefined) {
    request.lastName = lastName;
  }
  const shippingOptionId = optionalText(value.shippingOptionId);
  if (shippingOptionId !== undefined) {
    request.shippingOptionId = shippingOptionId;
  }
  if (Object.hasOwn(value, "discountCode") && value.discountCode !== null && typeof value.discountCode === "string") {
    const code = value.discountCode.trim();
    if (code !== "") {
      request.discountCode = code;
    }
  }
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) {
      return null;
    }
    request.extensions = cloneExtensions(value.extensions);
  }
  return request;
}

function readShipping(value: Record<string, unknown>): Shipping | null {
  const line1 = requiredText(value.line1);
  const city = requiredText(value.city);
  const country = requiredText(value.country);
  const postalCode = requiredText(value.postalCode);
  if (line1 === null || city === null || country === null || postalCode === null) {
    return null;
  }
  const shipping: Shipping = { line1, city, country, postalCode };
  const line2 = optionalText(value.line2);
  if (line2 !== undefined) {
    shipping.line2 = line2;
  }
  const province = optionalText(value.region) ?? optionalText(value.state);
  if (province !== undefined) {
    shipping.province = province;
  }
  return shipping;
}

function readConfirmRequest(value: unknown): ConfirmRequest | null {
  if (!isRecord(value) || typeof value.sessionToken !== "string" || value.sessionToken === "") {
    return null;
  }
  if (!isRecord(value.paymentDetails) || !isRecord(value.paymentDetails.transactionVerification)) {
    return null;
  }
  const verificationToken = value.paymentDetails.transactionVerification.verificationToken;
  if (typeof verificationToken !== "string" || verificationToken === "") {
    return null;
  }
  return { sessionToken: value.sessionToken, verificationToken };
}

function requiredText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cloneExtensions(value: Record<string, unknown>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isRecord(parsed) ? parsed : {};
}

function tokenMatches(stored: string, provided: string): boolean {
  const left = Buffer.from(stored);
  const right = Buffer.from(provided);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; problem: Problem }> {
  let raw: Buffer;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, problem: validationError("The request body is too large.") };
    }
    throw error;
  }
  try {
    return { ok: true, body: JSON.parse(raw.toString("utf8")) as unknown };
  } catch {
    return { ok: false, problem: validationError("The request body must be JSON.") };
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

function writeResult(res: ServerResponse, result: CheckoutResult): void {
  if (result.kind === "problem") {
    writeProblem(res, result.problem);
    return;
  }
  writePublic(res, result.status, result.body, false);
}

function writePublic(res: ServerResponse, status: number, body: unknown, replay: boolean): void {
  if (responseLeaks(body)) {
    writeProblem(res, internalError("The checkout request could not be completed."));
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
  return text.includes("key=") || text.includes("gid://shopify/Cart/") || text.includes("gid://shopify/CartLine/");
}

function writeDecryptOrThrow(res: ServerResponse, error: unknown): void {
  if (error instanceof TokenDecryptError) {
    writeProblem(res, internalError(DECRYPT_DETAIL));
    return;
  }
  throw error;
}

function compileSchema(name: string): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(join(readPackageMetadata(import.meta.url).root, "schemas", name), "utf8"),
  ) as object;
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}
