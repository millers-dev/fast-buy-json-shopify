import { CURRENTLY_NOT_IN_STOCK_ON_2026_10 } from "./catalog-contract.js";
import { plainTextFromHtml } from "./html-text.js";
import { isRecord } from "./json.js";
import { moneyAmount } from "./money.js";

export type CatalogMoney = {
  amount: number;
  currency: string;
};

export type CatalogImage = {
  url: string;
  alt?: string;
};

export type CatalogVariant = {
  id: string;
  attributes: Record<string, string>;
  price?: CatalogMoney;
};

export type CatalogAvailability = {
  status: "in_stock" | "out_of_stock" | "backorder";
  quantity?: number;
};

export type CatalogProduct = {
  id: string;
  name: string;
  price: CatalogMoney;
  brand?: string;
  description?: string;
  availability?: CatalogAvailability;
  categories?: string[];
  images?: CatalogImage[];
  variants?: CatalogVariant[];
};

type ParsedVariant = {
  id: string;
  attributes: Record<string, string>;
  availableForSale: boolean;
  currentlyNotInStock: boolean | null;
  quantity?: number;
  price?: CatalogMoney;
};

export function mapCatalogProduct(value: unknown): CatalogProduct | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || value.id === "" || typeof value.title !== "string" || value.title === "") {
    return null;
  }
  if (typeof value.availableForSale !== "boolean") {
    return null;
  }
  const price = readMoney(isRecord(value.priceRange) ? value.priceRange.minVariantPrice : undefined);
  if (price === null) {
    return null;
  }
  const variants = readVariants(value.variants);
  const product: CatalogProduct = {
    id: value.id,
    name: value.title,
    price,
    availability: readAvailability(value.availableForSale, variants?.variants, variants?.incomplete === true),
  };
  if (typeof value.vendor === "string" && value.vendor !== "") {
    product.brand = value.vendor;
  }
  if (typeof value.descriptionHtml === "string") {
    const description = plainTextFromHtml(value.descriptionHtml);
    if (description !== "") {
      product.description = description;
    }
  }
  const categories = readCategories(value);
  if (categories !== undefined) {
    product.categories = categories;
  }
  const images = readImages(value.images);
  if (images !== undefined) {
    product.images = images;
  }
  if (variants?.variants !== undefined) {
    product.variants = variants.variants.map(toPublicVariant);
  }
  return product;
}

function readAvailability(
  availableForSale: boolean,
  variants: ParsedVariant[] | undefined,
  variantsIncomplete: boolean,
): CatalogAvailability {
  const availability: CatalogAvailability = {
    status: productStatus(availableForSale, variants, variantsIncomplete),
  };
  const quantity = productQuantity(variants, variantsIncomplete);
  if (quantity !== undefined) {
    availability.quantity = quantity;
  }
  return availability;
}

function productStatus(
  availableForSale: boolean,
  variants: ParsedVariant[] | undefined,
  variantsIncomplete: boolean,
): CatalogAvailability["status"] {
  if (!availableForSale) {
    return "out_of_stock";
  }
  if (variantsIncomplete) {
    return "in_stock";
  }
  const sellable = (variants ?? []).filter((variant) => variant.availableForSale);
  if (
    CURRENTLY_NOT_IN_STOCK_ON_2026_10.presentOnProductVariant &&
    CURRENTLY_NOT_IN_STOCK_ON_2026_10.backorderMapped &&
    sellable.length > 0 &&
    sellable.every((variant) => variant.currentlyNotInStock === true)
  ) {
    return "backorder";
  }
  return "in_stock";
}

function productQuantity(variants: ParsedVariant[] | undefined, variantsIncomplete: boolean): number | undefined {
  if (variantsIncomplete || variants === undefined || variants.length === 0) {
    return undefined;
  }
  let sum = 0;
  for (const variant of variants) {
    if (variant.quantity === undefined) {
      return undefined;
    }
    sum += variant.quantity;
  }
  return sum;
}

function readVariants(value: unknown): { variants: ParsedVariant[] | undefined; incomplete: boolean } | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return undefined;
  }
  const incomplete = isRecord(value.pageInfo) && value.pageInfo.hasNextPage === true;
  const variants: ParsedVariant[] = [];
  for (const node of value.nodes) {
    const variant = readVariant(node);
    if (variant !== null) {
      variants.push(variant);
    }
  }
  return { variants: variants.length > 0 ? variants : undefined, incomplete };
}

function readVariant(value: unknown): ParsedVariant | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  if (typeof value.availableForSale !== "boolean") {
    return null;
  }
  const variant: ParsedVariant = {
    id: value.id,
    attributes: readAttributes(value.selectedOptions),
    availableForSale: value.availableForSale,
    currentlyNotInStock: typeof value.currentlyNotInStock === "boolean" ? value.currentlyNotInStock : null,
  };
  if (typeof value.quantityAvailable === "number" && Number.isInteger(value.quantityAvailable)) {
    variant.quantity = value.quantityAvailable;
  }
  const price = readMoney(value.price);
  if (price !== null) {
    variant.price = price;
  }
  return variant;
}

function toPublicVariant(variant: ParsedVariant): CatalogVariant {
  const publicVariant: CatalogVariant = {
    id: variant.id,
    attributes: variant.attributes,
  };
  if (variant.price !== undefined) {
    publicVariant.price = variant.price;
  }
  return publicVariant;
}

function readAttributes(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  const attributes: Record<string, string> = {};
  for (const option of value) {
    if (!isRecord(option) || typeof option.name !== "string" || option.name === "") {
      continue;
    }
    if (typeof option.value !== "string") {
      continue;
    }
    attributes[option.name] = option.value;
  }
  return attributes;
}

function readCategories(product: Record<string, unknown>): string[] | undefined {
  const categories: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    categories.push(trimmed);
  };
  if (typeof product.productType === "string") {
    add(product.productType);
  }
  if (Array.isArray(product.tags)) {
    for (const tag of product.tags) {
      if (typeof tag === "string") {
        add(tag);
      }
    }
  }
  if (isRecord(product.collections) && Array.isArray(product.collections.nodes)) {
    for (const node of product.collections.nodes) {
      if (isRecord(node) && typeof node.title === "string") {
        add(node.title);
      }
    }
  }
  return categories.length > 0 ? categories : undefined;
}

function readImages(value: unknown): CatalogImage[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return undefined;
  }
  const images: CatalogImage[] = [];
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.url !== "string" || node.url === "") {
      continue;
    }
    const image: CatalogImage = { url: node.url };
    if (typeof node.altText === "string" && node.altText !== "") {
      image.alt = node.altText;
    }
    images.push(image);
  }
  return images.length > 0 ? images : undefined;
}

function readMoney(value: unknown): CatalogMoney | null {
  if (!isRecord(value) || typeof value.amount !== "string" || typeof value.currencyCode !== "string") {
    return null;
  }
  const amount = moneyAmount(value.amount, value.currencyCode);
  if (amount === null || value.currencyCode.trim() === "") {
    return null;
  }
  return { amount, currency: value.currencyCode.trim().toUpperCase() };
}
