import { isRecord } from "./json.js";
import { moneyAmount, sumMoney } from "./money.js";
import type { FieldError } from "./problems.js";

export type CartOperation =
  | "query"
  | "cartCreate"
  | "cartLinesAdd"
  | "cartLinesUpdate"
  | "cartLinesRemove"
  | "cartDiscountCodesUpdate";

export type DiscountCodeStatus = {
  code: string;
  applicable: boolean;
};

export type ShopifyLine = {
  lineGid: string;
  productId: string;
  quantity: number;
  price: Money;
  lineTotal: Money;
  name?: string;
  options?: Record<string, string>;
};

type Money = {
  amount: number;
  currency: string;
};

type DiscountEntry = {
  amount: number;
  code?: string;
  label?: string;
};

type AppliedDiscount = {
  amount: Money;
  code?: string;
  label?: string;
};

export type CartTotals = {
  currency: string;
  subtotal: number;
  discount: number;
  total: number;
  tax?: number;
  duty?: number;
  discountBreakdown?: DiscountEntry[];
};

export type CartView = {
  lines: ShopifyLine[];
  totals: CartTotals;
  hasNextPage: boolean;
  endCursor: string | null;
  appliedDiscounts?: AppliedDiscount[];
};

export type CartResult =
  | { kind: "ok"; shopifyCartId: string; view: CartView; discountCodes?: DiscountCodeStatus[] }
  | { kind: "empty" }
  | { kind: "rejected"; errors: FieldError[] }
  | { kind: "invalid"; discountCodes?: DiscountCodeStatus[] };

type LinePage = {
  lines: ShopifyLine[];
  hasNextPage: boolean;
  endCursor: string | null;
};

const OPERATION_FIELD: Record<Exclude<CartOperation, "query">, string> = {
  cartCreate: "cartCreate",
  cartLinesAdd: "cartLinesAdd",
  cartLinesUpdate: "cartLinesUpdate",
  cartLinesRemove: "cartLinesRemove",
  cartDiscountCodesUpdate: "cartDiscountCodesUpdate",
};

export function readCartResult(data: unknown, operation: CartOperation): CartResult {
  if (!isRecord(data)) {
    return { kind: "invalid" };
  }
  if (operation === "query") {
    if (!Object.hasOwn(data, "cart")) {
      return { kind: "invalid" };
    }
    if (data.cart === null) {
      return { kind: "empty" };
    }
    const parsed = readCart(data.cart);
    return parsed === null ? { kind: "invalid" } : { kind: "ok", ...parsed };
  }
  const field = OPERATION_FIELD[operation];
  const payload = data[field];
  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) {
    return { kind: "invalid" };
  }
  const errors = readUserErrors(payload.userErrors);
  if (errors === "invalid") {
    return { kind: "invalid" };
  }
  if (errors.length > 0) {
    return { kind: "rejected", errors };
  }
  if (!isRecord(payload.cart)) {
    return { kind: "invalid" };
  }
  const discountCodes = operation === "cartDiscountCodesUpdate" ? readDiscountCodes(payload.cart) : undefined;
  if (discountCodes === "invalid") {
    return { kind: "invalid" };
  }
  const parsed = readCart(payload.cart);
  if (parsed === null) {
    return discountCodes === undefined ? { kind: "invalid" } : { kind: "invalid", discountCodes };
  }
  return discountCodes === undefined ? { kind: "ok", ...parsed } : { kind: "ok", ...parsed, discountCodes };
}

export function readLinePage(data: unknown): LinePage | null {
  if (!isRecord(data) || !isRecord(data.cart)) {
    return null;
  }
  return readLineConnection(data.cart.lines);
}

export function appendLines(view: CartView, page: LinePage): CartView {
  const next: CartView = {
    lines: [...view.lines, ...page.lines],
    totals: view.totals,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
  };
  if (view.appliedDiscounts !== undefined) {
    next.appliedDiscounts = view.appliedDiscounts;
  }
  return next;
}

export function toCartResponse(input: {
  cartId: string;
  createdAt: number;
  updatedAt: number;
  extensions: Record<string, unknown> | null;
  lines: { itemId: string; line: ShopifyLine }[];
  view: CartView;
  message?: string;
}): { cart: Record<string, unknown>; message?: string } {
  const items = input.lines.map((entry) => publicLine(entry.itemId, entry.line));
  const totals = publicTotals(input.view.totals);
  const cart: Record<string, unknown> = {
    id: input.cartId,
    items,
    totals,
    created: new Date(input.createdAt).toISOString(),
    updated: new Date(input.updatedAt).toISOString(),
  };
  if (input.view.appliedDiscounts !== undefined) {
    cart.appliedDiscounts = input.view.appliedDiscounts.map((discount) => publicDiscount(discount));
  }
  if (input.extensions !== null) {
    cart.extensions = input.extensions;
  }
  if (input.message === undefined) {
    return { cart };
  }
  return { cart, message: input.message };
}

