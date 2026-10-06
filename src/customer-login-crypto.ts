import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { safeEqual } from "./shopify-hmac.js";

export const CUSTOMER_AUTHORIZE_SCOPE = "openid email customer-account-api:full";
export const LOGIN_COOKIE_NAME = "__Host-fastbuyjson-login";
export const CUSTOMER_LOGIN_GRANT_SENTENCE =
  "Sign in to read your orders from this shop, including status, items, totals, tracking, and shipping and billing addresses.";

export const CUSTOMER_DISCOVERY_DETAIL = "Customer accounts must be enabled and discovery failed.";
export const CUSTOMER_MISCONFIGURED_DETAIL = "Customer login is misconfigured.";
export const CUSTOMER_LOGIN_INCOMPLETE_DETAIL = "Customer login could not be completed.";
export const CUSTOMER_APP_URL_DETAIL = "Customer login requires an https APP_URL.";
export const CUSTOMER_RATE_DETAIL = "Too many customer login attempts.";

export const CUSTOMER_POLL_TTL_MS = 10 * 60 * 1000;
export const CUSTOMER_START_LIMIT = 10;
export const CUSTOMER_START_WINDOW_MS = 10 * 60 * 1000;
export const CUSTOMER_LIVE_POLL_CAP = 100;
export const CUSTOMER_POLL_INTERVAL_MS = 2_000;
export const CUSTOMER_JWT_MAX_SECONDS = 3600;
export const LOGIN_COOKIE_MAX_AGE_SECONDS = 600;

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/\d+$/;

/** Per-process start counter. It is not written to SQLite and resets when the process restarts. */
export class LoginAttemptLog {
  private readonly buckets = new Map<string, number[]>();

  allowed(key: string, now: number): boolean {
    return this.recent(key, now).length < CUSTOMER_START_LIMIT;
  }

  record(key: string, now: number): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.buckets.set(key, recent);
  }

  private recent(key: string, now: number): number[] {
    const windowStart = now - CUSTOMER_START_WINDOW_MS;
    return (this.buckets.get(key) ?? []).filter((at) => at > windowStart);
  }
}

export function createLoginSecret(): string {
  return randomBytes(16).toString("base64url");
}

export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createUserCode(): string {
  const bytes = randomBytes(8);
  let raw = "";
  for (const byte of bytes) {
    raw += USER_CODE_ALPHABET[byte & 31] ?? "";
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function acceptedCustomerGid(value: string): boolean {
  return CUSTOMER_GID.test(value);
}

export function customerSub(secret: string, customerGid: string): string {
  return createHmac("sha256", secret).update(customerGid, "utf8").digest("base64url");
}

export function jwtLifetimeSeconds(expiresIn: number): number | null {
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }
  const seconds = Math.floor(expiresIn);
  if (seconds <= 0) {
    return null;
  }
  return Math.min(CUSTOMER_JWT_MAX_SECONDS, seconds);
}

export function signFastBuyJwt(secret: string, sub: string, nowMs: number, lifetimeSeconds: number): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + lifetimeSeconds;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat, exp }), "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export type FastBuyJwtClaims = {
  sub: string;
  iat: number;
  exp: number;
};

/**
 * Checks the HMAC and the claim set. Expiry is enforced when an order read accepts the JWT (PR 3).
 */
export function verifyFastBuyJwt(secret: string, token: string): FastBuyJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const header = parts[0];
  const payload = parts[1];
  const signature = parts[2];
  if (header === undefined || payload === undefined || signature === undefined) {
    return null;
  }
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  if (!safeEqual(expected, signature)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { sub?: unknown; iat?: unknown; exp?: unknown };
  if (typeof record.sub !== "string" || record.sub === "") {
    return null;
  }
  if (typeof record.iat !== "number" || typeof record.exp !== "number") {
    return null;
  }
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.includes("sub") || !keys.includes("iat") || !keys.includes("exp")) {
    return null;
  }
  return { sub: record.sub, iat: record.iat, exp: record.exp };
}

