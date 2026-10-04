const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export function minorUnitScale(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) {
    return 0;
  }
  if (THREE_DECIMAL.has(code)) {
    return 3;
  }
  if (code === "CLF" || code === "UYW") {
    return 4;
  }
  return 2;
}

/** Parse a Shopify decimal string into a JSON number at the currency's minor-unit scale. */
export function moneyAmount(amount: string, currency: string): number | null {
  const match = DECIMAL.exec(amount.trim());
  if (match === null) {
    return null;
  }
  const scale = minorUnitScale(currency);
  const negative = match[1] === "-";
  const whole = parseDigits(match[2] ?? "0");
  const fraction = match[3] ?? "";
  let minor = whole * 10n ** BigInt(scale);
  if (scale === 0) {
    if (fraction[0] !== undefined && fraction[0] >= "5") {
      minor += 1n;
    }
  } else {
    const padded = `${fraction}${"0".repeat(scale + 1)}`.slice(0, scale + 1);
    minor += parseDigits(padded.slice(0, scale));
    const round = padded[scale] ?? "0";
    if (round >= "5") {
      minor += 1n;
    }
  }
  if (negative) {
    minor = -minor;
  }
  return minorToNumber(minor, scale);
}

function parseDigits(digits: string): bigint {
  const trimmed = digits.replace(/^0+/, "");
  return BigInt(trimmed === "" ? "0" : trimmed);
}

function minorToNumber(minor: bigint, scale: number): number {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const digits = absolute.toString().padStart(scale + 1, "0");
  const text =
    scale === 0 ? digits : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return Number(negative ? `-${text}` : text);
}
