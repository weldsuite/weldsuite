import { getTranslations } from '@/lib/i18n';

export type CallTranslationStrings = ReturnType<typeof getTranslations<'deskCallTranslation'>>;

/** The picker's name for a language code, in the agent's UI language; the code itself when unknown. */
export function languageName(t: CallTranslationStrings, code: string | null | undefined): string {
  if (!code) return '';
  const primary = code.split('-')[0]!.toLowerCase();
  return (t.languages as Record<string, string>)[primary] ?? code;
}
