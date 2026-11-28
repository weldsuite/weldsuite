import type { EmailTemplateKind } from '@/lib/api/domains/weldbooks-sales';

/** Fills `{placeholders}` in a template with sample values; one it does not know stays as written. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** The placeholders only a reminder can fill in (the statutory costs of a final notice). */
const REMINDER_ONLY: ReadonlySet<string> = new Set(['collectionCosts', 'interest', 'totalClaim', 'noticeDays']);

export function isReminderKind(kind: string): boolean {
  return kind === 'reminder1' || kind === 'reminder2' || kind === 'reminder3';
}

/** The placeholders a template of this kind can use: the statutory ones only make sense in a reminder. */
export function placeholdersFor(kind: EmailTemplateKind | string, all: readonly string[]): string[] {
  return isReminderKind(kind) ? [...all] : all.filter((key) => !REMINDER_ONLY.has(key));
}

/** The placeholders that appear in a text, in order, without repeats. */
export function placeholdersIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{(\w+)\}/g)) seen.add(match[1]);
  return [...seen];
}

/** The ones a text uses that the server does not offer: they would be sent as written. */
export function unknownPlaceholders(text: string, known: readonly string[]): string[] {
  return placeholdersIn(text).filter((key) => !known.includes(key));
}
