import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { fill, type Locale, type PortalStrings } from '@/lib/i18n'

interface PortalContextValue {
  locale: Locale
  t: PortalStrings
  /** `{name}` placeholders filled. */
  fill: typeof fill
}

const PortalContext = createContext<PortalContextValue | null>(null)

export function PortalProvider({ locale, strings, children }: Readonly<{ locale: Locale; strings: PortalStrings; children: ReactNode }>) {
  const value = useMemo<PortalContextValue>(() => ({ locale, t: strings, fill }), [locale, strings])
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>
}

export function usePortal(): PortalContextValue {
  const value = useContext(PortalContext)
  if (!value) throw new Error('PortalProvider is missing')
  return value
}
