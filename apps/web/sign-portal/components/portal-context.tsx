'use client';

import { createContext, useContext } from 'react';
import { dictionaries, type Dictionary, type Locale } from '@/lib/i18n';

interface PortalContextValue {
  locale: Locale;
  t: Dictionary;
  /** Validated hex brand colour, or null for the default theme. */
  brandColor: string | null;
  /** Text colour that is readable on `brandColor`. */
  brandForeground: string | null;
}

const PortalContext = createContext<PortalContextValue>({
  locale: 'en',
  t: dictionaries.en,
  brandColor: null,
  brandForeground: null,
});

export const PortalProvider = PortalContext.Provider;

export function usePortal(): PortalContextValue {
  return useContext(PortalContext);
}
