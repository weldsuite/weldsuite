import { type Metadata } from 'next'
import { Inter } from 'next/font/google'
import { cookies, headers } from 'next/headers'
import clsx from 'clsx'
import { createHeaderAdapter } from '@weldsuite/i18n/adapters/header'
import { defaultLanguage, type Language } from '@weldsuite/i18n/locales'

import { Providers } from '@/app/providers'

import '@/styles/tailwind.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: {
    template: '%s - Help Center',
    default: 'Help Center',
  },
  description: 'Find answers to your questions',
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Resolve locale at request time: cookie wins, then Accept-Language.
  // The adapter encapsulates the parse logic so the same code works
  // on Workers / Edge runtimes too.
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  const adapter = createHeaderAdapter({
    cookie: cookieStore.toString(),
    acceptLanguage: headerStore.get('accept-language'),
  })
  const initialLanguage: Language = adapter.read?.() ?? defaultLanguage

  return (
    <html
      lang={initialLanguage}
      className={clsx('h-full antialiased', inter.variable)}
      suppressHydrationWarning
    >
      <body className="flex min-h-full bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
        <Providers initialLanguage={initialLanguage}>{children}</Providers>
      </body>
    </html>
  )
}
