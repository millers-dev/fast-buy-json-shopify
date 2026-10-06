import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CUSTOMER_APP_URL_DETAIL,
  CUSTOMER_DISCOVERY_DETAIL,
  CUSTOMER_LIVE_POLL_CAP,
  CUSTOMER_LOGIN_INCOMPLETE_DETAIL,
  CUSTOMER_MISCONFIGURED_DETAIL,
  CUSTOMER_POLL_INTERVAL_MS,
  CUSTOMER_POLL_TTL_MS,
  CUSTOMER_RATE_DETAIL,
  LOGIN_COOKIE_MAX_AGE_SECONDS,
  LOGIN_COOKIE_NAME,
  LoginAttemptLog,
  clientAddressForLogin,
  createCodeVerifier,
  createLoginSecret,
  createUserCode,
  customerSub,
  forwardedForEntries,
  idTokenNonce,
  jwtLifetimeSeconds,
  loginSecretShape,
  sha256Hex,
  signFastBuyJwt,
} from "./customer-login-crypto.js";
import { CUSTOMER_LOGIN_CLOSE_PAGE, CUSTOMER_LOGIN_INVALID_PAGE, customerLoginPage } from "./customer-login-html.js";
import {
  customerAuthorizeUrl,
  customerCallbackUrl,
  discoverCustomerAccounts,
  exchangeCustomerCode,
  fetchCustomerId,
  type CustomerDiscovery,
} from "./customer-login-shopify.js";
import type { ConnectorDeps } from "./deps.js";
import { writeJson, writeProblem } from "./http-response.js";
import { isRecord } from "./json.js";
import { internalError, invalidToken, rateLimited } from "./problems.js";
import { RequestBodyTooLargeError, readRequestBody } from "./read-body.js";
import { safeEqual } from "./shopify-hmac.js";
import { TokenDecryptError } from "./token-store.js";

export const CUSTOMER_START_PATH = "/api/fastbuyjson/auth/customer/start";
export const CUSTOMER_POLL_PATH = "/api/fastbuyjson/auth/customer/poll";
export const CUSTOMER_CALLBACK_PATH = "/api/fastbuyjson/auth/customer/callback";
const LOGIN_PREFIX = "/api/fastbuyjson/auth/customer/login/";

const NO_REFERRER = { "Referrer-Policy": "no-referrer" };

export type CustomerAuthRoute =
  | { kind: "start" }
  | { kind: "poll" }
  | { kind: "callback" }
  | { kind: "login"; loginId: string }
  | { kind: "continue"; loginId: string }
  | { kind: "poll-in-path" }
  | { kind: "ignore" };

export function matchCustomerAuth(pathname: string): CustomerAuthRoute {
  if (pathname === CUSTOMER_START_PATH) {
    return { kind: "start" };
  }
  if (pathname === CUSTOMER_POLL_PATH) {
    return { kind: "poll" };
  }
  if (pathname === CUSTOMER_CALLBACK_PATH) {
    return { kind: "callback" };
  }
  if (pathname.startsWith(`${CUSTOMER_POLL_PATH}/`)) {
    return { kind: "poll-in-path" };
  }
  if (!pathname.startsWith(LOGIN_PREFIX)) {
    return { kind: "ignore" };
  }
  const rest = pathname.slice(LOGIN_PREFIX.length);
  if (rest.endsWith("/continue")) {
    const loginId = rest.slice(0, -"/continue".length);
    if (loginId === "" || loginId.includes("/")) {
      return { kind: "ignore" };
    }
    return { kind: "continue", loginId };
  }
  if (rest === "" || rest.includes("/")) {
    return { kind: "ignore" };
  }
  return { kind: "login", loginId: rest };
}

export function pollTokenInRequest(url: URL, route: CustomerAuthRoute): boolean {
  return route.kind === "poll-in-path" || url.searchParams.has("pollToken");
}

