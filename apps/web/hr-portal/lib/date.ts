import type { Locale } from '@/lib/i18n';

const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', nl: 'nl-NL' };

export function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
