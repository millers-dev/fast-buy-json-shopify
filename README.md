# FastBuyJSON Shopify

This repository is the Shopify store connector for [FastBuyJSON](https://github.com/millers-dev/fast-buy-json). One process serves one shop at `http://localhost:3100/api/fastbuyjson`.

FastBuyJSON itself — the contract, the Node and Python reference servers, the TypeScript SDK, and the stdio MCP server — stays in `millers-dev/fast-buy-json`. Point that MCP server at this process with `FASTBUYJSON_API_URL=http://localhost:3100/api/fastbuyjson`. This package is not part of that repository and it is not published to npm.

It is early. The accepted plan is `docs/SHOPIFY_PLAN.md` in `millers-dev/fast-buy-json`. This tree implements the first slice of that plan: discovery.

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

Checkout stays on Shopify.

## This slice

`GET /api/fastbuyjson/detect` is implemented. It does not call Shopify. `SHOPIFY_SHOP` (for example `example.myshopify.com`) sets `merchantInfo` to that domain and `https://` plus the domain. The live shop display name is not loaded yet, so the name is the configured domain.

`schemas/` is an unmodified copy of FastBuyJSON `schemas/` at tag `1.0.0`. The Shopify API pin `2026-10` lives in `src/api-version.ts` and is not used for a network call in this slice.

Any other path returns 404. Install and tokens, catalog mapping, cart, discounts, the checkout URL, and shipping options are later slices.

## Run

```bash
npm install
npm run build
npm start
curl -s http://localhost:3100/api/fastbuyjson/detect
```

`PORT` defaults to `3100`. Copy `.env.example` if you want a local shop domain. This slice does not read a client id, client secret, or access token.

```bash
npm test
```

## License

MIT. Copyright (c) 2025 Tomasz Miller.
