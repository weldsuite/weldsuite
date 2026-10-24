import { headers } from 'next/headers';
import { dictionaries, localeFromAcceptLanguage, type Dictionary, type Locale } from './i18n';

/** Locale and copy for the current request (server components only). */
export async function getServerI18n(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = localeFromAcceptLanguage((await headers()).get('accept-language'));
  return { locale, t: dictionaries[locale] };
}