export function idTokenNonce(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (payload === undefined || payload === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const nonce = (parsed as { nonce?: unknown }).nonce;
    return typeof nonce === "string" && nonce !== "" ? nonce : null;
  } catch {
    return null;
  }
}

export function customerGidFromWebhook(body: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const customer = (parsed as { customer?: unknown }).customer;
    if (typeof customer !== "object" || customer === null) {
      return null;
    }
    const id = (customer as { id?: unknown }).id;
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) {
      return `gid://shopify/Customer/${id}`;
    }
    if (typeof id === "string" && /^\d+$/.test(id)) {
      return `gid://shopify/Customer/${id}`;
    }
    return null;
  } catch {
    return null;
  }
}

export type ClientAddress = { kind: "ok"; key: string } | { kind: "rejected" };

export function clientAddressForLogin(
  remoteAddress: string | undefined,
  forwardedFor: readonly string[],
  hops: number,
): ClientAddress {
  if (hops === 0) {
    const key = normalizeIp(remoteAddress ?? "");
    return key === null ? { kind: "rejected" } : { kind: "ok", key };
  }
  if (forwardedFor.length < hops) {
    return { kind: "rejected" };
  }
  const entry = forwardedFor[forwardedFor.length - hops];
  if (entry === undefined || entry === "") {
    return { kind: "rejected" };
  }
  const key = normalizeIp(entry);
  return key === null ? { kind: "rejected" } : { kind: "ok", key };
}

/** Repeated X-Forwarded-For headers, in header order, split on commas, each entry trimmed. */
export function forwardedForEntries(rawHeaders: readonly string[]): string[] {
  const parts: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined && name.toLowerCase() === "x-forwarded-for") {
      parts.push(value);
    }
  }
  return parts.join(",").split(",").map((entry) => entry.trim());
}

/** IPv4 text, or the lowercase RFC 5952 form of an IPv6 address. */
export function normalizeIp(value: string): string | null {
  if (isIP(value) === 4) {
    return value;
  }
  if (isIP(value) !== 6) {
    return null;
  }
  const hextets = expandIpv6(value);
  if (hextets === null) {
    return null;
  }
  return compressIpv6(hextets);
}

function expandIpv6(value: string): number[] | null {
  let input = value;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input);
  if (dotted?.[1] !== undefined && dotted[2] !== undefined && isIP(dotted[2]) === 4) {
    const parts = dotted[2].split(".").map((part) => Number(part));
    const high = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    const third = parts[2] ?? 0;
    const low = parts[3] ?? 0;
    const hi = ((high << 8) | second).toString(16);
    const lo = ((third << 8) | low).toString(16);
    input = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = parseHextets(halves[0] ?? "");
  if (left === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseHextets(halves[1] ?? "");
  if (right === null || left.length + right.length > 7) {
    return null;
  }
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function parseHextets(side: string): number[] | null {
  if (side === "") {
    return [];
  }
  const values: number[] = [];
  for (const piece of side.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) {
      return null;
    }
    values.push(Number.parseInt(piece, 16));
  }
  return values;
}

function compressIpv6(hextets: number[]): string {
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;
    return `::ffff:${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
  }
  let bestStart = -1;
  let bestLength = 0;
  let index = 0;
  while (index < hextets.length) {
    if (hextets[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < hextets.length && hextets[end] === 0) {
      end += 1;
    }
    const length = end - index;
    if (length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }
  const parts = hextets.map((part) => part.toString(16));
  if (bestLength < 2 || bestStart < 0) {
    return parts.join(":");
  }
  const left = parts.slice(0, bestStart).join(":");
  const right = parts.slice(bestStart + bestLength).join(":");
  if (left === "" && right === "") {
    return "::";
  }
  if (left === "") {
    return `::${right}`;
  }
  if (right === "") {
    return `${left}::`;
  }
  return `${left}::${right}`;
}

export function loginSecretShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,128}$/.test(value);
}
