export type ProblemCode = "INTERNAL_ERROR" | "VALIDATION_ERROR" | "RATE_LIMITED";

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

export function rateLimited(): Problem {
  return {
    type: "https://fastbuyjson.org/problems/rate-limited",
    title: "Rate limited",
    status: 429,
    code: "RATE_LIMITED",
    detail: "Shopify throttled the catalog request.",
  };
}
