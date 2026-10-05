import { isRecord } from "./json.js";
import { moneyAmount } from "./money.js";

const ORDER_GID = /^gid:\/\/shopify\/Order\/[0-9]+$/;
const ORDER_TOKEN = /^#?[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 40;

const FINANCIAL_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "PAID",
  "PARTIALLY_PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "EXPIRED",
  "VOIDED",
] as const;

type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

export type OrderLookup =
  | { kind: "gid"; gid: string }
  | { kind: "digits"; digits: string; responseId: string }
  | { kind: "search"; value: string; responseId: string }
  | { kind: "reject" };

export type OrderStatusName = "confirmed" | "processing" | "shipped" | "cancelled" | "refunded";

type PaymentStatus = "pending" | "approved" | "declined" | "refunded";

type Money = { amount: number; currency: string };

type OrderLine = {
  productId: string;
  quantity: number;
  price: Money;
  lineTotal: Money;
  name?: string;
  options?: Record<string, string>;
};

type OrderTotals = {
  subtotal: number;
  total: number;
  tax?: number;
  shipping?: number;
  discount?: number;
};

type Payment = { method: string; status: PaymentStatus };

type Shipment = { trackingNumber: string; carrier?: string; trackingUrl?: string };

export type OrderStatusBody = {
  order: {
    id: string;
    status: OrderStatusName;
    items: OrderLine[];
    totals: OrderTotals;
    created: string;
    updated?: string;
    payment?: Payment;
    shipment?: Shipment;
  };
};

export type MappedOrder = { kind: "ok"; body: OrderStatusBody } | { kind: "invalid" };

export type IdMode = "client" | "name";

export function classifyOrderToken(token: string): OrderLookup {
  if (token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
    return { kind: "reject" };
  }
  if (ORDER_GID.test(token)) {
    return { kind: "gid", gid: token };
  }
  if (!ORDER_TOKEN.test(token)) {
    return { kind: "reject" };
  }
  const responseId = token.startsWith("#") ? token.slice(1) : token;
  if (responseId.length === 0) {
    return { kind: "reject" };
  }
  if (/^[0-9]+$/.test(responseId)) {
    return { kind: "digits", digits: responseId, responseId };
  }
  return { kind: "search", value: responseId, responseId };
}

export function mapOrder(
  order: Record<string, unknown>,
  lines: readonly unknown[],
  idMode: IdMode,
  clientId: string,
): MappedOrder {
  const id = idMode === "client" ? clientIdFromToken(clientId) : idFromName(order.name);
  if (id === null) {
    return { kind: "invalid" };
  }
  const financial = readStatus(order.displayFinancialStatus);
  const fulfillment = readStatus(order.displayFulfillmentStatus);
  if (financial === "invalid" || fulfillment === "invalid") {
    return { kind: "invalid" };
  }
  const items = mapLines(lines);
  if (items === null) {
    return { kind: "invalid" };
  }
  const totals = mapTotals(order);
  if (totals === null) {
    return { kind: "invalid" };
  }
  if (typeof order.createdAt !== "string" || order.createdAt === "") {
    return { kind: "invalid" };
  }
  const payment = mapPayment(order.paymentGatewayNames, financial);
  if (payment === "invalid") {
    return { kind: "invalid" };
  }
  const shipment = mapShipment(order.fulfillments);
  if (shipment === "invalid") {
    return { kind: "invalid" };
  }
  const body: OrderStatusBody = {
    order: {
      id,
      status: mapDisplayStatus(order.cancelledAt, financial, fulfillment),
      items,
      totals,
      created: order.createdAt,
    },
  };
  if (typeof order.updatedAt === "string" && order.updatedAt !== "") {
    body.order.updated = order.updatedAt;
  } else if (order.updatedAt !== undefined && order.updatedAt !== null) {
    return { kind: "invalid" };
  }
  if (payment !== undefined) {
    body.order.payment = payment;
  }
  if (shipment !== undefined) {
    body.order.shipment = shipment;
  }
  return { kind: "ok", body };
}

