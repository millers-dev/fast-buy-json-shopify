import type { Database, SqlValue } from "sql.js";

import { decryptSecret, encryptSecret } from "./secret-box.js";

export type CustomerPollOutcome = "complete" | "invalid" | "misconfigured" | "internal";

const POLL_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_login_poll (
  login_id_hash TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL UNIQUE,
  state_hash TEXT,
  state_used INTEGER NOT NULL DEFAULT 0,
  cookie_hash TEXT,
  link_consumed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  created_at INTEGER NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  graphql_api TEXT NOT NULL,
  user_code_nonce BLOB NOT NULL,
  user_code_ciphertext BLOB NOT NULL,
  oauth_nonce_nonce BLOB NOT NULL,
  oauth_nonce_ciphertext BLOB NOT NULL,
  verifier_nonce BLOB NOT NULL,
  verifier_ciphertext BLOB NOT NULL,
  state_nonce BLOB,
  state_ciphertext BLOB,
  outcome TEXT,
  jwt_nonce BLOB,
  jwt_ciphertext BLOB,
  jwt_expires_in INTEGER
)`;

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_session (
  sub TEXT PRIMARY KEY,
  token_nonce BLOB NOT NULL,
  token_ciphertext BLOB NOT NULL,
  expires_at INTEGER NOT NULL
)`;

const STATE_INDEX = `CREATE INDEX IF NOT EXISTS customer_login_poll_state ON customer_login_poll (state_hash)`;
const COOKIE_INDEX = `CREATE INDEX IF NOT EXISTS customer_login_poll_cookie ON customer_login_poll (cookie_hash)`;

export type NewCustomerPoll = {
  shopDomain: string;
  loginIdHash: string;
  pollTokenHash: string;
  expiresAt: number;
  createdAt: number;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  graphqlApi: string;
  userCode: string;
  oauthNonce: string;
  codeVerifier: string;
};

export type StoredCustomerPoll = {
  loginIdHash: string;
  pollTokenHash: string;
  stateHash: string | null;
  stateUsed: boolean;
  cookieHash: string | null;
  linkConsumed: boolean;
  expiresAt: number;
  lastPollAt: number | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  graphqlApi: string;
  userCode: string;
  oauthNonce: string;
  codeVerifier: string;
  state: string | null;
  outcome: CustomerPollOutcome | null;
  jwt: string | null;
  jwtExpiresIn: number | null;
};

export type CustomerSessionRecord = {
  accessToken: string;
  expiresAt: number;
};

