import { CART_PRODUCT_DOCUMENT, CART_VARIANT_DOCUMENT, CART_VARIANT_PAGE_DOCUMENT } from "./cart-query.js";
import { isRecord } from "./json.js";
import type { ShopifyCall } from "./shopify-graphql.js";

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[^/?#\s]+$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[^/?#\s]+$/;
const MAX_VARIANT_PAGES = 20;

export type StorefrontCaller = (query: string, variables: Record<string, unknown>) => Promise<ShopifyCall>;

export type ResolveResult =
  | { kind: "ok"; variantId: string }
  | { kind: "not_found" }
  | { kind: "ambiguous" }
  | { kind: "throttled" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

type SelectedOption = {
  name: string;
  value: string;
};

type ResolvedVariant = {
  id: string;
  options: SelectedOption[];
};

type VariantPage = {
  variants: ResolvedVariant[];
  hasNextPage: boolean;
  endCursor: string | null;
};

export function isMerchandiseGid(productId: string): boolean {
  return VARIANT_GID.test(productId) || PRODUCT_GID.test(productId);
}

export async function resolveMerchandise(
  call: StorefrontCaller,
  productId: string,
  options: Record<string, unknown> | undefined,
): Promise<ResolveResult> {
  if (VARIANT_GID.test(productId)) {
    return resolveVariant(call, productId);
  }
  if (PRODUCT_GID.test(productId)) {
    return resolveProduct(call, productId, options);
  }
  return { kind: "not_found" };
}

async function resolveVariant(call: StorefrontCaller, productId: string): Promise<ResolveResult> {
  const result = await call(CART_VARIANT_DOCUMENT, { id: productId });
  if (result.kind !== "ok") {
    return { kind: result.kind };
  }
  const variantId = readVariantId(result.data);
  if (variantId === null) {
    return { kind: "failed" };
  }
  if (variantId === "missing") {
    return { kind: "not_found" };
  }
  return { kind: "ok", variantId };
}

async function resolveProduct(
  call: StorefrontCaller,
  productId: string,
  options: Record<string, unknown> | undefined,
): Promise<ResolveResult> {
  const first = await call(CART_PRODUCT_DOCUMENT, { id: productId });
  if (first.kind !== "ok") {
    return { kind: first.kind };
  }
  const page = readProductVariants(first.data);
  if (page === null) {
    return { kind: "failed" };
  }
  if (page === "missing") {
    return { kind: "not_found" };
  }
  const variants = [...page.variants];
  let hasNextPage = page.hasNextPage;
  let after = page.endCursor;
  for (let index = 0; hasNextPage && index < MAX_VARIANT_PAGES; index += 1) {
    if (after === null) {
      return { kind: "failed" };
    }
    const next = await call(CART_VARIANT_PAGE_DOCUMENT, { id: productId, after });
    if (next.kind !== "ok") {
      return { kind: next.kind };
    }
    const more = readProductVariants(next.data);
    if (more === null || more === "missing") {
      return { kind: "failed" };
    }
    variants.push(...more.variants);
    hasNextPage = more.hasNextPage;
    after = more.endCursor;
  }
  if (hasNextPage) {
    return { kind: "failed" };
  }
  const selected = selectVariant(variants, options);
  if (selected === "ambiguous") {
    return { kind: "ambiguous" };
  }
  return { kind: "ok", variantId: selected };
}

function selectVariant(variants: ResolvedVariant[], options: Record<string, unknown> | undefined): string | "ambiguous" {
  const only = variants[0];
  if (variants.length === 1 && only !== undefined) {
    return only.id;
  }
  const matched = variants.filter((variant) => optionsMatch(variant.options, options));
  const chosen = matched[0];
  if (matched.length === 1 && chosen !== undefined) {
    return chosen.id;
  }
  return "ambiguous";
}

function optionsMatch(selected: SelectedOption[], requested: Record<string, unknown> | undefined): boolean {
  const entries = Object.entries(requested ?? {});
  if (selected.length !== entries.length) {
    return false;
  }
  const used = new Set<number>();
  for (const option of selected) {
    const index = entries.findIndex((entry, entryIndex) => {
      if (used.has(entryIndex)) {
        return false;
      }
      const [key, value] = entry;
      return namesEqual(key, option.name) && valuesEqual(value, option.value);
    });
    if (index < 0) {
      return false;
    }
    used.add(index);
  }
  return true;
}

function namesEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function valuesEqual(value: unknown, expected: string): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().toLowerCase() === expected.trim().toLowerCase();
  }
  return false;
}

function readVariantId(data: unknown): string | "missing" | null {
  if (!isRecord(data) || !Object.hasOwn(data, "node")) {
    return null;
  }
  if (data.node === null) {
    return "missing";
  }
  if (!isRecord(data.node)) {
    return null;
  }
  if (data.node.__typename !== undefined && data.node.__typename !== "ProductVariant") {
    return "missing";
  }
  if (typeof data.node.id !== "string" || data.node.id === "") {
    return "missing";
  }
  return data.node.id;
}

function readProductVariants(data: unknown): VariantPage | "missing" | null {
  if (!isRecord(data) || !Object.hasOwn(data, "product")) {
    return null;
  }
  if (data.product === null) {
    return "missing";
  }
  if (!isRecord(data.product)) {
    return null;
  }
  return readVariantConnection(data.product.variants);
}

function readVariantConnection(value: unknown): VariantPage | null {
  if (!isRecord(value) || !isRecord(value.pageInfo) || typeof value.pageInfo.hasNextPage !== "boolean") {
    return null;
  }
  if (!Array.isArray(value.nodes)) {
    return null;
  }
  const endCursor = value.pageInfo.endCursor;
  const cursor = typeof endCursor === "string" && endCursor !== "" ? endCursor : null;
  if (value.pageInfo.hasNextPage && cursor === null) {
    return null;
  }
  const variants: ResolvedVariant[] = [];
  for (const node of value.nodes) {
    const variant = readVariant(node);
    if (variant === null) {
      return null;
    }
    variants.push(variant);
  }
  return { variants, hasNextPage: value.pageInfo.hasNextPage, endCursor: cursor };
}

function readVariant(value: unknown): ResolvedVariant | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  const options: SelectedOption[] = [];
  if (Array.isArray(value.selectedOptions)) {
    for (const option of value.selectedOptions) {
      if (!isRecord(option) || typeof option.name !== "string" || typeof option.value !== "string") {
        return null;
      }
      if (option.name.trim() === "") {
        return null;
      }
      options.push({ name: option.name, value: option.value });
    }
  }
  return { id: value.id, options };
}