export async function handleCustomerStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
): Promise<void> {
  if (req.method !== "POST") {
    req.resume();
    writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST", "Cache-Control": "no-store" });
    logCustomerLogin(deps, "start", 405);
    return;
  }
  try {
    await readRequestBody(req);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      writeJson(res, 413, { error: "payload_too_large" }, { "Cache-Control": "no-store" });
      logCustomerLogin(deps, "start", 413);
      return;
    }
    throw error;
  }
  const address = resolveClientAddress(req, deps);
  if (address.kind === "rejected") {
    writeProblem(res, rateLimited(CUSTOMER_RATE_DETAIL));
    logCustomerLogin(deps, "start", 429);
    return;
  }
  const admitted = await deps.tokens.exclusive(() => admitStart(deps, address.key));
  const outcome = await finishStart(deps, admitted);
  switch (outcome.kind) {
    case "rate":
      writeProblem(res, rateLimited(CUSTOMER_RATE_DETAIL));
      logCustomerLogin(deps, "start", 429);
      return;
    case "app-url":
      writeProblem(res, internalError(CUSTOMER_APP_URL_DETAIL));
      logCustomerLogin(deps, "start", 500);
      return;
    case "discovery":
      writeProblem(res, internalError(CUSTOMER_DISCOVERY_DETAIL));
      logCustomerLogin(deps, "start", 500);
      return;
    case "ok":
      writeJson(res, 200, outcome.body, { "Cache-Control": "no-store" });
      logCustomerLogin(deps, "start", 200);
      return;
    default: {
      const neverOutcome: never = outcome;
      throw new Error(`Unhandled customer login start: ${String(neverOutcome)}`);
    }
  }
}

export async function handleCustomerLogin(
  req: IncomingMessage,
  res: ServerResponse,
  loginId: string,
  deps: ConnectorDeps,
): Promise<void> {
  if (req.method !== "GET") {
    req.resume();
    writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
    logCustomerLogin(deps, "login", 405);
    return;
  }
  if (!loginSecretShape(loginId)) {
    writeHtml(res, 400, CUSTOMER_LOGIN_INVALID_PAGE);
    logCustomerLogin(deps, "login", 400);
    return;
  }
  const opened = await deps.tokens.exclusive(async () => openLoginLink(deps, loginId));
  if (opened.kind === "invalid") {
    writeHtml(res, 400, CUSTOMER_LOGIN_INVALID_PAGE);
    logCustomerLogin(deps, "login", 400);
    return;
  }
  writeHtml(res, 200, customerLoginPage(loginId, opened.userCode), {
    "Set-Cookie": loginCookie(opened.cookie),
  });
  logCustomerLogin(deps, "login", 200);
}

export async function handleCustomerContinue(
  req: IncomingMessage,
  res: ServerResponse,
  loginId: string,
  deps: ConnectorDeps,
): Promise<void> {
  if (req.method !== "POST") {
    req.resume();
    writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST", "Cache-Control": "no-store" });
    logCustomerLogin(deps, "continue", 405);
    return;
  }
  req.resume();
  const cookie = readLoginCookie(headerValue(req, "cookie"));
  if (cookie === undefined || !loginSecretShape(cookie) || !loginSecretShape(loginId) || deps.app.appUrl === undefined) {
    writeHtml(res, 400, CUSTOMER_LOGIN_INVALID_PAGE);
    logCustomerLogin(deps, "continue", 400);
    return;
  }
  const appUrl = deps.app.appUrl;
  const location = await deps.tokens.exclusive(async () => continueLogin(deps, loginId, cookie, appUrl));
  if (location === null) {
    writeHtml(res, 400, CUSTOMER_LOGIN_INVALID_PAGE);
    logCustomerLogin(deps, "continue", 400);
    return;
  }
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
  logCustomerLogin(deps, "continue", 302);
}