export function mapDisplayStatus(
  cancelledAt: unknown,
  financial: string | null,
  fulfillment: string | null,
): OrderStatusName {
  if (cancelledAt !== null && cancelledAt !== undefined) {
    return "cancelled";
  }
  if (financial === "REFUNDED") {
    return "refunded";
  }
  if (fulfillment === "FULFILLED") {
    return "shipped";
  }
  if (financial === "PAID" && isUnfulfilled(fulfillment)) {
    return "confirmed";
  }
  return "processing";
}

function clientIdFromToken(clientId: string): string | null {
  if (clientId === "" || clientId.toLowerCase().includes("gid://")) {
    return null;
  }
  return clientId;
}

function idFromName(name: unknown): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const stripped = name.startsWith("#") ? name.slice(1) : name;
  if (stripped === "" || stripped.toLowerCase().includes("gid://")) {
    return null;
  }
  return stripped;
}

function readStatus(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    return "invalid";
  }
  return value;
}

function isUnfulfilled(value: string | null): boolean {
  return value === "UNFULFILLED" || value === "OPEN" || value === "RESTOCKED";
}

function mapLines(lines: readonly unknown[]): OrderLine[] | null {
  const items: OrderLine[] = [];
  for (const line of lines) {
    const mapped = mapLine(line);
    if (mapped === "skip") {
      continue;
    }
    if (mapped === "invalid") {
      return null;
    }
    items.push(mapped);
  }
  return items;
}

function mapLine(line: unknown): OrderLine | "skip" | "invalid" {
  if (!isRecord(line)) {
    return "invalid";
  }
  const productId = lineProductId(line);
  if (productId === undefined) {
    return "skip";
  }
  if (typeof line.quantity !== "number" || !Number.isInteger(line.quantity) || line.quantity < 0) {
    return "invalid";
  }
  const variant = isRecord(line.variant) ? line.variant : undefined;
  const price = readLineMoney(line, "discountedUnitPriceSet", "originalUnitPriceSet");
  const lineTotal = readLineMoney(line, "discountedTotalSet", "originalTotalSet");
  if (price === null || lineTotal === null) {
    return "invalid";
  }
  const item: OrderLine = {
    productId,
    quantity: line.quantity,
    price,
    lineTotal,
  };
  if (typeof line.title === "string" && line.title.trim() !== "") {
    item.name = line.title;
  } else if (line.title !== undefined && line.title !== null && typeof line.title !== "string") {
    return "invalid";
  }
  const options = readOptions(variant);
  if (options !== undefined) {
    item.options = options;
  }
  return item;
}

function lineProductId(line: Record<string, unknown>): string | undefined {
  const variant = isRecord(line.variant) ? line.variant : undefined;
  const variantSku = nonGidString(variant?.sku);
  if (variantSku !== undefined) {
    return variantSku;
  }
  const lineSku = nonGidString(line.sku);
  if (lineSku !== undefined) {
    return lineSku;
  }
  return variant === undefined ? undefined : decimalId(variant.legacyResourceId);
}

