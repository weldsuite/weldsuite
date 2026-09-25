import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { Toaster } from 'sonner';
import { I18nProvider, TimeZoneSync } from '@/lib/i18n';
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  LOCALE_COOKIE,
  TIMEZONE_COOKIE,
  isLocale,
  isTimeZone,
  localeFromAcceptLanguage,
} from '@/lib/i18n/locale';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  // Neutral on purpose: the portal is white-label. Workspace pages override
  // the title and favicon from the workspace's branding in generateMetadata.
  title: 'Portal',
  description: 'Sign in to view your schedule, leave, coaching, and evaluations.',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const initialLocale = isLocale(cookieLocale)
    ? cookieLocale
    : localeFromAcceptLanguage((await headers()).get('accept-language')) ?? DEFAULT_LOCALE;
  const cookieZone = decodeURIComponent(cookieStore.get(TIMEZONE_COOKIE)?.value ?? '');
  const timeZone = isTimeZone(cookieZone) ? cookieZone : DEFAULT_TIMEZONE;

  return (
    <html lang={initialLocale}>
      <body className={inter.className}>
        <Providers>
          <I18nProvider initialLocale={initialLocale} timeZone={timeZone}>
            <TimeZoneSync />
            {children}
            <Toaster position="top-center" richColors />
          </I18nProvider>
        </Providers>
      </body>
    </html>
  );
}
