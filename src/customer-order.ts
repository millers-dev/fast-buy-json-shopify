/**
 * Customer-mode order ownership.
 * The plan is `docs/SHOPIFY_CUSTOMER_ACCOUNTS_PLAN.md` in millers-dev/fast-buy-json.
 * That file is not in this repository.
 */
import type { IncomingMessage } from "node:http";

import {
  CUSTOMER_APP_URL_DETAIL,
  CUSTOMER_LOGIN_INCOMPLETE_DETAIL,
  acceptedCustomerGid,
  customerSub,
  fastBuyJwtUsable,
  verifyFastBuyJwt,
  type FastBuyJwtClaims,
} from "./customer-login-crypto.js";
import { CUSTOMER_USER_AGENT } from "./customer-login-shopify.js";
import type { ConnectorDeps } from "./deps.js";
import { isRecord } from "./json.js";
import { classifyOrderToken, type IdMode, type OrderLookup } from "./order-map.js";
import {
  CUSTOMER_OWNED_ORDERS_DOCUMENT,
  customerOrdersIdQuery,
  customerOrdersNameQuery,
  orderGidDigits,
  tokenSearchQuery,
} from "./order-query.js";
import {
  REINSTALL_DETAIL,
  authenticationRequired,
  internalError,
  invalidToken,
  orderNotFound,
  rateLimited,
  type Problem,
} from "./problems.js";
import { safeEqual } from "./shopify-hmac.js";
import { customerAccountGraphql, defaultSleep, type CustomerAccountCall } from "./shopify-graphql.js";

const ORDER_NODE_GID = /^gid:\/\/shopify\/Order\/[0-9]+$/;
const WWW_AUTHENTICATE: Record<string, string> = { "WWW-Authenticate": "Bearer" };

export type CustomerOwnership =
  | { kind: "problem"; problem: Problem; lookup: OrderLookup; headers: Record<string, string> }
  | { kind: "ready"; gid: string; idMode: IdMode; clientId: string; lookup: OrderLookup };

type OwnedSearch =
  | { kind: "ready"; gid: string; idMode: IdMode; clientId: string }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "mismatch" }
  | { kind: "reinstall" }
  | { kind: "throttled" }
  | { kind: "failed" };

type Interpreted =
  | { kind: "one"; gid: string }
  | { kind: "none" }
  | { kind: "many" }
  | { kind: "unauthorized" }
  | { kind: "mismatch" }
  | { kind: "reinstall" }
  | { kind: "throttled" }
  | { kind: "failed" };

/**
 * Customer-mode order gate. Admin is not called here. Exactly one owned GID
 * is `ready`. A customer id that does not HMAC to the session `sub` deletes
 * that session.
 */
