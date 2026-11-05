import { localeConfig, type Language } from '@weldsuite/i18n/locales';

/** Fill `{name}` placeholders of a translated string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** The `Intl` locale of the user's language ("nl" is "nl-NL"). */
export function intlLocaleOf(language: Language): string {
  return localeConfig[language]?.intlLocale ?? 'en-US';
}

/** A `YYYY-MM-DD` date (or ISO timestamp) as "2 Nov", with the year when it is not this year. */
export function shortDate(value: string, locale: string, now: Date = new Date()): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(date);
}

/** A task as the schedule shows it: its number, else its title. */
export function taskLabel(task: { number: number | null; title: string }): string {
  return task.number === null ? task.title : String(task.number);
}
