import { isRecord } from "./json.js";

/** Storefront `deliveryGroups` page size. Checkout selection and shipping discovery share it. */
export const DELIVERY_GROUP_PAGE_SIZE = 20;

/** Hard stop for `deliveryGroups` pagination. */
export const MAX_DELIVERY_GROUP_PAGES = 5;

export type DeliveryGroupPage<T> =
  | { kind: "ok"; groups: T[]; hasNextPage: boolean; endCursor: string | null; cart: Record<string, unknown> }
  | { kind: "missing"; cart: Record<string, unknown> | null }
  | { kind: "gone" }
  | { kind: "invalid" };

/** Read one `cart.deliveryGroups` connection. `readNode` returns null when a node is unusable. */
export function readDeliveryGroupPage<T>(
  data: unknown,
  readNode: (node: unknown) => T | null,
): DeliveryGroupPage<T> {
  if (!isRecord(data) || !Object.hasOwn(data, "cart")) {
    return { kind: "invalid" };
  }
  if (data.cart === null) {
    return { kind: "gone" };
  }
  if (!isRecord(data.cart)) {
    return { kind: "missing", cart: null };
  }
  if (!Object.hasOwn(data.cart, "deliveryGroups")) {
    return { kind: "missing", cart: data.cart };
  }
  const connection = data.cart.deliveryGroups;
  if (connection === null) {
    return { kind: "missing", cart: data.cart };
  }
  if (!isRecord(connection) || !isRecord(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== "boolean") {
    return { kind: "invalid" };
  }
  if (!Array.isArray(connection.nodes)) {
    return { kind: "invalid" };
  }
  const endCursor = connection.pageInfo.endCursor;
  const cursor = typeof endCursor === "string" && endCursor !== "" ? endCursor : null;
  if (connection.pageInfo.hasNextPage && cursor === null) {
    return { kind: "invalid" };
  }
  const groups: T[] = [];
  for (const node of connection.nodes) {
    const group = readNode(node);
    if (group === null) {
      return { kind: "invalid" };
    }
    groups.push(group);
  }
  return {
    kind: "ok",
    groups,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: cursor,
    cart: data.cart,
  };
}