export async function resolveCustomerOwnership(
  req: IncomingMessage,
  deps: ConnectorDeps,
  orderId: string,
): Promise<CustomerOwnership> {
  deps.tokens.customer.purge(deps.now());
  const lookup = classifyOrderToken(orderId);
  const secret = deps.customerSubSecret;
  const jwtSecret = deps.jwtSecret;
  if (secret === undefined || jwtSecret === undefined) {
    return ownershipProblem(internalError(CUSTOMER_LOGIN_INCOMPLETE_DETAIL), lookup, {});
  }
  const auth = readOrderJwt(req, deps, jwtSecret);
  if (auth.kind !== "ok") {
    return ownershipProblem(auth.problem, lookup, WWW_AUTHENTICATE);
  }
  const session = deps.tokens.customer.getSession(deps.app.shopDomain, auth.claims.sub);
  if (session === null || session.accessToken === "" || session.expiresAt <= deps.now()) {
    return ownershipProblem(invalidToken(), lookup, WWW_AUTHENTICATE);
  }
  // Rows minted before ownership stored no Customer Account API URL.
  // The buyer logs in again. Deleting the row avoids a repeated 500 for a session that cannot call customer.orders.
  const graphqlApi = session.graphqlApi;
  if (graphqlApi === null || !httpsCustomerGraphqlUrl(graphqlApi)) {
    deps.tokens.customer.deleteSession(auth.claims.sub);
    return ownershipProblem(invalidToken(), lookup, WWW_AUTHENTICATE);
  }
  if (lookup.kind === "reject") {
    return ownershipProblem(orderNotFound(), lookup, {});
  }
  const origin = deps.app.appUrl;
  if (origin === undefined) {
    return ownershipProblem(internalError(CUSTOMER_APP_URL_DETAIL), lookup, {});
  }
  const owned = await findOwnedOrder(deps, secret, auth.claims.sub, session.accessToken, origin, graphqlApi, lookup);
  switch (owned.kind) {
    case "ready":
      return {
        kind: "ready",
        gid: owned.gid,
        idMode: owned.idMode,
        clientId: owned.clientId,
        lookup,
      };
    case "not_found":
      return ownershipProblem(orderNotFound(), lookup, {});
    case "unauthorized":
      return ownershipProblem(invalidToken(), lookup, WWW_AUTHENTICATE);
    case "mismatch":
      deps.tokens.customer.deleteSession(auth.claims.sub);
      return ownershipProblem(invalidToken(), lookup, WWW_AUTHENTICATE);
    case "reinstall":
      return ownershipProblem(internalError(REINSTALL_DETAIL), lookup, {});
    case "throttled":
      return ownershipProblem(rateLimited("Shopify throttled the order request."), lookup, {});
    case "failed":
      return ownershipProblem(internalError("The order request could not be completed."), lookup, {});
    default: {
      const unexpected: never = owned;
      throw new Error(`Unhandled ownership result: ${String(unexpected)}`);
    }
  }
}

function readOrderJwt(
  req: IncomingMessage,
  deps: ConnectorDeps,
  jwtSecret: string,
): { kind: "ok"; claims: FastBuyJwtClaims } | { kind: "problem"; problem: Problem } {
  const header = req.headers.authorization;
  if (header === undefined || (typeof header === "string" && header.trim() === "")) {
    return { kind: "problem", problem: authenticationRequired() };
  }
  if (typeof header !== "string") {
    return { kind: "problem", problem: invalidToken() };
  }
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  const token = match?.[1];
  if (token === undefined) {
    return { kind: "problem", problem: invalidToken() };
  }
  const claims = verifyFastBuyJwt(jwtSecret, token);
  if (claims === null || !fastBuyJwtUsable(claims, deps.now())) {
    return { kind: "problem", problem: invalidToken() };
  }
  return { kind: "ok", claims };
}

async function findOwnedOrder(
  deps: ConnectorDeps,
  secret: string,
  sub: string,
  accessToken: string,
  origin: string,
  graphqlApi: string,
  lookup: Exclude<OrderLookup, { kind: "reject" }>,
): Promise<OwnedSearch> {
  switch (lookup.kind) {
    case "gid":
      return findByGid(deps, secret, sub, accessToken, origin, graphqlApi, lookup.gid);
    case "digits":
      return findByDigits(deps, secret, sub, accessToken, origin, graphqlApi, lookup.digits, lookup.responseId);
    case "search":
      return findBySearch(deps, secret, sub, accessToken, origin, graphqlApi, lookup.value, lookup.responseId);
    default: {
      const unexpected: never = lookup;
      throw new Error(`Unhandled order lookup: ${String(unexpected)}`);
    }
  }
}

async function findByGid(
  deps: ConnectorDeps,
  secret: string,
  sub: string,
  accessToken: string,
  origin: string,
  graphqlApi: string,
  gid: string,
): Promise<OwnedSearch> {
  const digits = orderGidDigits(gid);
  const query = digits === null ? null : customerOrdersIdQuery(digits);
  if (query === null) {
    return { kind: "not_found" };
  }
  const hit = await queryOwned(deps, secret, sub, accessToken, origin, graphqlApi, query, gid);
  if (hit.kind === "one") {
    return { kind: "ready", gid: hit.gid, idMode: "name", clientId: "" };
  }
  if (hit.kind === "none" || hit.kind === "many") {
    return { kind: "not_found" };
  }
  return hit;
}

