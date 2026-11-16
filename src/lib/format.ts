const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const inrPrecise = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intFmt = new Intl.NumberFormat("en-IN");

export const NO_DATA = "no data";

export function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatINR(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return NO_DATA;
  return inr.format(n);
}

export function formatINRPrecise(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return NO_DATA;
  return inrPrecise.format(n);
}

export function formatInt(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return NO_DATA;
  return intFmt.format(n);
}

/** One decimal place, for counts-per-thousand style measures. */
export function formatDecimal(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return NO_DATA;
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(n);
}

/** A ratio, printed as "1.08x" — never as a percentage, never bare. */
export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NO_DATA;
  return `${value.toFixed(2)}\u00d7`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NO_DATA;
  return `${value.toFixed(1)}%`;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
