import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs, { type Database, type SqlValue } from "sql.js";

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
    if (deleted) {
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

function readGrant(row: Record<string, SqlValue>): GrantType | null {
  const value = row.grant_type;
  if (value === "authorization_code" || value === "client_credentials") {
    return value;
  }
  return null;
}
