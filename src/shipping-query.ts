import { DELIVERY_GROUP_PAGE_SIZE } from "./delivery-groups.js";

/**
 * Delivery groups for shipping discovery.
 * Selects only Storefront API 2026-10 CartDeliveryOption fields that this route maps.
 * Does not select checkoutUrl, cart id, line ids, or unstable delivery dates.
 * Checkout initiate keeps CART_DELIVERY_GROUPS_DOCUMENT (handle only).
 */
export const CART_SHIPPING_OPTIONS_DOCUMENT = `
query CartShippingOptions($id: ID!, $after: String) {
  cart(id: $id) {
    cost { totalAmount { currencyCode } }
    deliveryGroups(first: ${DELIVERY_GROUP_PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        deliveryOptions {
          handle
          title
          description
          deliveryMethodType
          estimatedCost { amount currencyCode }
        }
      }
    }
  }
}`;
