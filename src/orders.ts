import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

import { prepareCommerceAccess } from "./commerce-token.js";
import { installedProblem } from "./delegate-token.js";
import type { ConnectorDeps } from "./deps.js";
import { writeJson, writeProblem } from "./http-response.js";
import { isRecord } from "./json.js";
import {
  classifyOrderToken,
  mapMailingAddress,
  mapOrder,
  type IdMode,
  type OrderLookup,
  type OrderStatusBody,
} from "./order-map.js";
import {
  ORDER_BY_ID_ADDRESS_DOCUMENT,
  ORDER_BY_ID_DOCUMENT,
  ORDERS_BY_QUERY_ADDRESS_DOCUMENT,
  ORDERS_BY_QUERY_DOCUMENT,
  legacyOrderGid,
  nameSearchQuery,
  tokenSearchQuery,
} from "./order-query.js";
import { DECRYPT_DETAIL, REINSTALL_DETAIL, internalError, orderNotFound, rateLimited, type Problem } from "./problems.js";
import { adminGraphqlUrl, defaultSleep, orderAdminGraphql, type OrderAdminCall } from "./shopify-graphql.js";
import { TokenDecryptError } from "./token-store.js";
import { readPackageMetadata } from "./version.js";

const ORDERS_PREFIX = "/api/fastbuyjson/orders/";
const MAX_LINE_PAGES = 20;
const NO_STORE = { "Cache-Control": "no-store" };

const validateOrderStatus = compileOrderSchema();
const validateEmail = compileEmailFormat();

type OrderMatch = { orderId: string };

type CallKind = "throttled" | "reinstall" | "failed";

type LoadResult =
  | { kind: "ok"; body: OrderStatusBody }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: CallKind };

type SearchHit =
  | { kind: "one"; order: Record<string, unknown> }
  | { kind: "none" }
  | { kind: "many" }
  | { kind: "failed" }
  | { kind: CallKind };

type LineConnection = { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null };

export function matchOrderRequest(
  method: string,
  pathname: string,
): { match: OrderMatch } | { match: "not-allowed"; allow: string } | { match: "ignore" } {
  if (!pathname.startsWith(ORDERS_PREFIX)) {
    return { match: "ignore" };
  }
  const orderId = decodeOrderId(pathname.slice(ORDERS_PREFIX.length));
  if (orderId === null) {
    return { match: "ignore" };
  }
  if (method !== "GET") {
    return { match: "not-allowed", allow: "GET" };
  }
  return { match: { orderId } };
}

export async function handleOrder(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
  orderId: string,
  url: URL,
): Promise<void> {
  req.resume();
  const lookup = classifyOrderToken(orderId);
  if (lookup.kind === "reject") {
    finish(res, orderNotFound(), orderId, lookup);
    return;
  }
  const admin = await readAdminToken(deps);
  if (!admin.ok) {
    finish(res, admin.problem, orderId, lookup);
    return;
  }
  const addressGate = deps.orderAddressGate === true;
  const presentedEmail = addressGate ? singleQueryEmail(url) : undefined;
  const loaded = await loadOrder(deps, admin.token, lookup, addressGate, presentedEmail);
  switch (loaded.kind) {
    case "ok":
      if (!validateOrderStatus(loaded.body)) {
        finish(res, internalError("The order response could not be completed."), orderId, lookup);
        return;
      }
      logOrder(200, orderId, lookup);
      writeJson(res, 200, loaded.body, NO_STORE);
      return;
    case "not_found":
      finish(res, orderNotFound(), orderId, lookup);
      return;
    case "throttled":
      finish(res, rateLimited("Shopify throttled the order request."), orderId, lookup);
      return;
    case "reinstall":
      finish(res, internalError(REINSTALL_DETAIL), orderId, lookup);
      return;
    case "failed":
      finish(res, internalError("The order request could not be completed."), orderId, lookup);
      return;
    case "invalid":
      finish(res, internalError("The order response could not be completed."), orderId, lookup);
      return;
    default: {
      const unexpected: never = loaded;
      throw new Error(`Unhandled order result: ${String(unexpected)}`);
    }
  }
}

