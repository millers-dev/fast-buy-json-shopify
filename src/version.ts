import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "fast-buy-json-shopify";

export type PackageMetadata = {
  name: string;
  version: string;
  root: string;
};

export function readPackageMetadata(fromUrl: string = import.meta.url): PackageMetadata {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isPackageMetadata(parsed) && parsed.name === PACKAGE_NAME) {
        return { name: parsed.name, version: parsed.version, root: dir };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`${PACKAGE_NAME} package.json not found`);
}

function isPackageMetadata(value: unknown): value is { name: string; version: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { name?: unknown; version?: unknown };
  return typeof record.name === "string" && typeof record.version === "string";
}
