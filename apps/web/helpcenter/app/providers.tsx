'use client'

import { ThemeProvider } from 'next-themes'
import { LazyI18nProvider } from '@weldsuite/i18n/lazy-provider'
import type { Language } from '@weldsuite/i18n/locales'

interface ProvidersProps {
  children: React.ReactNode
  initialLanguage: Language
}

export function Providers({ children, initialLanguage }: ProvidersProps) {
  return (
    <ThemeProvider attribute="class" disableTransitionOnChange>
      <LazyI18nProvider initialLanguage={initialLanguage}>
        {children}
      </LazyI18nProvider>
    </ThemeProvider>
  )
}