async function loadOrder(
  deps: ConnectorDeps,
  token: string,
  lookup: Exclude<OrderLookup, { kind: "reject" }>,
  addressGate: boolean,
  presentedEmail: string | undefined,
): Promise<LoadResult> {
  switch (lookup.kind) {
    case "gid":
      return loadById(deps, token, lookup.gid, addressGate, presentedEmail);
    case "digits":
      return loadDigits(deps, token, lookup.digits, lookup.responseId, addressGate, presentedEmail);
    case "search":
      return loadSearch(deps, token, lookup.value, lookup.responseId, addressGate, presentedEmail);
    default: {
      const unexpected: never = lookup;
      throw new Error(`Unhandled order lookup: ${String(unexpected)}`);
    }
  }
}

async function loadDigits(
  deps: ConnectorDeps,
  token: string,
  digits: string,
  responseId: string,
  addressGate: boolean,
  presentedEmail: string | undefined,
): Promise<LoadResult> {
  const query = nameSearchQuery(digits);
  if (query === null) {
    return { kind: "not_found" };
  }
  const hit = await searchOnce(deps, token, query, addressGate);
  if (hit.kind === "one") {
    return complete(
      hit.order,
      "client",
      responseId,
      (after) => searchPage(deps, token, query, after),
      addressGate,
      presentedEmail,
    );
  }
  if (hit.kind === "many") {
    return { kind: "not_found" };
  }
  if (hit.kind !== "none") {
    return { kind: hit.kind };
  }
  const gid = legacyOrderGid(digits);
  if (gid === null) {
    return { kind: "not_found" };
  }
  return loadById(deps, token, gid, addressGate, presentedEmail);
}

async function loadSearch(
  deps: ConnectorDeps,
  token: string,
  value: string,
  responseId: string,
  addressGate: boolean,
  presentedEmail: string | undefined,
): Promise<LoadResult> {
  const query = tokenSearchQuery(value);
  if (query === null) {
    return { kind: "not_found" };
  }
  const hit = await searchOnce(deps, token, query, addressGate);
  if (hit.kind === "one") {
    return complete(
      hit.order,
      "client",
      responseId,
      (after) => searchPage(deps, token, query, after),
      addressGate,
      presentedEmail,
    );
  }
  if (hit.kind === "none" || hit.kind === "many") {
    return { kind: "not_found" };
  }
  return { kind: hit.kind };
}

async function loadById(
  deps: ConnectorDeps,
  token: string,
  gid: string,
  addressGate: boolean,
  presentedEmail: string | undefined,
): Promise<LoadResult> {
  const hit = await orderOnce(deps, token, gid, addressGate);
  if (hit.kind !== "one") {
    if (hit.kind === "none" || hit.kind === "many") {
      return { kind: "not_found" };
    }
    return { kind: hit.kind };
  }
  return complete(
    hit.order,
    "name",
    "",
    (after) => orderPage(deps, token, gid, after),
    addressGate,
    presentedEmail,
  );
}

async function complete(
  order: Record<string, unknown>,
  idMode: IdMode,
  clientId: string,
  nextOrder: (after: string) => Promise<SearchHit>,
  addressGate: boolean,
  presentedEmail: string | undefined,
): Promise<LoadResult> {
  const lines = await collectLines(order, nextOrder);
  if (lines.kind !== "ok") {
    return lines;
  }
  const mapped = mapOrder(order, lines.lines, idMode, clientId);
  if (mapped.kind !== "ok") {
    return { kind: "invalid" };
  }
  if (addressGate && addressGateOpens(presentedEmail, order)) {
    attachAddresses(mapped.body, order);
  }
  return { kind: "ok", body: mapped.body };
}

