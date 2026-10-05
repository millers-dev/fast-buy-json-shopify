/**
 * Admin GraphQL 2026-10 order reads, re-checked on 2026-10-05.
 *
 * `orders` filters include `name` and `confirmation_number`.
 * `orderByIdentifier` accepts `id` and `customId` only, so this phase does not call it.
 * Amounts are `MoneyBag.shopMoney.amount` (a decimal string) and `currencyCode`.
 * Tracking is `Fulfillment.trackingInfo` `company`, `number`, and `url`.
 * `Fulfillment.deliveredAt` is a nullable DateTime: the date that fulfillment was delivered.
 * `Order.fulfillments` is `[Fulfillment!]!`. `first` truncates that list and is not passed.
 * `Fulfillment.status` is `SUCCESS`, `CANCELLED`, `ERROR`, `FAILURE`, plus deprecated `OPEN` and `PENDING`.
 * The selection does not read `events`, `displayStatus`, `estimatedDeliveryAt`, `inTransitAt`,
 * `originAddress`, or `location`.
 * Line prices are `discountedUnitPriceSet` / `originalUnitPriceSet` and
 * `discountedTotalSet` / `originalTotalSet`.
 * The selection set does not read addresses, email, phone, customer name, or
 * `CardPaymentDetails`, and it does not read the Order GID.
 */

export const ORDER_LINE_PAGE = 50;
export const ORDER_TRACKING_CAP = 10;

const ORDER_FIELDS = `
    name
    cancelledAt
    displayFinancialStatus
    displayFulfillmentStatus
    createdAt
    updatedAt
    paymentGatewayNames
    currentSubtotalPriceSet { shopMoney { amount currencyCode } }
    subtotalPriceSet { shopMoney { amount currencyCode } }
    currentTotalTaxSet { shopMoney { amount currencyCode } }
    totalTaxSet { shopMoney { amount currencyCode } }
    currentShippingPriceSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    currentTotalDiscountsSet { shopMoney { amount currencyCode } }
    totalDiscountsSet { shopMoney { amount currencyCode } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    totalPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: ${ORDER_LINE_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        quantity
        sku
        variant {
          sku
          legacyResourceId
          selectedOptions { name value }
        }
        discountedUnitPriceSet { shopMoney { amount currencyCode } }
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } }
        originalTotalSet { shopMoney { amount currencyCode } }
      }
    }
    fulfillments {
      status
      deliveredAt
      trackingInfo(first: ${ORDER_TRACKING_CAP}) {
        company
        number
        url
      }
    }`;

export const ORDER_BY_ID_DOCUMENT = `
query OrderById($id: ID!, $after: String) {
  order(id: $id) {${ORDER_FIELDS}
  }
}`;

export const ORDERS_BY_QUERY_DOCUMENT = `
query OrdersByQuery($query: String!, $after: String) {
  orders(first: 2, query: $query) {
    nodes {${ORDER_FIELDS}
    }
  }
}`;

const SEARCH_VALUE = /^[A-Za-z0-9_-]+$/;

/** Digit tokens: name first. The value is passed as a GraphQL variable, not interpolated into the document. */
export function nameSearchQuery(digits: string): string | null {
  if (!SEARCH_VALUE.test(digits)) {
    return null;
  }
  return `name:"#${digits}"`;
}

/** Name or confirmation number. Exactly one node is a match. */
export function tokenSearchQuery(value: string): string | null {
  if (!SEARCH_VALUE.test(value)) {
    return null;
  }
  return `name:"${value}" OR name:"#${value}" OR confirmation_number:"${value}"`;
}

export function legacyOrderGid(digits: string): string | null {
  if (!/^[0-9]+$/.test(digits)) {
    return null;
  }
  return `gid://shopify/Order/${digits}`;
}