export async function handleCustomerCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ConnectorDeps,
): Promise<void> {
  if (req.method !== "GET") {
    req.resume();
    writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
    logCustomerLogin(deps, "callback", 405);
    return;
  }
  const cookie = readLoginCookie(headerValue(req, "cookie"));
  const state = singleQuery(url, "state");
  const code = singleQuery(url, "code");
  if (
    cookie === undefined ||
    !loginSecretShape(cookie) ||
    state === undefined ||
    !loginSecretShape(state) ||
    deps.app.appUrl === undefined
  ) {
    writeHtml(res, 400, CUSTOMER_LOGIN_INVALID_PAGE);
    logCustomerLogin(deps, "callback", 400);
    return;
  }
  const appUrl = deps.app.appUrl;
  const prepared = await deps.tokens.exclusive(async () => prepareCallback(deps, cookie, state));
  if (prepared.kind === "reject") {
    writeHtml(res, 400, CUSTOMER_LOGIN_INVALID_PAGE);
    logCustomerLogin(deps, "callback", 400);
    return;
  }
  if (prepared.kind === "internal") {
    writeProblem(res, internalError(CUSTOMER_LOGIN_INCOMPLETE_DETAIL), NO_REFERRER);
    logCustomerLogin(deps, "callback", 500);
    return;
  }
  if (code === undefined || code === "") {
    await deps.tokens.exclusive(async () => {
      deps.tokens.customer.setOutcome({
        shopDomain: deps.app.shopDomain,
        loginIdHash: prepared.loginIdHash,
        outcome: "invalid",
        jwt: null,
        jwtExpiresIn: null,
      });
    });
    writeHtml(res, 200, CUSTOMER_LOGIN_CLOSE_PAGE);
    logCustomerLogin(deps, "callback", 200);
    return;
  }
  const exchanged = await exchangeCustomerCode({
    tokenEndpoint: prepared.tokenEndpoint,
    clientId: deps.app.clientId,
    redirectUri: customerCallbackUrl(appUrl),
    code,
    codeVerifier: prepared.codeVerifier,
    origin: appUrl,
    fetchImpl: deps.fetch,
  });
  let customerId: string | null = null;
  if (exchanged.ok) {
    const nonce = idTokenNonce(exchanged.idToken);
    if (nonce !== null && safeEqual(nonce, prepared.oauthNonce)) {
      customerId = await fetchCustomerId({
        graphqlApi: prepared.graphqlApi,
        accessToken: exchanged.accessToken,
        origin: appUrl,
        fetchImpl: deps.fetch,
      });
    }
  }
  const finished = await deps.tokens.exclusive(async () =>
    finishCallback(deps, prepared, exchanged, customerId),
  );
  if (finished === "internal") {
    writeProblem(res, internalError(CUSTOMER_LOGIN_INCOMPLETE_DETAIL), NO_REFERRER);
    logCustomerLogin(deps, "callback", 500);
    return;
  }
  writeHtml(res, 200, CUSTOMER_LOGIN_CLOSE_PAGE);
  logCustomerLogin(deps, "callback", 200);
}

export async function handleCustomerPoll(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorDeps,
): Promise<void> {
  if (req.method !== "POST") {
    req.resume();
    writeJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST", "Cache-Control": "no-store" });
    logCustomerLogin(deps, "poll", 405);
    return;
  }
  let pollToken: string | undefined;
  try {
    pollToken = readPollToken(await readRequestBody(req));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      writeJson(res, 413, { error: "payload_too_large" }, { "Cache-Control": "no-store" });
      logCustomerLogin(deps, "poll", 413);
      return;
    }
    throw error;
  }
  if (pollToken === undefined) {
    writeProblem(res, invalidToken());
    logCustomerLogin(deps, "poll", 401);
    return;
  }
  const outcome = await deps.tokens.exclusive(async () => readPoll(deps, pollToken));
  switch (outcome.kind) {
    case "invalid":
      writeProblem(res, invalidToken());
      logCustomerLogin(deps, "poll", 401);
      return;
    case "rate":
      writeProblem(res, rateLimited(CUSTOMER_RATE_DETAIL));
      logCustomerLogin(deps, "poll", 429);
      return;
    case "pending":
      writeJson(res, 200, { status: "pending" }, { "Cache-Control": "no-store" });
      logCustomerLogin(deps, "poll", 200);
      return;
    case "complete":
      writeJson(
        res,
        200,
        {
          status: "complete",
          access_token: outcome.accessToken,
          token_type: "bearer",
          expires_in: outcome.expiresIn,
        },
        { "Cache-Control": "no-store" },
      );
      logCustomerLogin(deps, "poll", 200);
      return;
    case "misconfigured":
      writeProblem(res, internalError(CUSTOMER_MISCONFIGURED_DETAIL));
      logCustomerLogin(deps, "poll", 500);
      return;
    case "internal":
      writeProblem(res, internalError(CUSTOMER_LOGIN_INCOMPLETE_DETAIL));
      logCustomerLogin(deps, "poll", 500);
      return;
    default: {
      const neverOutcome: never = outcome;
      throw new Error(`Unhandled customer login poll: ${String(neverOutcome)}`);
    }
  }
}