function addressGateOpens(presentedEmail: string | undefined, order: Record<string, unknown>): boolean {
  if (presentedEmail === undefined) {
    return false;
  }
  const presented = presentedEmail.trim();
  if (validateEmail(presented) !== true) {
    return false;
  }
  const stored = order.email;
  if (typeof stored !== "string") {
    return false;
  }
  const expected = stored.trim();
  if (expected === "") {
    return false;
  }
  return presented.toLowerCase() === expected.toLowerCase();
}

function attachAddresses(body: OrderStatusBody, order: Record<string, unknown>): void {
  const shipping = mapMailingAddress(order.shippingAddress);
  const billing = mapMailingAddress(order.billingAddress);
  if (shipping !== undefined) {
    body.order.shippingAddress = shipping;
  }
  if (billing !== undefined) {
    body.order.billingAddress = billing;
  }
}

function singleQueryEmail(url: URL): string | undefined {
  const values = url.searchParams.getAll("email");
  if (values.length !== 1) {
    return undefined;
  }
  return values[0];
}

async function collectLines(
  order: Record<string, unknown>,
  nextOrder: (after: string) => Promise<SearchHit>,
): Promise<{ kind: "ok"; lines: unknown[] } | { kind: "invalid" } | { kind: CallKind }> {
  const first = readLineConnection(order);
  if (first === null) {
    return { kind: "invalid" };
  }
  const lines = [...first.nodes];
  let hasNextPage = first.hasNextPage;
  let cursor = first.endCursor;
  let page = 0;
  while (hasNextPage) {
    if (cursor === null || page >= MAX_LINE_PAGES) {
      return { kind: "invalid" };
    }
    page += 1;
    const previous = cursor;
    const hit = await nextOrder(cursor);
    if (hit.kind !== "one") {
      if (hit.kind === "none" || hit.kind === "many") {
        return { kind: "failed" };
      }
      return { kind: hit.kind };
    }
    const connection = readLineConnection(hit.order);
    if (connection === null || (connection.hasNextPage && connection.endCursor === previous)) {
      return { kind: "invalid" };
    }
    lines.push(...connection.nodes);
    hasNextPage = connection.hasNextPage;
    cursor = connection.endCursor;
  }
  return { kind: "ok", lines };
}

async function searchOnce(deps: ConnectorDeps, token: string, query: string, addressGate: boolean): Promise<SearchHit> {
  const document = addressGate ? ORDERS_BY_QUERY_ADDRESS_DOCUMENT : ORDERS_BY_QUERY_DOCUMENT;
  const call = await adminCall(deps, token, document, { query, after: null }, addressGate);
  return hitFromOrders(call);
}

async function searchPage(deps: ConnectorDeps, token: string, query: string, after: string): Promise<SearchHit> {
  const call = await adminCall(deps, token, ORDERS_BY_QUERY_DOCUMENT, { query, after }, false);
  return hitFromOrders(call);
}

async function orderOnce(deps: ConnectorDeps, token: string, id: string, addressGate: boolean): Promise<SearchHit> {
  const document = addressGate ? ORDER_BY_ID_ADDRESS_DOCUMENT : ORDER_BY_ID_DOCUMENT;
  const call = await adminCall(deps, token, document, { id, after: null }, addressGate);
  return hitFromOrder(call);
}

async function orderPage(deps: ConnectorDeps, token: string, id: string, after: string): Promise<SearchHit> {
  const call = await adminCall(deps, token, ORDER_BY_ID_DOCUMENT, { id, after }, false);
  return hitFromOrder(call);
}

function hitFromOrders(call: OrderAdminCall): SearchHit {
  if (call.kind !== "ok") {
    return call;
  }
  if (!isRecord(call.data) || !isRecord(call.data.orders) || !Array.isArray(call.data.orders.nodes)) {
    return { kind: "failed" };
  }
  const nodes = call.data.orders.nodes;
  if (nodes.length === 0) {
    return { kind: "none" };
  }
  if (nodes.length > 1) {
    return { kind: "many" };
  }
  const node = nodes[0];
  if (!isRecord(node)) {
    return { kind: "failed" };
  }
  return { kind: "one", order: node };
}

