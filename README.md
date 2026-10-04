# FastBuyJSON Shopify

This repository is the Shopify store connector for [FastBuyJSON](https://github.com/millers-dev/fast-buy-json). One process serves one shop at `http://localhost:3100/api/fastbuyjson`.

FastBuyJSON itself — the contract, the Node and Python reference servers, the TypeScript SDK, and the stdio MCP server — stays in `millers-dev/fast-buy-json`. Point that MCP server at this process with `FASTBUYJSON_API_URL=http://localhost:3100/api/fastbuyjson`. This package is not part of that repository and it is not published to npm.

It is early. The accepted plan is `docs/SHOPIFY_PLAN.md` in `millers-dev/fast-buy-json`. This tree implements discovery, one-shop OAuth, catalog search, and an anonymous cart.

## What v1 does

v1 is one Shopify shop speaking FastBuyJSON discovery, catalog search, cart, and checkout initiate. The buyer pays on Shopify’s hosted checkout. The connector’s job on checkout is to hand the agent a `checkoutUrl`.

`GET /detect` is public and sends `Cache-Control: public, max-age=300`. It advertises:

- `standard` `FastBuyJSON`, `specVersion` `1.0.0`, and this package’s version
- endpoints `products`, `cart`, and `checkout` (`orders` and `auth` stay off)
- anonymous buyers, one discount code (`stackable: false`)
- tax mode `shopify_estimated`
- shipping from the shop’s Shopify delivery groups, not the reference seed catalog
- checkout handoff `shopify_hosted` with `confirmCreatesOrder: false`

## What v1 does not do

- Charge a card, wallet, PayPal, or Shop Pay
- Create a Shopify order, including from `POST /checkout/confirm`
- Call Checkout MCP `complete_checkout`
- Read order status or customer records
- Run the reference seed catalog (`standard` / `express` shipping, free shipping over USD 100, seed tax rates, or promo codes `SAVE10` / `WELCOME5`)

Checkout stays on Shopify. This package does not charge cards or create orders.

## This slice

`GET /api/fastbuyjson/detect` is implemented. It does not call Shopify. `SHOPIFY_SHOP` (for example `example.myshopify.com`) sets `merchantInfo` to that domain and `https://` plus the domain. The live shop display name is not loaded yet, so the name is the configured domain.

OAuth for one shop is implemented. The app is a Dev Dashboard app with custom distribution. There is no embedded admin UI.

Requested scopes, and no others:

- `unauthenticated_read_product_listings`
- `unauthenticated_read_product_inventory`
- `unauthenticated_read_checkouts`
- `unauthenticated_write_checkouts`

Two grants:

- **Client credentials** when `APP_URL` is unset. This is the local path for a development store in the same organization as the app. On startup the process exchanges `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` for an Admin token and stores it.
- **Authorization code** when `APP_URL` is an HTTPS origin. `GET /api/shopify/auth` redirects the merchant to Shopify. The callback is `{APP_URL}/api/shopify/auth/callback`. The code exchange sends `expiring=1`. A bad `hmac`, a bad `state`, or a shop other than `SHOPIFY_SHOP` stores nothing.

The Admin access token and refresh token are encrypted with `TOKEN_ENCRYPTION_KEY` and written to `fastbuyjson-shopify.sqlite` in the working directory. That file is gitignored. The store holds one shop. A second shop is rejected until the file is removed. Tokens are not written to logs or HTTP responses.

`app/uninstalled` and `shop/redact` are HMAC-checked and delete that shop row. `customers/data_request` and `customers/redact` are HMAC-checked, acknowledged, and do not build a customer archive. Point them at `{APP_URL}/api/shopify/webhooks/<topic>` (slashes in the topic become path segments) or at `{APP_URL}/api/shopify/webhooks` and let `X-Shopify-Topic` select the handler.

When a stored token must be refreshed before a commerce call and the refresh fails, the cached access token is cleared and the call returns **500** `INTERNAL_ERROR`. The body says the shop must be reinstalled and does not contain a token. Discounts, checkout URL, and shipping are not implemented, so those routes stay **404** while the stored token is usable.

## Catalog

`POST /api/fastbuyjson/products/search` reads the Storefront API at the pinned version in `src/api-version.ts`. A text `query` uses Storefront `search`. A filters-only request uses `products`. Pagination stays the contract's `page` / `pageSize` (1-based, `pageSize` at most 100). The connector returns **400** `VALIDATION_ERROR` when `page * pageSize` would scan more than 1000 matching items to reach that page.

`totalItems` is the number of products that match the request. A text query with no availability, price, or category filter uses `search.totalCount`. `products` has no `totalCount`. A filters-only request whose filters are already in the products query walks cursors until `pageInfo.hasNextPage` is false and uses that product count. It does not add one when another page exists, and a shop with more than 1000 products does not return **400** on page 1.

Availability, `priceRange` (inclusive minimum variant price), and categories on a text query (`productType` or tag) are applied while cursors are walked. The page is filled with up to `pageSize` matching products. `totalItems` is the size of that matching set after the walk ends. A filtered page 1 with more than 1000 matches returns **200** and that real count. The count does not stop at 1000.

`filters.availability` keeps a product only when its mapped status is in the requested set. `in_stock` and `backorder` are not both `available: true`. A categories filter matches `product_type` or tag and is not appended to the caller search text. `availability.quantity` sums `quantityAvailable` across variant pages and is omitted when any variant quantity is null.

The first catalog call mints a delegate token with `delegateAccessTokenCreate`, limited to the four unauthenticated scopes above, and stores it encrypted in the same SQLite file. Storefront requests send that token as `Shopify-Storefront-Private-Token`. A public Storefront token is not minted, and the delegate token is not returned to the agent. Saving a new Admin token clears the delegate; the next catalog call mints another.

When the FastBuyJSON request's TCP peer is a public address, it is forwarded as `Shopify-Storefront-Buyer-IP`. A loopback peer omits that header. `127.0.0.1` is not sent.

A `priceRange.currency` other than the shop currency is **400** `VALIDATION_ERROR`. Prices are not converted. Shopify **429**, or a Storefront `THROTTLED` error, waits one second, retries that call once, and then returns **429** `RATE_LIMITED`.

`schemas/` is an unmodified copy of FastBuyJSON `schemas/` at tag `1.0.0`. The Shopify API pin `2026-10` lives in `src/api-version.ts`.

## Cart

Cart routes use the same Storefront delegate token as catalog search. There is one anonymous cart per process. A Bearer token on these routes is ignored.

| Call | Behavior |
| --- | --- |
| `POST /cart/add` | `cartCreate` on the first successful add, then `cartLinesAdd` on that Shopify cart |
| `GET /cart` and `GET /cart/{cartId}` | Storefront `cart` query |
| `PATCH /cart/items/{itemId}` | `cartLinesUpdate` with an absolute quantity |
| `DELETE /cart/items/{itemId}` | `cartLinesRemove` |
| `DELETE /cart` | Removes every line and keeps the FastBuyJSON cart id |

`GET /cart` before any successful add returns **404** `CART_NOT_FOUND` and does not call Shopify. The FastBuyJSON cart id and each line `itemId` are UUIDs. The Shopify cart GID, including `?key=`, and each CartLine GID stay in the SQLite file and are not copied into responses, logs, or `extensions`. `extensions` echoes only what the caller sent. `checkoutUrl` is not selected and is not returned.

`productId` may be a variant GID, a product GID with one variant, or a product GID plus `options` that match every selected option on exactly one variant. Several variants and no unique match is **400** `VALIDATION_ERROR`. An unknown id is **404** `PRODUCT_NOT_FOUND`. The line's `productId` is the variant GID that was added. When Shopify merges a second add of the same variant into one line, the existing line UUID is kept.

Money comes from Storefront decimal strings. Totals come from `CartCost` and are not recomputed. Mutation `userErrors` are **400** `VALIDATION_ERROR`.

`Idempotency-Key` is honored only on `POST /cart/add`, scoped to `anonymous`, with the contract fingerprint and 24-hour retention. **4xx** and **5xx** do not store the key. A replay of a **2xx** returns the same body with `Idempotency-Replayed: true`. A different fingerprint is **409** `IDEMPOTENCY_KEY_CONFLICT`. `PATCH` and `DELETE` do not honor the key.

Successful cart responses send `Cache-Control: no-store`. A public TCP peer is forwarded as `Shopify-Storefront-Buyer-IP`. `127.0.0.1` is not sent. Shopify **429** or `THROTTLED` waits once, retries that call once, then returns **429** `RATE_LIMITED`.

## Still deferred

- Discounts
- Checkout URL (`POST /checkout/initiate`) and payment refusal (`POST /checkout/confirm`)
- Shipping options
- Order status

## Run

```bash
npm install
npm run build
npm start
curl -s http://localhost:3100/api/fastbuyjson/detect
```

`PORT` defaults to `3100`. Copy `.env.example` for local values. With only `PORT` and `SHOPIFY_SHOP`, the process serves discovery and does not call Shopify.

To store a token, set `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` (32 bytes, base64). Leave `APP_URL` unset for client credentials. Set `APP_URL` to the public HTTPS origin, then open `http://localhost:3100/api/shopify/auth`, for the authorization-code grant. `SHOPIFY_API_VERSION` must be `2026-10` when it is set.

```bash
npm test
```

## License

MIT. Copyright (c) 2025 Tomasz Miller.
