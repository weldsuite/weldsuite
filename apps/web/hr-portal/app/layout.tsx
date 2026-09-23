import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { Toaster } from 'sonner';
import { I18nProvider } from '@/lib/i18n/context';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localeFromAcceptLanguage } from '@/lib/i18n/locale';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  // Neutral on purpose: the portal is white-label, and the branded title is set
  // client-side once the workspace config has loaded (lib/hooks/use-branding.ts).
  title: 'Portal',
  description: 'Sign in to view your schedule, leave, coaching, and evaluations.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const initialLocale = isLocale(cookieLocale) ? cookieLocale : localeFromAcceptLanguage((await headers()).get('accept-language')) ?? DEFAULT_LOCALE;

  return (
    <html lang={initialLocale}>
      <body className={inter.className}>
        <I18nProvider initialLocale={initialLocale}>
          {children}
          <Toaster position="top-center" richColors />
        </I18nProvider>
      </body>
    </html>
  );
}
