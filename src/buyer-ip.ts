import { isIP } from "node:net";

/**
 * Public TCP peer for Shopify-Storefront-Buyer-IP.
 * Loopback, private, and non-global addresses are omitted. 127.0.0.1 is never returned.
 */
export function publicBuyerIp(remoteAddress: string | undefined): string | undefined {
  if (remoteAddress === undefined) {
    return undefined;
  }
  const trimmed = remoteAddress.trim();
  if (trimmed === "") {
    return undefined;
  }
  const withoutZone = trimmed.split("%", 1)[0] ?? trimmed;
  const canonical = canonicalIp(withoutZone);
  if (canonical === null || !isPublicAddress(canonical)) {
    return undefined;
  }
  return canonical;
}

function canonicalIp(value: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) {
    return mapped[1];
  }
  if (isIP(value) === 4 || isIP(value) === 6) {
    return value;
  }
  return null;
}

function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    return isPublicV4(ip);
  }
  if (isIP(ip) === 6) {
    return isPublicV6(ip);
  }
  return false;
}

function isPublicV4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 192 && b === 0 && c === 2) {
    return false;
  }
  if (a === 198 && b === 51 && c === 100) {
    return false;
  }
  if (a === 203 && b === 0 && c === 113) {
    return false;
  }
  if (a >= 224) {
    return false;
  }
  return true;
}

function isPublicV6(ip: string): boolean {
  const hextets = ipv6Hextets(ip);
  if (hextets === null) {
    return false;
  }
  const first = hextets[0];
  const second = hextets[1];
  if (first === undefined || second === undefined) {
    return false;
  }
  if (first < 0x2000 || first > 0x3fff) {
    return false;
  }
  if (first === 0x2001 && second === 0x0db8) {
    return false;
  }
  return true;
}

function ipv6Hextets(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = parseSide(halves[0] ?? "");
  if (left === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseSide(halves[1] ?? "");
  if (right === null || left.length + right.length > 7) {
    return null;
  }
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function parseSide(side: string): number[] | null {
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