type StartOutcome =
  | { kind: "rate" }
  | { kind: "app-url" }
  | { kind: "discovery" }
  | {
      kind: "ok";
      body: { loginUrl: string; pollToken: string; userCode: string; expiresAt: string };
    };

async function finishStart(deps: ConnectorDeps, admitted: StartAdmission): Promise<StartOutcome> {
  if (admitted.kind !== "discover") {
    return admitted;
  }
  const discovery = await discoverCustomerAccounts(deps.app.shopDomain, deps.fetch);
  if (discovery === null) {
    return { kind: "discovery" };
  }
  return deps.tokens.exclusive(() => commitStart(deps, discovery));
}

type StartAdmission = { kind: "rate" } | { kind: "app-url" } | { kind: "discover" };

async function admitStart(deps: ConnectorDeps, addressKey: string): Promise<StartAdmission> {
  const now = deps.now();
  deps.tokens.customer.purge(now);
  const attempts = attemptLog(deps);
  if (!attempts.allowed(addressKey, now)) {
    return { kind: "rate" };
  }
  if (deps.tokens.customer.countLive(now) >= CUSTOMER_LIVE_POLL_CAP) {
    return { kind: "rate" };
  }
  attempts.record(addressKey, now);
  if (deps.app.appUrl === undefined) {
    return { kind: "app-url" };
  }
  return { kind: "discover" };
}

