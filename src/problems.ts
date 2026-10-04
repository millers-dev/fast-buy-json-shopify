export type Problem = {
  type: string;
  title: string;
  status: number;
  code: "INTERNAL_ERROR";
  detail: string;
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
