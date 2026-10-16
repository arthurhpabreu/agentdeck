import { resolveEffectiveLocale, type LocaleSetting } from "./locale";

function getLocale(locale?: LocaleSetting | string | null) {
  if (!locale) return resolveEffectiveLocale("system");
  if (locale === "system") return resolveEffectiveLocale(locale);
  return resolveEffectiveLocale(locale as LocaleSetting);
}

export function formatDate(value: Date | number | string, locale?: LocaleSetting | string | null) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(getLocale(locale)).format(date);
}

export function formatTime(value: Date | number | string, locale?: LocaleSetting | string | null) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(getLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "3 hours ago" in the largest whole unit; `narrow` suits dense lists ("3h ago"). */
export function formatRelativeTime(at: number, locale?: LocaleSetting | string | null, style: Intl.RelativeTimeFormatStyle = "long") {
  const seconds = Math.round((at - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const format = new Intl.RelativeTimeFormat(getLocale(locale), { numeric: "auto", style });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "minute");
}

export function formatPercent(value: number, locale?: LocaleSetting | string | null, digits = 0) {
  return new Intl.NumberFormat(getLocale(locale), {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
