import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { createFormatters, type Formatters } from '@/lib/format'
import { fill, pluralize, type Locale, type PluralForms, type PortalStrings } from '@/lib/i18n'

interface PortalContextValue {
  locale: Locale
  /** The portal's texts in the reader's language. */
  t: PortalStrings
  /** `{name}` placeholders replaced. */
  fill: (template: string, values: Record<string, string | number>) => string
  /** The plural form for a count, `{count}` filled in. */
  plural: (forms: PluralForms, count: number, values?: Record<string, string | number>) => string
  format: Formatters
}

const PortalContext = createContext<PortalContextValue | null>(null)

const subscribe = () => () => {}

/** False while the server renders and during hydration, true afterwards (and on client-side navigation). */
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}

export function PortalProvider({
  locale,
  strings,
  children,
}: Readonly<{ locale: Locale; strings: PortalStrings; children: ReactNode }>) {
  const isClient = useIsClient()
  const value = useMemo<PortalContextValue>(
    () => ({
      locale,
      t: strings,
      fill,
      plural: (forms, count, values) => pluralize(forms, count, locale, values),
      // UTC on the server, the reader's own time zone in the browser.
      format: createFormatters(locale, isClient ? undefined : 'UTC'),
    }),
    [locale, strings, isClient],
  )
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>
}

export function usePortal(): PortalContextValue {
  const value = useContext(PortalContext)
  if (!value) throw new Error('usePortal must be used within a PortalProvider')
  return value
}
