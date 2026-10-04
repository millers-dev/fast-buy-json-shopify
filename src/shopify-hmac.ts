import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function signOauthParams(secret: string, params: ReadonlyMap<string, string>): string {
  const message = [...params.keys()]
    .filter((key) => key !== "hmac")
    .sort()
    .map((key) => `${key}=${params.get(key) ?? ""}`)
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function verifyOauthHmac(secret: string, params: ReadonlyMap<string, string>): boolean {
  const provided = params.get("hmac");
  if (provided === undefined || provided === "") {
    return false;
  }
  return safeEqual(signOauthParams(secret, params), provided);
}

export function signWebhookBody(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

export function verifyWebhookHmac(secret: string, body: Buffer, provided: string): boolean {
  if (provided.trim() === "") {
    return false;
  }
  return safeEqual(signWebhookBody(secret, body), provided.trim());
}
