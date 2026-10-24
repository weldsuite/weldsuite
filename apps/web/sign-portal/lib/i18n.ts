/**
 * Signer-facing copy, en + nl. The sender picks the signer's language when
 * signing goes live (phase 2); until then the browser's Accept-Language decides.
 */

export type Locale = 'en' | 'nl';
export const DEFAULT_LOCALE: Locale = 'en';

const en = {
  metaTitle: 'Sign a document',
  metaDescription: 'Review and sign the document that was sent to you.',
  home: {
    title: 'Sign a document',
    body: 'Open the link in the email you received to review and sign the document.',
  },
  link: {
    title: 'This document is not ready yet',
    body: 'Signing through this page is not available yet. Contact the person who sent you the link.',
  },
  poweredBy: 'Electronic signatures by WeldSign',
};

export type Dictionary = typeof en;

const nl: Dictionary = {
  metaTitle: 'Document ondertekenen',
  metaDescription: 'Bekijk en onderteken het document dat naar je is gestuurd.',
  home: {
    title: 'Document ondertekenen',
    body: 'Open de link in de e-mail die je hebt ontvangen om het document te bekijken en te ondertekenen.',
  },
  link: {
    title: 'Dit document is nog niet klaar',
    body: 'Ondertekenen via deze pagina is nog niet mogelijk. Neem contact op met degene die je de link heeft gestuurd.',
  },
  poweredBy: 'Elektronische handtekeningen via WeldSign',
};

export const dictionaries: Record<Locale, Dictionary> = { en, nl };

/** First supported locale in an `Accept-Language` header, else the default. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(',')) {
    const lang = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
    if (lang === 'en' || lang === 'nl') return lang;
  }
  return DEFAULT_LOCALE;
}
