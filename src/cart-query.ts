import { VARIANT_PAGE_SIZE } from "./catalog-contract.js";

/** Storefront cart reads. checkoutUrl is not selected. */
const CART_LINE_PAGE = 100;

const CART_LINE_FIELDS = `
fragment CartLineFields on CartLine {
  id
  quantity
  merchandise {
    ... on ProductVariant {
      id
      title
      selectedOptions { name value }
      product { title }
    }
  }
  cost {
    amountPerQuantity { amount currencyCode }
    totalAmount { amount currencyCode }
  }
}`;

const CART_FIELDS = `
${CART_LINE_FIELDS}
fragment CartFields on Cart {
  id
  lines(first: ${CART_LINE_PAGE}) {
    pageInfo { hasNextPage endCursor }
    nodes { ...CartLineFields }
  }
  cost {
    subtotalAmount { amount currencyCode }
    totalAmount { amount currencyCode }
    totalTaxAmount { amount currencyCode }
    totalDutyAmount { amount currencyCode }
  }
  discountAllocations {
    discountedAmount { amount currencyCode }
    ... on CartCodeDiscountAllocation { code }
    ... on CartAutomaticDiscountAllocation { title }
    ... on CartCustomDiscountAllocation { title }
  }
}`;

export const CART_CREATE_DOCUMENT = `
${CART_FIELDS}
mutation CartCreate($input: CartInput!) {
  cartCreate(input: $input) {
    cart { ...CartFields }
    userErrors { field message code }
  }
}`;

export const CART_LINES_ADD_DOCUMENT = `
${CART_FIELDS}
mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
  cartLinesAdd(cartId: $cartId, lines: $lines) {
    cart { ...CartFields }
    userErrors { field message code }
  }
}`;

export const CART_LINES_UPDATE_DOCUMENT = `
${CART_FIELDS}
mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
  cartLinesUpdate(cartId: $cartId, lines: $lines) {
    cart { ...CartFields }
    userErrors { field message code }
  }
}`;

export const CART_LINES_REMOVE_DOCUMENT = `
${CART_FIELDS}
mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
  cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
    cart { ...CartFields }
    userErrors { field message code }
  }
}`;

export const CART_QUERY_DOCUMENT = `
${CART_FIELDS}
query CartFetch($id: ID!) {
  cart(id: $id) {
    ...CartFields
  }
}`;

export const CART_LINE_PAGE_DOCUMENT = `
${CART_LINE_FIELDS}
query CartLinePage($id: ID!, $after: String) {
  cart(id: $id) {
    lines(first: ${CART_LINE_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ...CartLineFields }
    }
  }
}`;

export const CART_VARIANT_DOCUMENT = `
query CartVariant($id: ID!) {
  node(id: $id) {
    __typename
    ... on ProductVariant { id }
  }
}`;

export const CART_PRODUCT_DOCUMENT = `
query CartProduct($id: ID!) {
  product(id: $id) {
    id
    variants(first: ${VARIANT_PAGE_SIZE}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        selectedOptions { name value }
      }
    }
  }
}`;

export const CART_VARIANT_PAGE_DOCUMENT = `
query CartVariantPage($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: ${VARIANT_PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        selectedOptions { name value }
      }
    }
  }
}`;
