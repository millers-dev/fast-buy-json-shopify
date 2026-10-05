/**
 * Storefront API 2026-10 shipping decisions, re-checked against the public
 * CartDeliveryOption and CartDeliveryGroup reference on 2026-10-05.
 *
 * CartDeliveryOption fields on 2026-10: code, deliveryMethodType, description,
 * estimatedCost, handle, title. CartDeliveryGroup has no day-bound field.
 * minEstimatedDeliveryDate and maxEstimatedDeliveryDate exist on unstable and
 * are not selected. The API pin stays 2026-10.
 *
 * An option is included only when the payload already carries non-negative
 * integer minDays and maxDays (on the option or one nested object). Titles and
 * descriptions are not parsed into a range. omittedOptionCount is present only
 * when at least one Shopify option was left out.
 */

export const CART_DELIVERY_OPTION_FIELDS_ON_2026_10 = [
  "code",
  "deliveryMethodType",
  "description",
  "estimatedCost",
  "handle",
  "title",
] as const;

/** 2026-10 has no CartDeliveryOption field that supplies minDays and maxDays. */
export const DELIVERY_OPTION_DAY_BOUND_FIELDS_ON_2026_10 = [] as const;

export const DELIVERY_DAY_BOUNDS_ON_2026_10 =
  "Storefront API 2026-10 CartDeliveryOption fields are code, deliveryMethodType, description, estimatedCost, handle, and title. CartDeliveryGroup has no day bounds. minEstimatedDeliveryDate and maxEstimatedDeliveryDate are on unstable and are not selected. The connector does not invent minDays or maxDays from a title or description. Options without usable integer day bounds are omitted. omittedOptionCount is included only when at least one option was omitted. Local pickup uses the same rule. Duplicate handles are kept once, the first option that can be included.";
