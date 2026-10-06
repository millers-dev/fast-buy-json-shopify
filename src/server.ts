import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handleCart, matchCartRequest } from "./cart.js";
import {
  handleCustomerCallback,
  handleCustomerContinue,
  handleCustomerLogin,
  handleCustomerPoll,
  handleCustomerStart,
  matchCustomerAuth,
  pollTokenInRequest,
} from "./customer-login.js";
import { handleCheckout, matchCheckoutRequest } from "./checkout.js";
import { prepareCommerceAccess } from "./commerce-token.js";
import type { ConnectorConfig } from "./config.js";
import type { ConnectorDeps } from "./deps.js";
import { buildDetectResponse } from "./detect.js";
import {
  AUTH_CALLBACK_PATH,
  AUTH_PATH,
  handleAuthCallback,
  handleAuthStart,
  handleWebhook,
  isWebhookPath,
} from "./http-auth.js";
import { writeJson, writeProblem, writeUnexpected } from "./http-response.js";
import { handleOrder, matchOrderRequest } from "./orders.js";
import { PRODUCTS_SEARCH_PATH, handleProductSearch } from "./product-search.js";
import { handleShipping, matchShippingRequest } from "./shipping.js";
import { internalError, invalidToken } from "./problems.js";

export const DEFAULT_PORT = 3100;
export const BASE_PATH = "/api/fastbuyjson";
export const DETECT_PATH = `${BASE_PATH}/detect`;
export const DETECT_CACHE_CONTROL = "public, max-age=300";

export function createConnectorServer(config: ConnectorConfig, deps?: ConnectorDeps): Server {
  const detectBody = JSON.stringify(buildDetectResponse(config));
  return createServer((req, res) => {
    void route(req, res, detectBody, deps).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) {
        return;
      }
      console.error(error instanceof Error ? error.name : "request failed");
      writeUnexpected(res);
    });
  });
}

export function listen(server: Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("connector is not listening on a TCP port"));
    };
    if (host === undefined) {
      server.listen(port, onListening);
      return;
    }
    server.listen(port, host, onListening);
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  detectBody: string,
  deps: ConnectorDeps | undefined,
): Promise<void> {
  const url = requestUrl(req);
  const pathname = url.pathname;

  if (pathname === DETECT_PATH) {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": DETECT_CACHE_CONTROL,
    });
    res.end(detectBody);
    return;
  }

  const cartRoute = matchCartRequest(req.method ?? "GET", pathname);
  if (cartRoute.match !== "ignore") {
    if (cartRoute.match === "not-allowed") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" }, { Allow: cartRoute.allow, "Cache-Control": "no-store" });
      return;
    }
    if (deps === undefined) {
      req.resume();
      writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
      return;
    }
    await handleCart(req, res, deps, cartRoute.match);
    return;
  }

  const checkoutRoute = matchCheckoutRequest(req.method ?? "GET", pathname);
  if (checkoutRoute.match !== "ignore") {
    if (checkoutRoute.match === "not-allowed") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" }, { Allow: checkoutRoute.allow, "Cache-Control": "no-store" });
      return;
    }
    if (deps === undefined) {
      req.resume();
      writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
      return;
    }
    await handleCheckout(req, res, deps, checkoutRoute.match);
    return;
  }

  const shippingRoute = matchShippingRequest(req.method ?? "GET", pathname);
  if (shippingRoute.match !== "ignore") {
    if (shippingRoute.match === "not-allowed") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" }, { Allow: shippingRoute.allow, "Cache-Control": "no-store" });
      return;
    }
    if (deps === undefined) {
      req.resume();
      writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
      return;
    }
    await handleShipping(req, res, deps);
    return;
  }

  const orderRoute = matchOrderRequest(req.method ?? "GET", pathname);
  if (orderRoute.match !== "ignore") {
    if (orderRoute.match === "not-allowed") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" }, { Allow: orderRoute.allow, "Cache-Control": "no-store" });
      return;
    }
    if (deps === undefined) {
      req.resume();
      writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
      return;
    }
    await handleOrder(req, res, deps, orderRoute.match.orderId, url);
    return;
  }

  if (pathname === PRODUCTS_SEARCH_PATH) {
    if (req.method !== "POST") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST", "Cache-Control": "no-store" });
      return;
    }
    if (deps === undefined) {
      writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
      return;
    }
    await handleProductSearch(req, res, deps);
    return;
  }

  if (deps !== undefined) {
    const customerRoute = matchCustomerAuth(pathname);
    if (customerRoute.kind !== "ignore") {
      if (pollTokenInRequest(url, customerRoute)) {
        req.resume();
        writeProblem(res, invalidToken());
        return;
      }
      switch (customerRoute.kind) {
        case "start":
          await handleCustomerStart(req, res, deps);
          return;
        case "poll":
          await handleCustomerPoll(req, res, deps);
          return;
        case "callback":
          await handleCustomerCallback(req, res, url, deps);
          return;
        case "login":
          await handleCustomerLogin(req, res, customerRoute.loginId, deps);
          return;
        case "continue":
          await handleCustomerContinue(req, res, customerRoute.loginId, deps);
          return;
        case "poll-in-path":
          writeProblem(res, invalidToken());
          return;
        default: {
          const neverRoute: never = customerRoute;
          throw new Error(`Unhandled customer auth route: ${String(neverRoute)}`);
        }
      }
    }
    if (pathname === AUTH_PATH) {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
        return;
      }
      await handleAuthStart(res, deps);
      return;
    }
    if (pathname === AUTH_CALLBACK_PATH) {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
        return;
      }
      await handleAuthCallback(res, url, deps);
      return;
    }
    if (isWebhookPath(pathname)) {
      await handleWebhook(req, res, pathname, deps);
      return;
    }
    if (isCommercePath(pathname)) {
      const access = await prepareCommerceAccess(deps);
      if (access.kind === "unavailable") {
        writeProblem(res, internalError(access.detail));
        return;
      }
    }
  }

  writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
}

function isCommercePath(pathname: string): boolean {
  return pathname.startsWith(`${BASE_PATH}/`) && pathname !== DETECT_PATH;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}