function publicLine(itemId: string, line: ShopifyLine): Record<string, unknown> {
  const item: Record<string, unknown> = {
    itemId,
    productId: line.productId,
    quantity: line.quantity,
    price: line.price,
    lineTotal: line.lineTotal,
  };
  if (line.name !== undefined) {
    item.name = line.name;
  }
  if (line.options !== undefined) {
    item.options = line.options;
  }
  return item;
}

function publicTotals(totals: CartTotals): Record<string, unknown> {
  const body: Record<string, unknown> = {
    currency: totals.currency,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
  };
  if (totals.tax !== undefined) {
    body.tax = totals.tax;
  }
  if (totals.duty !== undefined) {
    body.duty = totals.duty;
  }
  if (totals.discountBreakdown !== undefined) {
    body.discountBreakdown = totals.discountBreakdown.map((entry) => publicDiscountEntry(entry));
  }
  return body;
}

function publicDiscount(discount: AppliedDiscount): Record<string, unknown> {
  const body: Record<string, unknown> = { amount: discount.amount };
  if (discount.code !== undefined) {
    body.code = discount.code;
  }
  if (discount.label !== undefined) {
    body.label = discount.label;
  }
  return body;
}

function publicDiscountEntry(entry: DiscountEntry): Record<string, unknown> {
  const body: Record<string, unknown> = { amount: entry.amount };
  if (entry.code !== undefined) {
    body.code = entry.code;
  }
  if (entry.label !== undefined) {
    body.label = entry.label;
  }
  return body;
}

function readCart(value: unknown): { shopifyCartId: string; view: CartView } | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  const lines = readLineConnection(value.lines);
  const totals = readTotals(value);
  if (lines === null || totals === null) {
    return null;
  }
  const view: CartView = {
    lines: lines.lines,
    totals: totals.totals,
    hasNextPage: lines.hasNextPage,
    endCursor: lines.endCursor,
  };
  if (totals.appliedDiscounts !== undefined) {
    view.appliedDiscounts = totals.appliedDiscounts;
  }
  return { shopifyCartId: value.id, view };
}

function readTotals(cart: Record<string, unknown>): { totals: CartTotals; appliedDiscounts?: AppliedDiscount[] } | null {
  if (!isRecord(cart.cost)) {
    return null;
  }
  const subtotal = readMoney(cart.cost.subtotalAmount);
  const total = readMoney(cart.cost.totalAmount);
  const tax = readOptionalMoney(cart.cost.totalTaxAmount);
  const duty = readOptionalMoney(cart.cost.totalDutyAmount);
  if (subtotal === null || total === null || tax === "invalid" || duty === "invalid") {
    return null;
  }
  const allocations = readAllocations(cart.discountAllocations);
  if (allocations === "invalid") {
    return null;
  }
  const discount = discountAmount(allocations);
  if (discount === null) {
    return null;
  }
  const totals: CartTotals = {
    currency: total.currency,
    subtotal: subtotal.amount,
    discount,
    total: total.amount,
  };
  if (tax !== null) {
    totals.tax = tax.amount;
  }
  if (duty !== null) {
    totals.duty = duty.amount;
  }
  const result: { totals: CartTotals; appliedDiscounts?: AppliedDiscount[] } = { totals };
  if (allocations.length > 0) {
    const breakdown: DiscountEntry[] = [];
    const applied: AppliedDiscount[] = [];
    for (const allocation of allocations) {
      const amount = moneyAmount(allocation.amountText, allocation.currency);
      if (amount === null) {
        return null;
      }
      breakdown.push(discountEntry(amount, allocation.code, allocation.label));
      if (allocation.code !== undefined) {
        applied.push({
          amount: { amount, currency: allocation.currency },
          code: allocation.code,
          label: allocation.label ?? allocation.code,
        });
      }
    }
    totals.discountBreakdown = breakdown;
    if (applied.length > 0) {
      result.appliedDiscounts = applied;
    }
  }
  return result;
}

type Allocation = {
  amountText: string;
  currency: string;
  code?: string;
  label?: string;
};

function discountAmount(allocations: Allocation[]): number | null {
  if (allocations.length === 0) {
    return 0;
  }
  const currency = allocations[0]?.currency;
  if (currency === undefined || allocations.some((allocation) => allocation.currency !== currency)) {
    return null;
  }
  return sumMoney(
    allocations.map((allocation) => allocation.amountText),
    currency,
  );
}

function discountEntry(amount: number, code: string | undefined, label: string | undefined): DiscountEntry {
  const entry: DiscountEntry = { amount };
  if (code !== undefined) {
    entry.code = code;
  }
  if (label !== undefined) {
    entry.label = label;
  }
  return entry;
}