async function commitStart(deps: ConnectorDeps, discovery: CustomerDiscovery): Promise<StartOutcome> {
  const appUrl = deps.app.appUrl;
  if (appUrl === undefined) {
    return { kind: "app-url" };
  }
  const now = deps.now();
  deps.tokens.customer.purge(now);
  if (deps.tokens.customer.countLive(now) >= CUSTOMER_LIVE_POLL_CAP) {
    return { kind: "rate" };
  }
  const loginId = createLoginSecret();
  const pollToken = createLoginSecret();
  const userCode = createUserCode();
  const expiresAt = now + CUSTOMER_POLL_TTL_MS;
  deps.tokens.customer.insertPoll({
    shopDomain: deps.app.shopDomain,
    loginIdHash: sha256Hex(loginId),
    pollTokenHash: sha256Hex(pollToken),
    expiresAt,
    createdAt: now,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    graphqlApi: discovery.graphqlApi,
    userCode,
    oauthNonce: createLoginSecret(),
    codeVerifier: createCodeVerifier(),
  });
  return {
    kind: "ok",
    body: {
      loginUrl: `${appUrl}/api/fastbuyjson/auth/customer/login/${loginId}`,
      pollToken,
      userCode,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

async function openLoginLink(
  deps: ConnectorDeps,
  loginId: string,
): Promise<{ kind: "invalid" } | { kind: "ok"; userCode: string; cookie: string }> {
  const now = deps.now();
  deps.tokens.customer.purge(now);
  const cookie = createLoginSecret();
  const state = createLoginSecret();
  const consumed = deps.tokens.customer.consumeLoginLink({
    shopDomain: deps.app.shopDomain,
    loginIdHash: sha256Hex(loginId),
    cookieHash: sha256Hex(cookie),
    state,
    stateHash: sha256Hex(state),
    now,
  });
  if (consumed !== "ok") {
    return { kind: "invalid" };
  }
  const poll = deps.tokens.customer.getByLoginHash(deps.app.shopDomain, sha256Hex(loginId));
  if (poll === null) {
    throw new TokenDecryptError();
  }
  return { kind: "ok", userCode: poll.userCode, cookie };
}

async function continueLogin(
  deps: ConnectorDeps,
  loginId: string,
  cookie: string,
  appUrl: string,
): Promise<string | null> {
  const now = deps.now();
  deps.tokens.customer.purge(now);
  const poll = deps.tokens.customer.getByLoginHash(deps.app.shopDomain, sha256Hex(loginId));
  if (
    poll === null ||
    poll.expiresAt <= now ||
    !poll.linkConsumed ||
    poll.stateUsed ||
    poll.state === null ||
    poll.cookieHash === null ||
    !safeEqual(poll.cookieHash, sha256Hex(cookie))
  ) {
    return null;
  }
  return customerAuthorizeUrl({
    authorizationEndpoint: poll.authorizationEndpoint,
    clientId: deps.app.clientId,
    redirectUri: customerCallbackUrl(appUrl),
    state: poll.state,
    nonce: poll.oauthNonce,
    codeVerifier: poll.codeVerifier,
  });
}

type PreparedCallback =
  | { kind: "reject" }
  | { kind: "internal" }
  | {
      kind: "ready";
      loginIdHash: string;
      tokenEndpoint: string;
      graphqlApi: string;
      codeVerifier: string;
      oauthNonce: string;
    };

async function prepareCallback(deps: ConnectorDeps, cookie: string, state: string): Promise<PreparedCallback> {
  const now = deps.now();
  deps.tokens.customer.purge(now);
  const cookieHash = sha256Hex(cookie);
  const stateHash = sha256Hex(state);
  const byState = deps.tokens.customer.getByStateHash(deps.app.shopDomain, stateHash);
  const byCookie = deps.tokens.customer.getByCookieHash(deps.app.shopDomain, cookieHash);
  if (
    byState === null ||
    byCookie === null ||
    byState.loginIdHash !== byCookie.loginIdHash ||
    byState.expiresAt <= now ||
    byState.stateUsed ||
    byState.cookieHash === null ||
    !safeEqual(byState.cookieHash, cookieHash)
  ) {
    return { kind: "reject" };
  }
  if (!deps.tokens.customer.markStateUsed(stateHash)) {
    return { kind: "reject" };
  }
  if (deps.customerSubSecret === undefined || deps.jwtSecret === undefined) {
    deps.tokens.customer.setOutcome({
      shopDomain: deps.app.shopDomain,
      loginIdHash: byState.loginIdHash,
      outcome: "internal",
      jwt: null,
      jwtExpiresIn: null,
    });
    return { kind: "internal" };
  }
  return {
    kind: "ready",
    loginIdHash: byState.loginIdHash,
    tokenEndpoint: byState.tokenEndpoint,
    graphqlApi: byState.graphqlApi,
    codeVerifier: byState.codeVerifier,
    oauthNonce: byState.oauthNonce,
  };
}

async function finishCallback(
  deps: ConnectorDeps,
  prepared: Extract<PreparedCallback, { kind: "ready" }>,
  exchanged: Awaited<ReturnType<typeof exchangeCustomerCode>>,
  customerId: string | null,
): Promise<"done" | "internal"> {
  const secret = deps.customerSubSecret;
  const jwtSecret = deps.jwtSecret;
  if (secret === undefined || jwtSecret === undefined) {
    deps.tokens.customer.setOutcome({
      shopDomain: deps.app.shopDomain,
      loginIdHash: prepared.loginIdHash,
      outcome: "internal",
      jwt: null,
      jwtExpiresIn: null,
    });
    return "internal";
  }
  if (!exchanged.ok) {
    deps.tokens.customer.setOutcome({
      shopDomain: deps.app.shopDomain,
      loginIdHash: prepared.loginIdHash,
      outcome: exchanged.kind === "misconfigured" ? "misconfigured" : "invalid",
      jwt: null,
      jwtExpiresIn: null,
    });
    return "done";
  }
  const lifetime = customerId === null ? null : jwtLifetimeSeconds(exchanged.expiresIn);
  if (customerId === null || lifetime === null) {
    deps.tokens.customer.setOutcome({
      shopDomain: deps.app.shopDomain,
      loginIdHash: prepared.loginIdHash,
      outcome: "invalid",
      jwt: null,
      jwtExpiresIn: null,
    });
    return "done";
  }
  const sub = customerSub(secret, customerId);
  const jwt = signFastBuyJwt(jwtSecret, sub, deps.now(), lifetime);
  const tokenSeconds = Math.floor(exchanged.expiresIn);
  deps.tokens.customer.saveSession(
    deps.app.shopDomain,
    sub,
    exchanged.accessToken,
    deps.now() + tokenSeconds * 1000,
    prepared.graphqlApi,
  );
  deps.tokens.customer.setOutcome({
    shopDomain: deps.app.shopDomain,
    loginIdHash: prepared.loginIdHash,
    outcome: "complete",
    jwt,
    jwtExpiresIn: lifetime,
  });
  return "done";
}

type PollOutcome =
  | { kind: "invalid" }
  | { kind: "rate" }
  | { kind: "pending" }
  | { kind: "complete"; accessToken: string; expiresIn: number }
  | { kind: "misconfigured" }
  | { kind: "internal" };

async function readPoll(deps: ConnectorDeps, pollToken: string): Promise<PollOutcome> {
  const now = deps.now();
  deps.tokens.customer.purge(now);
  const poll = deps.tokens.customer.getByPollHash(deps.app.shopDomain, sha256Hex(pollToken));
  if (poll === null || poll.expiresAt <= now) {
    return { kind: "invalid" };
  }
  if (poll.lastPollAt !== null && now - poll.lastPollAt < CUSTOMER_POLL_INTERVAL_MS) {
    return { kind: "rate" };
  }
  deps.tokens.customer.touchPoll(poll.pollTokenHash, now);
  if (poll.outcome === null) {
    return { kind: "pending" };
  }
  if (poll.outcome === "complete") {
    if (poll.jwt === null || poll.jwtExpiresIn === null || poll.jwtExpiresIn <= 0) {
      deps.tokens.customer.deleteByPollHash(poll.pollTokenHash);
      return { kind: "invalid" };
    }
    const accessToken = poll.jwt;
    const expiresIn = poll.jwtExpiresIn;
    deps.tokens.customer.deleteByPollHash(poll.pollTokenHash);
    return { kind: "complete", accessToken, expiresIn };
  }
  // Invalid and misconfigured rows stay until expiresAt. A later poll still reports that outcome.
  if (poll.outcome === "misconfigured") {
    return { kind: "misconfigured" };
  }
  if (poll.outcome === "internal") {
    return { kind: "internal" };
  }
  if (poll.outcome === "invalid") {
    return { kind: "invalid" };
  }
  const neverOutcome: never = poll.outcome;
  throw new Error(`Unhandled poll outcome: ${String(neverOutcome)}`);
}

function resolveClientAddress(req: IncomingMessage, deps: ConnectorDeps): { kind: "ok"; key: string } | { kind: "rejected" } {
  const hops = deps.trustedProxyHops ?? 0;
  const forwarded = hops === 0 ? [] : forwardedForEntries(req.rawHeaders);
  return clientAddressForLogin(req.socket.remoteAddress, forwarded, hops);
}

function attemptLog(deps: ConnectorDeps): LoginAttemptLog {
  if (deps.loginAttempts === undefined) {
    deps.loginAttempts = new LoginAttemptLog();
  }
  return deps.loginAttempts;
}

function readPollToken(body: Buffer): string | undefined {
  if (body.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!isRecord(parsed) || typeof parsed.pollToken !== "string" || !loginSecretShape(parsed.pollToken)) {
      return undefined;
    }
    return parsed.pollToken;
  } catch {
    return undefined;
  }
}

function readLoginCookie(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const splitAt = trimmed.indexOf("=");
    if (splitAt <= 0) {
      continue;
    }
    if (trimmed.slice(0, splitAt) !== LOGIN_COOKIE_NAME) {
      continue;
    }
    const value = trimmed.slice(splitAt + 1);
    return value === "" ? undefined : value;
  }
  return undefined;
}

function loginCookie(value: string): string {
  return `${LOGIN_COOKIE_NAME}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE_SECONDS}`;
}

function singleQuery(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) {
    return undefined;
  }
  return values[0];
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function writeHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(html);
}

function logCustomerLogin(deps: ConnectorDeps, step: string, status: number): void {
  const mode = deps.customerAccounts === true ? "on" : "off";
  console.info(`customer-login ${step} ${status} customer-accounts-${mode}`);
}
