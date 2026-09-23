'use client';

import { createContext, useContext } from 'react';
import type { Me } from '@/lib/types';

const MeContext = createContext<Me | null>(null);

export const MeProvider = MeContext.Provider;

/** The signed-in employee or client, as returned by `GET /me`. Only usable under the authenticated portal layout. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe must be used within the authenticated portal layout');
  return me;
}