function hitFromOrder(call: OrderAdminCall): SearchHit {
  if (call.kind !== "ok") {
    return call;
  }
  if (!isRecord(call.data) || !Object.hasOwn(call.data, "order")) {
    return { kind: "failed" };
  }
  if (call.data.order === null) {
    return { kind: "none" };
  }
  if (!isRecord(call.data.order)) {
    return { kind: "failed" };
  }
  return { kind: "one", order: call.data.order };
}

function readLineConnection(order: Record<string, unknown>): LineConnection | null {
  const connection = order.lineItems;
  if (!isRecord(connection) || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
    return null;
  }
  if (typeof connection.pageInfo.hasNextPage !== "boolean") {
    return null;
  }
  const endCursor = connection.pageInfo.endCursor;
  if (connection.pageInfo.hasNextPage) {
    if (typeof endCursor !== "string" || endCursor === "") {
      return null;
    }
    return { nodes: connection.nodes, hasNextPage: true, endCursor };
  }
  if (endCursor !== undefined && endCursor !== null && typeof endCursor !== "string") {
    return null;
  }
  return {
    nodes: connection.nodes,
    hasNextPage: false,
    endCursor: typeof endCursor === "string" ? endCursor : null,
  };
}

function adminCall(
  deps: ConnectorDeps,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  addressGate: boolean,
): Promise<OrderAdminCall> {
  return orderAdminGraphql({
    url: adminGraphqlUrl(deps.app.shopDomain, deps.app.apiVersion),
    tokenHeader: "X-Shopify-Access-Token",
    token,
    query,
    variables,
    fetch: deps.fetch,
    sleep: deps.sleep ?? defaultSleep,
    addressGate,
  });
}

async function readAdminToken(
  deps: ConnectorDeps,
): Promise<{ ok: true; token: string } | { ok: false; problem: Problem }> {
  const access = await prepareCommerceAccess(deps);
  if (access.kind === "unavailable") {
    return { ok: false, problem: internalError(access.detail) };
  }
  const missing = installedProblem(deps);
  if (missing !== undefined) {
    return { ok: false, problem: missing };
  }
  try {
    const row = deps.tokens.get();
    if (row === null || row.accessToken === null) {
      return { ok: false, problem: internalError(REINSTALL_DETAIL) };
    }
    return { ok: true, token: row.accessToken };
  } catch (error) {
    if (error instanceof TokenDecryptError) {
      return { ok: false, problem: internalError(DECRYPT_DETAIL) };
    }
    throw error;
  }
}

function finish(res: ServerResponse, problem: Problem, orderId: string, lookup: OrderLookup): void {
  logOrder(problem.status, orderId, lookup);
  writeProblem(res, problem);
}

function logOrder(status: number, orderId: string, lookup: OrderLookup): void {
  console.log(`order status ${status} ${orderLogLabel(orderId, lookup)}`);
}

function orderLogLabel(orderId: string, lookup: OrderLookup): string {
  switch (lookup.kind) {
    case "reject":
      return "rejected token";
    case "gid":
      return "gid lookup";
    case "digits":
    case "search":
      return orderId;
    default: {
      const unexpected: never = lookup;
      throw new Error(`Unhandled order lookup: ${String(unexpected)}`);
    }
  }
}

function decodeOrderId(rest: string): string | null {
  if (rest === "") {
    return "";
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

function compileOrderSchema(): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(join(readPackageMetadata(import.meta.url).root, "schemas", "order-status.json"), "utf8"),
  ) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormatsModule.default(ajv, ["date", "date-time", "uri"]);
  return ajv.compile(schema);
}

function compileEmailFormat(): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormatsModule.default(ajv, ["email"]);
  return ajv.compile({ type: "string", format: "email" });
}
