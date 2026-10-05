import { DELIVERY_GROUP_PAGE_SIZE } from "./delivery-groups.js";

/** Checkout mutations. checkoutUrl is not selected here. */

export const CART_BUYER_IDENTITY_UPDATE_DOCUMENT = `
mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
  cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
    cart { totalQuantity }
    userErrors { field message code }
  }
}`;

export const CART_DELIVERY_ADDRESSES_REPLACE_DOCUMENT = `
mutation CartDeliveryAddressesReplace($cartId: ID!, $addresses: [CartSelectableAddressInput!]!) {
  cartDeliveryAddressesReplace(cartId: $cartId, addresses: $addresses) {
    cart { totalQuantity }
    userErrors { field message code }
  }
}`;

/** Delivery groups only. Used to match shippingOptionId to a delivery option handle. */
export const CART_DELIVERY_GROUPS_DOCUMENT = `
query CartDeliveryGroups($id: ID!, $after: String) {
  cart(id: $id) {
    deliveryGroups(first: ${DELIVERY_GROUP_PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        deliveryOptions { handle }
      }
    }
  }
}`;

export const CART_SELECTED_DELIVERY_OPTIONS_UPDATE_DOCUMENT = `
mutation CartSelectedDeliveryOptionsUpdate($cartId: ID!, $selectedDeliveryOptions: [CartSelectedDeliveryOptionInput!]!) {
  cartSelectedDeliveryOptionsUpdate(cartId: $cartId, selectedDeliveryOptions: $selectedDeliveryOptions) {
    cart { totalQuantity }
    userErrors { field message code }
  }
}`;

/** Checkout-only selection. Cart routes keep using CartFields, which does not select checkoutUrl. */
export const CART_CHECKOUT_URL_DOCUMENT = `
query CartCheckoutUrl($id: ID!) {
  cart(id: $id) {
    checkoutUrl
  }
}`;
