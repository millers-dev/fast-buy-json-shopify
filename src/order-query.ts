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
 * The selection set does not read phone, customer name, `CardPaymentDetails`,
 * `email`, or the Order GID. The owned `order(id:)` read adds `shippingAddress`
 * and `billingAddress` and does not add `email`. That address selection is
 * `address1`, `address2`, `city`, `province`, `countryCodeV2`, and `zip`.
 * It does not read `displayAddress`, `country`, `countryCode`, or `provinceCode`.
 * Later line-item pages use the address-free selection.
 * `SHOPIFY_ORDER_ADDRESS_GATE` and `?email=` were removed. Addresses are mapped
 * only for the authenticated owner.
 */

/** Which address fields an Admin order read selects, and how field errors are classified. */
export type OrderAddressRead = "off" | "owner";

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

const MAILING_ADDRESS_FIELDS = `
    shippingAddress {
      address1
      address2
      city
      province
      countryCodeV2
      zip
    }
    billingAddress {
      address1
      address2
      city
      province
      countryCodeV2
      zip
    }`;

function orderFields(read: OrderAddressRead): string {
  switch (read) {
    case "off":
      return ORDER_FIELDS;
    case "owner":
      return `${ORDER_FIELDS}${MAILING_ADDRESS_FIELDS}`;
    default: {
      const unexpected: never = read;
      throw new Error(`Unhandled order address fields: ${String(unexpected)}`);
    }
  }
}

/** Later line-item pages. No mailing addresses and no `email`. */
export const ORDER_BY_ID_DOCUMENT = orderByIdDocumentFor("off");

/** Owned Admin order. Addresses, no `email`. */
export const ORDER_BY_ID_OWNER_ADDRESS_DOCUMENT = orderByIdDocumentFor("owner");

function orderByIdDocumentFor(read: OrderAddressRead): string {
  return `
query OrderById($id: ID!, $after: String) {
  order(id: $id) {${orderFields(read)}
  }
}`;
}

const SEARCH_VALUE = /^[A-Za-z0-9_-]+$/;

/** Name or confirmation number. Exactly one node is a match. */
export function tokenSearchQuery(value: string): string | null {
  if (!SEARCH_VALUE.test(value)) {
    return null;
  }
  return `name:"${value}" OR name:"#${value}" OR confirmation_number:"${value}"`;
}

/**
 * Customer Account API ownership read. The search string is a variable.
 * `customer.orders` is not `order(id:)`. The document does not select email.
 */
export const CUSTOMER_OWNED_ORDERS_DOCUMENT = `
query CustomerOwnedOrders($query: String!) {
  customer {
    id
    orders(first: 2, query: $query) {
      nodes {
        id
        name
      }
    }
  }
}`;

const ORDER_DIGITS = /^[0-9]+$/;

/** Digit tokens on `customer.orders`: `name:#<digits>` first. Unquoted, as in the ownership plan. */
export function customerOrdersNameQuery(digits: string): string | null {
  if (!ORDER_DIGITS.test(digits)) {
    return null;
  }
  return `name:#${digits}`;
}

/** `id:<digits>` on `customer.orders`. The node `id` must still equal the order GID. */
export function customerOrdersIdQuery(digits: string): string | null {
  if (!ORDER_DIGITS.test(digits)) {
    return null;
  }
  return `id:${digits}`;
}

export function orderGidDigits(gid: string): string | null {
  const match = /^gid:\/\/shopify\/Order\/([0-9]+)$/.exec(gid);
  const digits = match?.[1];
  if (digits === undefined || !ORDER_DIGITS.test(digits)) {
    return null;
  }
  return digits;
}
