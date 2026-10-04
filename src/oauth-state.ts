import { randomBytes } from "node:crypto";

import { safeEqual } from "./shopify-hmac.js";

const STATE_TTL_MS = 10 * 60 * 1000;

type PendingState = {
  state: string;
  shopDomain: string;
  expiresAt: number;
};

/** One in-flight install nonce for this process. A restart invalidates it. */
export class OauthStateStore {
  private pending: PendingState | null = null;

  issue(shopDomain: string, now: number): string {
    const state = randomBytes(16).toString("hex");
    this.pending = { state, shopDomain, expiresAt: now + STATE_TTL_MS };
    return state;
  }

  consume(state: string, shopDomain: string, now: number): boolean {
    const pending = this.pending;
    if (pending === null || !safeEqual(pending.state, state)) {
      return false;
    }
    this.pending = null;
    if (now > pending.expiresAt) {
      return false;
    }
    return pending.shopDomain === shopDomain;
  }
}
