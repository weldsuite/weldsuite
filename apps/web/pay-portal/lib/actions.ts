import type { AcceptInput, AcceptResult, Result } from './contract'

/**
 * What the page can ask the server to do for one link. The route binds the
 * token into the server functions; tests hand in fakes. `navigate` leaves for
 * Mollie's checkout.
 */
export interface PortalActions {
  pay: () => Promise<Result<{ checkoutUrl: string }>>
  accept: (input: AcceptInput) => Promise<Result<AcceptResult>>
  navigate: (url: string) => void
}