function readAllocations(value: unknown): Allocation[] | "invalid" {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return "invalid";
  }
  const allocations: Allocation[] = [];
  for (const entry of value) {
    const allocation = readAllocation(entry);
    if (allocation === null) {
      return "invalid";
    }
    allocations.push(allocation);
  }
  return allocations;
}

function readAllocation(value: unknown): Allocation | null {
  if (!isRecord(value) || !isRecord(value.discountedAmount)) {
    return null;
  }
  const amountText = value.discountedAmount.amount;
  const currencyCode = value.discountedAmount.currencyCode;
  if (typeof amountText !== "string" || typeof currencyCode !== "string") {
    return null;
  }
  const currency = currencyCode.trim().toUpperCase();
  if (currency === "" || moneyAmount(amountText, currency) === null) {
    return null;
  }
  const allocation: Allocation = { amountText, currency };
  if (typeof value.code === "string" && value.code !== "") {
    allocation.code = value.code;
  }
  if (typeof value.title === "string" && value.title !== "") {
    allocation.label = value.title;
  }
  return allocation;
}

function readLineConnection(value: unknown): LinePage | null {
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
  const lines: ShopifyLine[] = [];
  for (const node of value.nodes) {
    const line = readLine(node);
    if (line === null) {
      return null;
    }
    lines.push(line);
  }
  return { lines, hasNextPage: value.pageInfo.hasNextPage, endCursor: cursor };
}

function readLine(value: unknown): ShopifyLine | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  if (typeof value.quantity !== "number" || !Number.isInteger(value.quantity) || value.quantity < 0) {
    return null;
  }
  if (!isRecord(value.merchandise) || typeof value.merchandise.id !== "string" || value.merchandise.id === "") {
    return null;
  }
  if (!isRecord(value.cost)) {
    return null;
  }
  const price = readMoney(value.cost.amountPerQuantity);
  const lineTotal = readMoney(value.cost.totalAmount);
  if (price === null || lineTotal === null) {
    return null;
  }
  const line: ShopifyLine = {
    lineGid: value.id,
    productId: value.merchandise.id,
    quantity: value.quantity,
    price,
    lineTotal,
  };
  const name = lineName(value.merchandise);
  if (name !== undefined) {
    line.name = name;
  }
  const options = readOptions(value.merchandise.selectedOptions);
  if (options !== undefined) {
    line.options = options;
  }
  return line;
}

function lineName(merchandise: Record<string, unknown>): string | undefined {
  if (isRecord(merchandise.product) && typeof merchandise.product.title === "string") {
    const title = merchandise.product.title.trim();
    if (title !== "") {
      return title;
    }
  }
  if (typeof merchandise.title === "string") {
    const title = merchandise.title.trim();
    if (title !== "" && title !== "Default Title") {
      return title;
    }
  }
  return undefined;
}

function readOptions(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options: Record<string, string> = {};
  for (const option of value) {
    if (!isRecord(option) || typeof option.name !== "string" || typeof option.value !== "string") {
      continue;
    }
    const name = option.name.trim();
    if (name === "") {
      continue;
    }
    options[name] = option.value;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function readMoney(value: unknown): Money | null {
  if (!isRecord(value) || typeof value.amount !== "string" || typeof value.currencyCode !== "string") {
    return null;
  }
  const currency = value.currencyCode.trim().toUpperCase();
  if (currency === "") {
    return null;
  }
  const amount = moneyAmount(value.amount, currency);
  if (amount === null) {
    return null;
  }
  return { amount, currency };
}

function readOptionalMoney(value: unknown): Money | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  const money = readMoney(value);
  return money === null ? "invalid" : money;
}

function readDiscountCodes(cart: Record<string, unknown>): DiscountCodeStatus[] | "invalid" {
  if (!Object.hasOwn(cart, "discountCodes") || !Array.isArray(cart.discountCodes)) {
    return "invalid";
  }
  const codes: DiscountCodeStatus[] = [];
  for (const entry of cart.discountCodes) {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.applicable !== "boolean") {
      return "invalid";
    }
    codes.push({ code: entry.code, applicable: entry.applicable });
  }
  return codes;
}

function readUserErrors(value: unknown[]): FieldError[] | "invalid" {
  const errors: FieldError[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.message !== "string" || entry.message.trim() === "") {
      return "invalid";
    }
    errors.push({
      field: userErrorField(entry.field),
      message: publicUserMessage(entry.message),
    });
  }
  return errors;
}

function userErrorField(value: unknown): string {
  if (!Array.isArray(value)) {
    return "cart";
  }
  const parts = value.filter((part): part is string => typeof part === "string" && part !== "" && !part.includes("key="));
  return parts.length > 0 ? parts.join(".") : "cart";
}

function publicUserMessage(message: string): string {
  if (
    message.includes("key=") ||
    message.includes("checkoutUrl") ||
    message.includes("gid://shopify/Cart/") ||
    message.includes("gid://shopify/CartLine/")
  ) {
    return "Shopify rejected the cart change.";
  }
  return message;
}
