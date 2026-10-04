export type ProblemCode =
  | "INTERNAL_ERROR"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "PRODUCT_NOT_FOUND"
  | "CART_NOT_FOUND"
  | "CART_ITEM_NOT_FOUND"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "INVALID_DISCOUNT_CODE";

export type FieldError = {
  field: string;
  message: string;
};

export type Problem = {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  errors?: FieldError[];
};

export const REINSTALL_DETAIL = "The shop must be reinstalled.";
export const ONE_SHOP_DETAIL = "This process already stores a token for a different shop.";
export const DECRYPT_DETAIL = "The token store could not be decrypted.";

export function internalError(detail: string): Problem {
  return {
    type: "https://fastbuyjson.org/problems/internal-error",
    title: "Internal error",
    status: 500,
    code: "INTERNAL_ERROR",
    detail,
  };
}

export function validationError(detail: string, errors?: FieldError[]): Problem {
  const problem: Problem = {
    type: "https://fastbuyjson.org/problems/validation-error",
    title: "Validation failed",
    status: 400,
    code: "VALIDATION_ERROR",
    detail,
  };
  if (errors !== undefined) {
    problem.errors = errors;
  }
  return problem;
}

export function rateLimited(detail = "Shopify throttled the catalog request."): Problem {
  return {
    type: "https://fastbuyjson.org/problems/rate-limited",
    title: "Rate limited",
    status: 429,
    code: "RATE_LIMITED",
    detail,
  };
}

export function productNotFound(productId: string): Problem {
  return {
    type: "https://fastbuyjson.org/problems/product-not-found",
    title: "Product not found",
    status: 404,
    code: "PRODUCT_NOT_FOUND",
    detail: detailWithoutCartKey(productId, `No product with id ${productId}`, "No product matches that id."),
  };
}

export function cartNotFound(detail = "No cart exists for the current identity"): Problem {
  return {
    type: "https://fastbuyjson.org/problems/cart-not-found",
    title: "Cart not found",
    status: 404,
    code: "CART_NOT_FOUND",
    detail: detail.includes("key=") ? "No cart exists for the current identity" : detail,
  };
}

export function cartItemNotFound(itemId: string): Problem {
  return {
    type: "https://fastbuyjson.org/problems/cart-item-not-found",
    title: "Cart item not found",
    status: 404,
    code: "CART_ITEM_NOT_FOUND",
    detail: detailWithoutCartKey(itemId, `No cart item with id ${itemId}`, "No cart item matches that id."),
  };
}

export function invalidDiscountCode(): Problem {
  return {
    type: "https://fastbuyjson.org/problems/invalid-discount-code",
    title: "Invalid discount code",
    status: 422,
    code: "INVALID_DISCOUNT_CODE",
    detail: "The discount code does not apply to this cart.",
  };
}

export function idempotencyConflict(): Problem {
  return {
    type: "https://fastbuyjson.org/problems/idempotency-key-conflict",
    title: "Idempotency key conflict",
    status: 409,
    code: "IDEMPOTENCY_KEY_CONFLICT",
    detail: "The same Idempotency-Key was used with a different request payload",
  };
}

function detailWithoutCartKey(value: string, detail: string, fallback: string): string {
  if (value.includes("key=") || detail.includes("key=")) {
    return fallback;
  }
  return detail;
}
