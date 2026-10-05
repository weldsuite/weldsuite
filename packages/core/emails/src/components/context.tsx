import { createContext, useContext } from 'react';
import type { EmailBrand } from '../brand';
import type { EmailLocale, EmailStrings } from '../i18n';

export interface EmailContextValue {
  brand: EmailBrand;
  /** Hex accent of the brand (buttons, panel borders, header bar). */
  accent: string;
  locale: EmailLocale;
  t: EmailStrings;
}

const EmailContext = createContext<EmailContextValue | null>(null);

export const EmailContextProvider = EmailContext.Provider;

/** Brand, accent, locale and strings of the email being rendered. */
export function useEmail(): EmailContextValue {
  const value = useContext(EmailContext);
  if (!value) throw new Error('useEmail() must be used inside <EmailLayout>');
  return value;
}
