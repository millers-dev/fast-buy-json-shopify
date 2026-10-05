import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs, { type Database, type SqlValue } from "sql.js";

import { isRecord } from "./json.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";

export const TOKEN_DATABASE_FILENAME = "fastbuyjson-shopify.sqlite";

export function defaultTokenDatabasePath(cwd: string = process.cwd()): string {
  return join(cwd, TOKEN_DATABASE_FILENAME);
}

export type GrantType = "authorization_code" | "client_credentials";

export type ShopTokenRecord = {
  shopDomain: string;
  grantType: GrantType;
  accessToken: string | null;
  accessExpiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
};

export type DelegateRecord = {
  accessToken: string;
  expiresAt: number | null;
};

export type ShopTokenWrite = {
  shopDomain: string;
  grantType: GrantType;
  accessToken: string;
  accessExpiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
};

export class OneShopError extends Error {
  constructor() {
    super("This process already stores a token for a different shop");
    this.name = "OneShopError";
  }
}

export class TokenDecryptError extends Error {
  constructor() {
    super("TOKEN_ENCRYPTION_KEY cannot decrypt the stored shop token");
    this.name = "TokenDecryptError";
  }
}

const CART_SCHEMA = `
CREATE TABLE IF NOT EXISTS anonymous_cart (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  shop_domain TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  shopify_nonce BLOB NOT NULL,
  shopify_ciphertext BLOB NOT NULL,
  extensions_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const LINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cart_line (
  item_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  line_nonce BLOB NOT NULL,
  line_ciphertext BLOB NOT NULL
)`;

const CHECKOUT_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkout_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cart_id TEXT NOT NULL,
  session_token TEXT NOT NULL,
  verification_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  url_nonce BLOB NOT NULL,
  url_ciphertext BLOB NOT NULL
)`;

const IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_record (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shop_credential (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  shop_domain TEXT NOT NULL,
  grant_type TEXT NOT NULL CHECK (grant_type IN ('authorization_code', 'client_credentials')),
  access_nonce BLOB,
  access_ciphertext BLOB,
  access_expires_at INTEGER,
  refresh_nonce BLOB,
  refresh_ciphertext BLOB,
  refresh_expires_at INTEGER,
  delegate_nonce BLOB,
  delegate_ciphertext BLOB,
  delegate_expires_at INTEGER,
  updated_at INTEGER NOT NULL
)`;

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