function nonGidString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase().includes("gid://")) {
    return undefined;
  }
  return trimmed;
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function readOptions(variant: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (variant === undefined || !Array.isArray(variant.selectedOptions)) {
    return undefined;
  }
  const options: Record<string, string> = {};
  for (const option of variant.selectedOptions) {
    if (!isRecord(option) || typeof option.name !== "string" || typeof option.value !== "string") {
      continue;
    }
    const name = option.name.trim();
    if (name === "" || Object.hasOwn(options, name)) {
      continue;
    }
    options[name] = option.value;
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function mapTotals(order: Record<string, unknown>): OrderTotals | null {
  const subtotal = readRequiredMoney(order, "currentSubtotalPriceSet", "subtotalPriceSet");
  const total = readRequiredMoney(order, "currentTotalPriceSet", "totalPriceSet");
  if (subtotal === null || total === null) {
    return null;
  }
  const tax = readOptionalMoney(order, "currentTotalTaxSet", "totalTaxSet");
  const shipping = readOptionalMoney(order, "currentShippingPriceSet", "totalShippingPriceSet");
  const discount = readOptionalMoney(order, "currentTotalDiscountsSet", "totalDiscountsSet");
  if (tax === "invalid" || shipping === "invalid" || discount === "invalid") {
    return null;
  }
  const totals: OrderTotals = { subtotal, total };
  if (tax !== undefined) {
    totals.tax = tax;
  }
  if (shipping !== undefined) {
    totals.shipping = shipping;
  }
  if (discount !== undefined) {
    totals.discount = discount;
  }
  return totals;
}

function readLineMoney(line: Record<string, unknown>, primary: string, fallback: string): Money | null {
  const money = readShopMoney(pickBag(line, primary, fallback));
  if (money === null || money === "missing") {
    return null;
  }
  return money;
}

function readRequiredMoney(record: Record<string, unknown>, primary: string, fallback: string): number | null {
  const money = readShopMoney(pickBag(record, primary, fallback));
  if (money === null || money === "missing") {
    return null;
  }
  return money.amount;
}

function readOptionalMoney(
  record: Record<string, unknown>,
  primary: string,
  fallback: string,
): number | undefined | "invalid" {
  const money = readShopMoney(pickBag(record, primary, fallback));
  if (money === null) {
    return undefined;
  }
  if (money === "missing") {
    return "invalid";
  }
  return money.amount;
}

function pickBag(record: Record<string, unknown>, primary: string, fallback: string): unknown {
  const primaryBag = record[primary];
  if (primaryBag !== undefined && primaryBag !== null) {
    return primaryBag;
  }
  const fallbackBag = record[fallback];
  if (fallbackBag !== undefined && fallbackBag !== null) {
    return fallbackBag;
  }
  return null;
}

function readShopMoney(bag: unknown): Money | null | "missing" {
  if (bag === null || bag === undefined) {
    return null;
  }
  if (!isRecord(bag) || bag.shopMoney === null || bag.shopMoney === undefined) {
    return "missing";
  }
  if (!isRecord(bag.shopMoney)) {
    return "missing";
  }
  const amount = bag.shopMoney.amount;
  const currency = bag.shopMoney.currencyCode;
  if (typeof amount !== "string" || typeof currency !== "string" || currency.trim() === "") {
    return "missing";
  }
  const parsed = moneyAmount(amount, currency);
  if (parsed === null) {
    return "missing";
  }
  return { amount: parsed, currency };
}

function mapPayment(gateways: unknown, financial: string | null): Payment | undefined | "invalid" {
  if (financial === null || !isFinancial(financial)) {
    return undefined;
  }
  if (!Array.isArray(gateways) || gateways.length === 0) {
    return undefined;
  }
  const method = gateways[0];
  if (typeof method !== "string" || method === "") {
    return "invalid";
  }
  return { method, status: paymentStatus(financial) };
}

function mapShipment(fulfillments: unknown): Shipment | undefined | "invalid" {
  if (fulfillments === undefined || fulfillments === null) {
    return undefined;
  }
  if (!Array.isArray(fulfillments)) {
    return "invalid";
  }
  for (const fulfillment of fulfillments) {
    if (!isRecord(fulfillment)) {
      continue;
    }
    if (
      fulfillment.status === "CANCELLED" ||
      fulfillment.status === "ERROR" ||
      fulfillment.status === "FAILURE"
    ) {
      continue;
    }
    if (!Array.isArray(fulfillment.trackingInfo)) {
      continue;
    }
    for (const info of fulfillment.trackingInfo) {
      if (!isRecord(info) || typeof info.number !== "string" || info.number.trim() === "") {
        continue;
      }
      const shipment: Shipment = { trackingNumber: info.number.trim() };
      if (typeof info.company === "string" && info.company.trim() !== "") {
        shipment.carrier = info.company;
      }
      if (typeof info.url === "string" && isAbsoluteHttpUrl(info.url)) {
        shipment.trackingUrl = info.url;
      }
      return shipment;
    }
  }
  return undefined;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isFinancial(value: string): value is FinancialStatus {
  return (FINANCIAL_STATUSES as readonly string[]).includes(value);
}

function paymentStatus(status: FinancialStatus): PaymentStatus {
  switch (status) {
    case "PENDING":
    case "AUTHORIZED":
      return "pending";
    case "PAID":
    case "PARTIALLY_PAID":
    case "PARTIALLY_REFUNDED":
      return "approved";
    case "REFUNDED":
      return "refunded";
    case "EXPIRED":
    case "VOIDED":
      return "declined";
    default: {
      const unexpected: never = status;
      throw new Error(`Unhandled financial status: ${String(unexpected)}`);
    }
  }
}
