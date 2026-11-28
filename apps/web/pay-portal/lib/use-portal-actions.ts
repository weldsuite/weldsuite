import { useMemo } from 'react'
import type { PortalActions } from './actions'
import { acceptQuoteFn, startPayment } from './server-fns'

/** The server functions of one link, with its token bound in. */
export function usePortalActions(token: string): PortalActions {
  return useMemo(
    () => ({
      pay: () => startPayment({ data: { token } }),
      accept: (input) => acceptQuoteFn({ data: { token, ...input } }),
      navigate: (url) => window.location.assign(url),
    }),
    [token],
  )
}
