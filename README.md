# FastBuyJSON Shopify

This repository is the Shopify store connector for [FastBuyJSON](https://github.com/millers-dev/fast-buy-json). One process serves one shop at `http://localhost:3100/api/fastbuyjson`.

FastBuyJSON itself — the contract, the Node and Python reference servers, the TypeScript SDK, and the stdio MCP server — stays in `millers-dev/fast-buy-json`. Point that MCP server at this process with `FASTBUYJSON_API_URL=http://localhost:3100/api/fastbuyjson`. This package is not part of that repository and it is not published to npm.

It is early. The accepted plan is `docs/SHOPIFY_PLAN.md` in `millers-dev/fast-buy-json`. This tree implements discovery, one-shop OAuth, and catalog search.

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

When a stored token must be refreshed before a commerce call and the refresh fails, the cached access token is cleared and the call returns **500** `INTERNAL_ERROR`. The body says the shop must be reinstalled and does not contain a token. Cart, discounts, checkout URL, and shipping are not implemented, so those routes stay **404** while the stored token is usable.

## Catalog

`POST /api/fastbuyjson/products/search` reads the Storefront API at the pinned version in `src/api-version.ts`. A text `query` uses Storefront `search`. A filters-only request uses `products`. Pagination stays the contract's `page` / `pageSize` (1-based, `pageSize` at most 100). The connector walks cursors for `page > 1` and returns **400** `VALIDATION_ERROR` if that walk would scan more than 1000 matching items.

The first catalog call mints a delegate token with `delegateAccessTokenCreate`, limited to the four unauthenticated scopes above, and stores it encrypted in the same SQLite file. Storefront requests send that token as `Shopify-Storefront-Private-Token`. A public Storefront token is not minted, and the delegate token is not returned to the agent. Saving a new Admin token clears the delegate; the next catalog call mints another.

When the FastBuyJSON request's TCP peer is a public address, it is forwarded as `Shopify-Storefront-Buyer-IP`. A loopback peer omits that header. `127.0.0.1` is not sent.

A `priceRange.currency` other than the shop currency is **400** `VALIDATION_ERROR`. Prices are not converted. Shopify **429**, or a Storefront `THROTTLED` error, waits one second, retries that call once, and then returns **429** `RATE_LIMITED`.

`schemas/` is an unmodified copy of FastBuyJSON `schemas/` at tag `1.0.0`. The Shopify API pin `2026-10` lives in `src/api-version.ts`.

## Still deferred

- Cart, including the opaque cart id
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