function loadSql(): ReturnType<typeof initSqlJs> {
  if (sqlPromise === undefined) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

export class TokenStore {
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly db: Database,
    private readonly filePath: string,
    private readonly key: Buffer,
  ) {}

  static async open(filePath: string, key: Buffer): Promise<TokenStore> {
    const SQL = await loadSql();
    const db = existsSync(filePath)
      ? new SQL.Database(new Uint8Array(readFileSync(filePath)))
      : new SQL.Database();
    db.run(SCHEMA);
    db.run(CART_SCHEMA);
    db.run(LINE_SCHEMA);
    db.run(CHECKOUT_SESSION_SCHEMA);
    db.run(IDEMPOTENCY_SCHEMA);
    return new TokenStore(db, filePath, key);
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get(): ShopTokenRecord | null {
    const row = this.one(
      `SELECT shop_domain, grant_type, access_nonce, access_ciphertext, access_expires_at,
              refresh_nonce, refresh_ciphertext, refresh_expires_at
       FROM shop_credential WHERE singleton = 1`,
    );
    if (row === undefined) {
      return null;
    }
    const shopDomain = readString(row, "shop_domain");
    const grantType = readGrant(row);
    if (shopDomain === null || grantType === null) {
      throw new TokenDecryptError();
    }
    return {
      shopDomain,
      grantType,
      accessToken: this.readSecret(row, "access", `${shopDomain}\u0000access`),
      accessExpiresAt: readNullableInt(row, "access_expires_at"),
      refreshToken: this.readSecret(row, "refresh", `${shopDomain}\u0000refresh`),
      refreshExpiresAt: readNullableInt(row, "refresh_expires_at"),
    };
  }

  save(token: ShopTokenWrite, now: number): void {
    const existing = this.one("SELECT shop_domain FROM shop_credential WHERE singleton = 1");
    if (existing !== undefined) {
      const storedShop = readString(existing, "shop_domain");
      if (storedShop !== token.shopDomain) {
        throw new OneShopError();
      }
    }
    const access = encryptSecret(this.key, token.accessToken, `${token.shopDomain}\u0000access`);
    const refresh =
      token.refreshToken === null
        ? null
        : encryptSecret(this.key, token.refreshToken, `${token.shopDomain}\u0000refresh`);
    const params: SqlValue[] = [
      token.shopDomain,
      token.grantType,
      new Uint8Array(access.nonce),
      new Uint8Array(access.ciphertext),
      token.accessExpiresAt,
      refresh === null ? null : new Uint8Array(refresh.nonce),
      refresh === null ? null : new Uint8Array(refresh.ciphertext),
      token.refreshExpiresAt,
      now,
    ];
    this.db.run(
      `INSERT INTO shop_credential (
         singleton, shop_domain, grant_type,
         access_nonce, access_ciphertext, access_expires_at,
         refresh_nonce, refresh_ciphertext, refresh_expires_at,
         delegate_nonce, delegate_ciphertext, delegate_expires_at,
         updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         shop_domain = excluded.shop_domain,
         grant_type = excluded.grant_type,
         access_nonce = excluded.access_nonce,
         access_ciphertext = excluded.access_ciphertext,
         access_expires_at = excluded.access_expires_at,
         refresh_nonce = excluded.refresh_nonce,
         refresh_ciphertext = excluded.refresh_ciphertext,
         refresh_expires_at = excluded.refresh_expires_at,
         delegate_nonce = NULL,
         delegate_ciphertext = NULL,
         delegate_expires_at = NULL,
         updated_at = excluded.updated_at`,
      params,
    );
    this.persist();
  }

  clearAccessToken(shopDomain: string, now: number): void {
    this.db.run(
      `UPDATE shop_credential
       SET access_nonce = NULL, access_ciphertext = NULL, access_expires_at = NULL,
           delegate_nonce = NULL, delegate_ciphertext = NULL, delegate_expires_at = NULL,
           updated_at = ?
       WHERE singleton = 1 AND shop_domain = ?`,
      [now, shopDomain],
    );
    this.persist();
  }

  clearRefreshToken(shopDomain: string, now: number): void {
    this.db.run(
      `UPDATE shop_credential
       SET refresh_nonce = NULL, refresh_ciphertext = NULL, refresh_expires_at = NULL,
           updated_at = ?
       WHERE singleton = 1 AND shop_domain = ?`,
      [now, shopDomain],
    );
    this.persist();
  }

  deleteShop(shopDomain: string): boolean {
    this.db.run("DELETE FROM shop_credential WHERE singleton = 1 AND shop_domain = ?", [shopDomain]);
    const deleted = this.db.getRowsModified() === 1;
    this.db.run("DELETE FROM anonymous_cart WHERE singleton = 1 AND shop_domain = ?", [shopDomain]);
    const cartDeleted = this.db.getRowsModified() > 0;
    if (cartDeleted) {
      this.db.run("DELETE FROM cart_line");
    }
    let idempotencyDeleted = false;
    if (deleted) {
      this.db.run("DELETE FROM idempotency_record");
      idempotencyDeleted = this.db.getRowsModified() > 0;
    }
    let sessionDeleted = false;
    if (deleted || cartDeleted) {
      this.db.run("DELETE FROM checkout_session");
      sessionDeleted = this.db.getRowsModified() > 0;
    }
    if (deleted || cartDeleted || idempotencyDeleted || sessionDeleted) {
      this.persist();
    }
    return deleted;
  }

  close(): void {
    this.db.close();
  }

  getDelegate(): DelegateRecord | null {
    const row = this.one(
      `SELECT shop_domain, delegate_nonce, delegate_ciphertext, delegate_expires_at
       FROM shop_credential WHERE singleton = 1`,
    );
    if (row === undefined) {
      return null;
    }
    const shopDomain = readString(row, "shop_domain");
    if (shopDomain === null) {
      throw new TokenDecryptError();
    }
    const accessToken = this.readSecret(row, "delegate", `${shopDomain}\u0000delegate`);
    if (accessToken === null) {
      return null;
    }
    return {
      accessToken,
      expiresAt: readNullableInt(row, "delegate_expires_at"),
    };
  }

  saveDelegate(shopDomain: string, accessToken: string, expiresAt: number | null, now: number): boolean {
    const existing = this.one("SELECT shop_domain FROM shop_credential WHERE singleton = 1");
    if (existing === undefined || readString(existing, "shop_domain") !== shopDomain) {
      return false;
    }
    const delegate = encryptSecret(this.key, accessToken, `${shopDomain}\u0000delegate`);
    this.db.run(
      `UPDATE shop_credential
       SET delegate_nonce = ?, delegate_ciphertext = ?, delegate_expires_at = ?, updated_at = ?
       WHERE singleton = 1 AND shop_domain = ?`,
      [new Uint8Array(delegate.nonce), new Uint8Array(delegate.ciphertext), expiresAt, now, shopDomain],
    );
    this.persist();
    return true;
  }

  clearDelegate(shopDomain: string, now: number): void {
    this.db.run(
      `UPDATE shop_credential
       SET delegate_nonce = NULL, delegate_ciphertext = NULL, delegate_expires_at = NULL, updated_at = ?
       WHERE singleton = 1 AND shop_domain = ?`,
      [now, shopDomain],
    );
    this.persist();
  }

  getAnonymousCart(shopDomain: string): StoredCart | null {
    const row = this.one(
      `SELECT shop_domain, cart_id, shopify_nonce, shopify_ciphertext, extensions_json, created_at, updated_at
       FROM anonymous_cart WHERE singleton = 1`,
    );
    if (row === undefined) {
      return null;
    }
    const domain = readString(row, "shop_domain");
    const cartId = readString(row, "cart_id");
    if (domain === null || cartId === null) {
      throw new TokenDecryptError();
    }
    if (domain !== shopDomain) {
      return null;
    }
    const shopifyCartId = this.readSecret(row, "shopify", cartAad(shopDomain));
    if (shopifyCartId === null) {
      throw new TokenDecryptError();
    }
    const createdAt = readNullableInt(row, "created_at");
    const updatedAt = readNullableInt(row, "updated_at");
    if (createdAt === null || updatedAt === null) {
      throw new TokenDecryptError();
    }
    return {
      cartId,
      shopifyCartId,
      extensions: readExtensions(row.extensions_json),
      createdAt,
      updatedAt,
      lines: this.cartLines(shopDomain),
    };
  }

  saveAnonymousCart(shopDomain: string, cart: StoredCart): void {
    const shopify = encryptSecret(this.key, cart.shopifyCartId, cartAad(shopDomain));
    this.db.run(
      `INSERT INTO anonymous_cart (
         singleton, shop_domain, cart_id, shopify_nonce, shopify_ciphertext, extensions_json, created_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         shop_domain = excluded.shop_domain,
         cart_id = excluded.cart_id,
         shopify_nonce = excluded.shopify_nonce,
         shopify_ciphertext = excluded.shopify_ciphertext,
         extensions_json = excluded.extensions_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [
        shopDomain,
        cart.cartId,
        new Uint8Array(shopify.nonce),
        new Uint8Array(shopify.ciphertext),
        cart.extensions === null ? null : JSON.stringify(cart.extensions),
        cart.createdAt,
        cart.updatedAt,
      ],
    );
    this.db.run("DELETE FROM cart_line");
    for (let position = 0; position < cart.lines.length; position += 1) {
      const line = cart.lines[position];
      if (line === undefined) {
        continue;
      }
      const encrypted = encryptSecret(this.key, line.lineGid, lineAad(shopDomain, line.itemId));
      this.db.run(
        `INSERT INTO cart_line (item_id, position, line_nonce, line_ciphertext) VALUES (?, ?, ?, ?)`,
        [line.itemId, position, new Uint8Array(encrypted.nonce), new Uint8Array(encrypted.ciphertext)],
      );
    }
    this.persist();
  }

  clearAnonymousCart(): void {
    this.db.run("DELETE FROM cart_line");
    this.db.run("DELETE FROM anonymous_cart");
    this.persist();
  }

  saveCheckoutSession(shopDomain: string, session: StoredCheckoutSession): void {
    const url = encryptSecret(this.key, session.checkoutUrl, checkoutAad(shopDomain, session.cartId));
    this.db.run(
      `INSERT INTO checkout_session (
         singleton, cart_id, session_token, verification_token, expires_at, url_nonce, url_ciphertext
       ) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         cart_id = excluded.cart_id,
         session_token = excluded.session_token,
         verification_token = excluded.verification_token,
         expires_at = excluded.expires_at,
         url_nonce = excluded.url_nonce,
         url_ciphertext = excluded.url_ciphertext`,
      [
        session.cartId,
        session.sessionToken,
        session.verificationToken,
        session.expiresAt,
        new Uint8Array(url.nonce),
        new Uint8Array(url.ciphertext),
      ],
    );
    this.persist();
  }

  getCheckoutSession(shopDomain: string, sessionToken: string): StoredCheckoutSession | null {
    const row = this.one(
      `SELECT cart_id, session_token, verification_token, expires_at, url_nonce, url_ciphertext
       FROM checkout_session WHERE singleton = 1`,
    );
    if (row === undefined) {
      return null;
    }
    const cartId = readString(row, "cart_id");
    const storedToken = readString(row, "session_token");
    const verificationToken = readString(row, "verification_token");
    const expiresAt = readNullableInt(row, "expires_at");
    if (cartId === null || storedToken === null || verificationToken === null || expiresAt === null) {
      throw new TokenDecryptError();
    }
    if (storedToken !== sessionToken) {
      return null;
    }
    const checkoutUrl = this.readSecret(row, "url", checkoutAad(shopDomain, cartId));
    if (checkoutUrl === null) {
      throw new TokenDecryptError();
    }
    return { cartId, sessionToken: storedToken, verificationToken, expiresAt, checkoutUrl };
  }

  clearCheckoutSession(): void {
    this.db.run("DELETE FROM checkout_session");
    this.persist();
  }

  lookupIdempotency(scope: string, key: string, fingerprint: string, now: number): IdempotencyLookup {
    const row = this.one(
      `SELECT fingerprint, status, body_json, expires_at
       FROM idempotency_record WHERE scope = ? AND idempotency_key = ?`,
      [scope, key],
    );
    if (row === undefined) {
      return { kind: "miss" };
    }
    const expiresAt = readNullableInt(row, "expires_at");
    if (expiresAt === null || expiresAt <= now) {
      this.deleteIdempotency(scope, key);
      return { kind: "miss" };
    }
    const storedFingerprint = readString(row, "fingerprint");
    const status = readNullableInt(row, "status");
    const bodyJson = readString(row, "body_json");
    if (storedFingerprint === null || status === null || bodyJson === null) {
      this.deleteIdempotency(scope, key);
      return { kind: "miss" };
    }
    if (storedFingerprint !== fingerprint) {
      return { kind: "conflict" };
    }
    try {
      return { kind: "replay", status, body: JSON.parse(bodyJson) as unknown };
    } catch {
      this.deleteIdempotency(scope, key);
      return { kind: "miss" };
    }
  }

  rememberIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
    status: number,
    body: unknown,
    expiresAt: number,
  ): void {
    if (status < 200 || status >= 300) {
      return;
    }
    this.db.run(
      `INSERT INTO idempotency_record (scope, idempotency_key, fingerprint, status, body_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, idempotency_key) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         status = excluded.status,
         body_json = excluded.body_json,
         expires_at = excluded.expires_at`,
      [scope, key, fingerprint, status, JSON.stringify(body), expiresAt],
    );
    this.persist();
  }

  clearIdempotency(): void {
    this.db.run("DELETE FROM idempotency_record");
    this.persist();
  }

  compact(): void {
    this.db.run("VACUUM");
    this.persist();
  }

  private cartLines(shopDomain: string): StoredCartLine[] {
    const stmt = this.db.prepare(
      `SELECT item_id, position, line_nonce, line_ciphertext FROM cart_line ORDER BY position ASC`,
    );
    const lines: StoredCartLine[] = [];
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const itemId = readString(row, "item_id");
        const position = readNullableInt(row, "position");
        if (itemId === null || position === null) {
          throw new TokenDecryptError();
        }
        const lineGid = this.readSecret(row, "line", lineAad(shopDomain, itemId));
        if (lineGid === null) {
          throw new TokenDecryptError();
        }
        lines.push({ itemId, lineGid });
      }
    } finally {
      stmt.free();
    }
    return lines;
  }

  private deleteIdempotency(scope: string, key: string): void {
    this.db.run(`DELETE FROM idempotency_record WHERE scope = ? AND idempotency_key = ?`, [scope, key]);
    this.persist();
  }

  private readSecret(row: Record<string, SqlValue>, field: string, aad: string): string | null {
    const nonce = row[`${field}_nonce`];
    const ciphertext = row[`${field}_ciphertext`];
    if (nonce === null && ciphertext === null) {
      return null;
    }
    if (!(nonce instanceof Uint8Array) || !(ciphertext instanceof Uint8Array)) {
      throw new TokenDecryptError();
    }
    try {
      return decryptSecret(this.key, Buffer.from(nonce), Buffer.from(ciphertext), aad);
    } catch {
      throw new TokenDecryptError();
    }
  }

  private one(sql: string, params: SqlValue[] = []): Record<string, SqlValue> | undefined {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      if (!stmt.step()) {
        return undefined;
      }
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, Buffer.from(this.db.export()));
    renameSync(tmp, this.filePath);
  }
}

function readString(row: Record<string, SqlValue>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNullableInt(row: Record<string, SqlValue>, key: string): number | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TokenDecryptError();
  }
  return value;
}

export type StoredCartLine = {
  itemId: string;
  lineGid: string;
};

export type StoredCart = {
  cartId: string;
  shopifyCartId: string;
  extensions: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  lines: StoredCartLine[];
};

export type StoredCheckoutSession = {
  cartId: string;
  sessionToken: string;
  verificationToken: string;
  expiresAt: number;
  checkoutUrl: string;
};

export type IdempotencyLookup =
  | { kind: "miss" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" };

function cartAad(shopDomain: string): string {
  return `${shopDomain}\u0000cart`;
}

function checkoutAad(shopDomain: string, cartId: string): string {
  return `${shopDomain}\u0000checkout\u0000${cartId}`;
}

function lineAad(shopDomain: string, itemId: string): string {
  return `${shopDomain}\u0000line\u0000${itemId}`;
}

function readExtensions(value: SqlValue | undefined): Record<string, unknown> | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readGrant(row: Record<string, SqlValue>): GrantType | null {
  const value = row.grant_type;
  if (value === "authorization_code" || value === "client_credentials") {
    return value;
  }
  return null;
}
