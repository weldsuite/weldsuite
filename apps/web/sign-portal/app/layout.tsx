import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { getServerI18n } from '@/lib/server-i18n';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  // Signing links must never end up in a search index.
  return { title: t.metaTitle, description: t.metaDescription, robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale } = await getServerI18n();
  return (
    <html lang={locale}>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