async function findByDigits(
  deps: ConnectorDeps,
  secret: string,
  sub: string,
  accessToken: string,
  origin: string,
  graphqlApi: string,
  digits: string,
  responseId: string,
): Promise<OwnedSearch> {
  const nameQuery = customerOrdersNameQuery(digits);
  const idQuery = customerOrdersIdQuery(digits);
  if (nameQuery === null || idQuery === null) {
    return { kind: "not_found" };
  }
  const named = await queryOwned(deps, secret, sub, accessToken, origin, graphqlApi, nameQuery, null);
  if (named.kind === "one") {
    return { kind: "ready", gid: named.gid, idMode: "client", clientId: responseId };
  }
  if (named.kind === "many") {
    return { kind: "not_found" };
  }
  if (named.kind !== "none") {
    return named;
  }
  const byId = await queryOwned(deps, secret, sub, accessToken, origin, graphqlApi, idQuery, null);
  if (byId.kind === "one") {
    return { kind: "ready", gid: byId.gid, idMode: "name", clientId: "" };
  }
  if (byId.kind === "none" || byId.kind === "many") {
    return { kind: "not_found" };
  }
  return byId;
}

async function findBySearch(
  deps: ConnectorDeps,
  secret: string,
  sub: string,
  accessToken: string,
  origin: string,
  graphqlApi: string,
  value: string,
  responseId: string,
): Promise<OwnedSearch> {
  const query = tokenSearchQuery(value);
  if (query === null) {
    return { kind: "not_found" };
  }
  const hit = await queryOwned(deps, secret, sub, accessToken, origin, graphqlApi, query, null);
  if (hit.kind === "one") {
    return { kind: "ready", gid: hit.gid, idMode: "client", clientId: responseId };
  }
  if (hit.kind === "none" || hit.kind === "many") {
    return { kind: "not_found" };
  }
  return hit;
}

async function queryOwned(
  deps: ConnectorDeps,
  secret: string,
  sub: string,
  accessToken: string,
  origin: string,
  graphqlApi: string,
  search: string,
  expectedGid: string | null,
): Promise<Interpreted> {
  const call = await customerAccountGraphql({
    url: graphqlApi,
    accessToken,
    origin,
    userAgent: CUSTOMER_USER_AGENT,
    query: CUSTOMER_OWNED_ORDERS_DOCUMENT,
    variables: { query: search },
    fetch: deps.fetch,
    sleep: deps.sleep ?? defaultSleep,
  });
  return interpretCall(call, secret, sub, expectedGid);
}

function interpretCall(call: CustomerAccountCall, secret: string, sub: string, expectedGid: string | null): Interpreted {
  switch (call.kind) {
    case "ok":
      return interpretOwned(call.data, secret, sub, expectedGid);
    case "unauthorized":
    case "reinstall":
    case "throttled":
    case "failed":
      return call;
    default: {
      const unexpected: never = call;
      throw new Error(`Unhandled customer account call: ${String(unexpected)}`);
    }
  }
}

function interpretOwned(data: unknown, secret: string, sub: string, expectedGid: string | null): Interpreted {
  if (!isRecord(data) || !isRecord(data.customer)) {
    return { kind: "mismatch" };
  }
  const customerId = data.customer.id;
  if (typeof customerId !== "string" || !acceptedCustomerGid(customerId) || !safeEqual(customerSub(secret, customerId), sub)) {
    return { kind: "mismatch" };
  }
  const orders = data.customer.orders;
  if (!isRecord(orders) || !Array.isArray(orders.nodes)) {
    return { kind: "failed" };
  }
  if (orders.nodes.length === 0) {
    return { kind: "none" };
  }
  if (orders.nodes.length > 1) {
    return { kind: "many" };
  }
  const node = orders.nodes[0];
  if (!isRecord(node) || typeof node.id !== "string" || !ORDER_NODE_GID.test(node.id)) {
    return { kind: "failed" };
  }
  if (expectedGid !== null && node.id !== expectedGid) {
    return { kind: "none" };
  }
  return { kind: "one", gid: node.id };
}

function httpsCustomerGraphqlUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function ownershipProblem(problem: Problem, lookup: OrderLookup, headers: Record<string, string>): CustomerOwnership {
  return { kind: "problem", problem, lookup, headers };
}