export class CustomerAuthStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
    private readonly persist: () => void,
    private readonly failDecrypt: () => never,
  ) {
    this.db.run(POLL_SCHEMA);
    this.db.run(SESSION_SCHEMA);
    this.db.run(STATE_INDEX);
    this.db.run(COOKIE_INDEX);
  }

  purge(now: number): void {
    this.db.run(`DELETE FROM customer_login_poll WHERE expires_at <= ?`, [now]);
    const polls = this.db.getRowsModified();
    this.db.run(`DELETE FROM customer_session WHERE expires_at <= ?`, [now]);
    const sessions = this.db.getRowsModified();
    if (polls > 0 || sessions > 0) {
      this.persist();
    }
  }

  countLive(now: number): number {
    const row = this.one(`SELECT COUNT(*) AS n FROM customer_login_poll WHERE expires_at > ?`, [now]);
    const count = row?.n;
    return typeof count === "number" ? count : 0;
  }

  countSessions(): number {
    const row = this.one(`SELECT COUNT(*) AS n FROM customer_session`);
    const count = row?.n;
    return typeof count === "number" ? count : 0;
  }

  insertPoll(row: NewCustomerPoll): void {
    const userCode = encryptSecret(this.key, row.userCode, pollAad(row.shopDomain, row.loginIdHash, "user-code"));
    const oauthNonce = encryptSecret(this.key, row.oauthNonce, pollAad(row.shopDomain, row.loginIdHash, "nonce"));
    const verifier = encryptSecret(this.key, row.codeVerifier, pollAad(row.shopDomain, row.loginIdHash, "verifier"));
    this.db.run(
      `INSERT INTO customer_login_poll (
         login_id_hash, poll_token_hash, state_hash, state_used, cookie_hash, link_consumed,
         expires_at, last_poll_at, created_at, authorization_endpoint, token_endpoint, graphql_api,
         user_code_nonce, user_code_ciphertext, oauth_nonce_nonce, oauth_nonce_ciphertext,
         verifier_nonce, verifier_ciphertext, state_nonce, state_ciphertext, outcome,
         jwt_nonce, jwt_ciphertext, jwt_expires_in
       ) VALUES (?, ?, NULL, 0, NULL, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [
        row.loginIdHash,
        row.pollTokenHash,
        row.expiresAt,
        row.createdAt,
        row.authorizationEndpoint,
        row.tokenEndpoint,
        row.graphqlApi,
        new Uint8Array(userCode.nonce),
        new Uint8Array(userCode.ciphertext),
        new Uint8Array(oauthNonce.nonce),
        new Uint8Array(oauthNonce.ciphertext),
        new Uint8Array(verifier.nonce),
        new Uint8Array(verifier.ciphertext),
      ],
    );
    this.persist();
  }

  getByLoginHash(shopDomain: string, loginIdHash: string): StoredCustomerPoll | null {
    return this.readWhere(shopDomain, `login_id_hash = ?`, [loginIdHash]);
  }

  getByPollHash(shopDomain: string, pollTokenHash: string): StoredCustomerPoll | null {
    return this.readWhere(shopDomain, `poll_token_hash = ?`, [pollTokenHash]);
  }

  getByStateHash(shopDomain: string, stateHash: string): StoredCustomerPoll | null {
    return this.readWhere(shopDomain, `state_hash = ?`, [stateHash]);
  }

  getByCookieHash(shopDomain: string, cookieHash: string): StoredCustomerPoll | null {
    return this.readWhere(shopDomain, `cookie_hash = ?`, [cookieHash]);
  }

  isStateUsed(stateHash: string): boolean {
    const row = this.one(`SELECT state_used FROM customer_login_poll WHERE state_hash = ?`, [stateHash]);
    return row?.state_used === 1;
  }

  consumeLoginLink(args: {
    shopDomain: string;
    loginIdHash: string;
    cookieHash: string;
    state: string;
    stateHash: string;
    now: number;
  }): "ok" | "missing" | "consumed" | "expired" {
    const existing = this.one(
      `SELECT link_consumed, expires_at FROM customer_login_poll WHERE login_id_hash = ?`,
      [args.loginIdHash],
    );
    if (existing === undefined) {
      return "missing";
    }
    const expiresAt = readNullableInt(existing, "expires_at", this.failDecrypt);
    const consumed = existing.link_consumed;
    if (expiresAt === null || consumed !== 0 && consumed !== 1) {
      this.failDecrypt();
    }
    if (expiresAt !== null && expiresAt <= args.now) {
      return "expired";
    }
    if (consumed === 1) {
      return "consumed";
    }
    const state = encryptSecret(this.key, args.state, pollAad(args.shopDomain, args.loginIdHash, "state"));
    this.db.run(
      `UPDATE customer_login_poll
       SET link_consumed = 1, cookie_hash = ?, state_hash = ?, state_nonce = ?, state_ciphertext = ?
       WHERE login_id_hash = ? AND link_consumed = 0 AND expires_at > ?`,
      [
        args.cookieHash,
        args.stateHash,
        new Uint8Array(state.nonce),
        new Uint8Array(state.ciphertext),
        args.loginIdHash,
        args.now,
      ],
    );
    if (this.db.getRowsModified() !== 1) {
      return "consumed";
    }
    this.persist();
    return "ok";
  }

  markStateUsed(stateHash: string): boolean {
    this.db.run(
      `UPDATE customer_login_poll
       SET state_used = 1, state_nonce = NULL, state_ciphertext = NULL
       WHERE state_hash = ? AND state_used = 0`,
      [stateHash],
    );
    const marked = this.db.getRowsModified() === 1;
    if (marked) {
      this.persist();
    }
    return marked;
  }

  setOutcome(args: {
    shopDomain: string;
    loginIdHash: string;
    outcome: CustomerPollOutcome;
    jwt: string | null;
    jwtExpiresIn: number | null;
  }): void {
    const jwt =
      args.jwt === null
        ? null
        : encryptSecret(this.key, args.jwt, pollAad(args.shopDomain, args.loginIdHash, "jwt"));
    this.db.run(
      `UPDATE customer_login_poll
       SET outcome = ?, jwt_nonce = ?, jwt_ciphertext = ?, jwt_expires_in = ?
       WHERE login_id_hash = ?`,
      [
        args.outcome,
        jwt === null ? null : new Uint8Array(jwt.nonce),
        jwt === null ? null : new Uint8Array(jwt.ciphertext),
        args.jwtExpiresIn,
        args.loginIdHash,
      ],
    );
    this.persist();
  }

  touchPoll(pollTokenHash: string, now: number): void {
    this.db.run(`UPDATE customer_login_poll SET last_poll_at = ? WHERE poll_token_hash = ?`, [now, pollTokenHash]);
    this.persist();
  }

  deleteByPollHash(pollTokenHash: string): void {
    this.db.run(`DELETE FROM customer_login_poll WHERE poll_token_hash = ?`, [pollTokenHash]);
    this.persist();
  }

  saveSession(shopDomain: string, sub: string, accessToken: string, expiresAt: number): void {
    const token = encryptSecret(this.key, accessToken, sessionAad(shopDomain, sub));
    this.db.run(
      `INSERT INTO customer_session (sub, token_nonce, token_ciphertext, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET
         token_nonce = excluded.token_nonce,
         token_ciphertext = excluded.token_ciphertext,
         expires_at = excluded.expires_at`,
      [sub, new Uint8Array(token.nonce), new Uint8Array(token.ciphertext), expiresAt],
    );
    this.persist();
  }

  getSession(shopDomain: string, sub: string): CustomerSessionRecord | null {
    const row = this.one(
      `SELECT token_nonce, token_ciphertext, expires_at FROM customer_session WHERE sub = ?`,
      [sub],
    );
    if (row === undefined) {
      return null;
    }
    const expiresAt = readNullableInt(row, "expires_at", this.failDecrypt);
    if (expiresAt === null) {
      this.failDecrypt();
    }
    const accessToken = this.readBlob(row, "token", sessionAad(shopDomain, sub));
    if (expiresAt === null || accessToken === null) {
      this.failDecrypt();
    }
    return { accessToken: accessToken ?? "", expiresAt: expiresAt ?? 0 };
  }

  deleteSession(sub: string): boolean {
    this.db.run(`DELETE FROM customer_session WHERE sub = ?`, [sub]);
    const deleted = this.db.getRowsModified() === 1;
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  deleteAll(): void {
    this.db.run(`DELETE FROM customer_login_poll`);
    const polls = this.db.getRowsModified();
    this.db.run(`DELETE FROM customer_session`);
    const sessions = this.db.getRowsModified();
    if (polls > 0 || sessions > 0) {
      this.persist();
    }
  }

  private readWhere(shopDomain: string, clause: string, params: SqlValue[]): StoredCustomerPoll | null {
    const row = this.one(
      `SELECT login_id_hash, poll_token_hash, state_hash, state_used, cookie_hash, link_consumed,
              expires_at, last_poll_at, authorization_endpoint, token_endpoint, graphql_api,
              user_code_nonce, user_code_ciphertext, oauth_nonce_nonce, oauth_nonce_ciphertext,
              verifier_nonce, verifier_ciphertext, state_nonce, state_ciphertext, outcome,
              jwt_nonce, jwt_ciphertext, jwt_expires_in
       FROM customer_login_poll WHERE ${clause}`,
      params,
    );
    if (row === undefined) {
      return null;
    }
    return this.readPoll(shopDomain, row);
  }

  private readPoll(shopDomain: string, row: Record<string, SqlValue>): StoredCustomerPoll {
    const loginIdHash = readString(row, "login_id_hash", this.failDecrypt);
    const pollTokenHash = readString(row, "poll_token_hash", this.failDecrypt);
    const authorizationEndpoint = readString(row, "authorization_endpoint", this.failDecrypt);
    const tokenEndpoint = readString(row, "token_endpoint", this.failDecrypt);
    const graphqlApi = readString(row, "graphql_api", this.failDecrypt);
    const expiresAt = readNullableInt(row, "expires_at", this.failDecrypt);
    if (
      loginIdHash === null ||
      pollTokenHash === null ||
      authorizationEndpoint === null ||
      tokenEndpoint === null ||
      graphqlApi === null ||
      expiresAt === null
    ) {
      this.failDecrypt();
    }
    const userCode = this.readBlob(row, "user_code", pollAad(shopDomain, loginIdHash ?? "", "user-code"));
    const oauthNonce = this.readBlob(row, "oauth_nonce", pollAad(shopDomain, loginIdHash ?? "", "nonce"));
    const codeVerifier = this.readBlob(row, "verifier", pollAad(shopDomain, loginIdHash ?? "", "verifier"));
    if (userCode === null || oauthNonce === null || codeVerifier === null) {
      this.failDecrypt();
    }
    const stateHash = readOptionalString(row, "state_hash");
    const state =
      row.state_nonce === null && row.state_ciphertext === null
        ? null
        : this.readBlob(row, "state", pollAad(shopDomain, loginIdHash ?? "", "state"));
    const outcome = readOutcome(row.outcome);
    const jwt =
      row.jwt_nonce === null && row.jwt_ciphertext === null
        ? null
        : this.readBlob(row, "jwt", pollAad(shopDomain, loginIdHash ?? "", "jwt"));
    return {
      loginIdHash: loginIdHash ?? "",
      pollTokenHash: pollTokenHash ?? "",
      stateHash,
      stateUsed: row.state_used === 1,
      cookieHash: readOptionalString(row, "cookie_hash"),
      linkConsumed: row.link_consumed === 1,
      expiresAt: expiresAt ?? 0,
      lastPollAt: readNullableInt(row, "last_poll_at", this.failDecrypt),
      authorizationEndpoint: authorizationEndpoint ?? "",
      tokenEndpoint: tokenEndpoint ?? "",
      graphqlApi: graphqlApi ?? "",
      userCode: userCode ?? "",
      oauthNonce: oauthNonce ?? "",
      codeVerifier: codeVerifier ?? "",
      state,
      outcome,
      jwt,
      jwtExpiresIn: readNullableInt(row, "jwt_expires_in", this.failDecrypt),
    };
  }

  private readBlob(row: Record<string, SqlValue>, field: string, aad: string): string | null {
    const nonce = row[`${field}_nonce`];
    const ciphertext = row[`${field}_ciphertext`];
    if (nonce === null && ciphertext === null) {
      return null;
    }
    if (!(nonce instanceof Uint8Array) || !(ciphertext instanceof Uint8Array)) {
      this.failDecrypt();
    }
    try {
      return decryptSecret(this.key, Buffer.from(nonce ?? new Uint8Array()), Buffer.from(ciphertext ?? new Uint8Array()), aad);
    } catch {
      this.failDecrypt();
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
}

function pollAad(shopDomain: string, loginIdHash: string, field: string): string {
  return `${shopDomain}\u0000customer-poll\u0000${loginIdHash}\u0000${field}`;
}

function sessionAad(shopDomain: string, sub: string): string {
  return `${shopDomain}\u0000customer-session\u0000${sub}`;
}

function readString(
  row: Record<string, SqlValue>,
  key: string,
  failDecrypt: () => never,
): string | null {
  const value = row[key];
  if (typeof value !== "string" || value === "") {
    failDecrypt();
  }
  return typeof value === "string" ? value : null;
}

function readOptionalString(row: Record<string, SqlValue>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value !== "" ? value : null;
}

function readNullableInt(
  row: Record<string, SqlValue>,
  key: string,
  failDecrypt: () => never,
): number | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failDecrypt();
  }
  return typeof value === "number" ? value : null;
}

function readOutcome(value: SqlValue | undefined): CustomerPollOutcome | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value === "complete" || value === "invalid" || value === "misconfigured" || value === "internal") {
    return value;
  }
  return null;
}
