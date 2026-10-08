/**
 * Stripe Financial Connections launcher: `stripe.collectFinancialConnectionsAccounts`
 * opens Stripe's modal with the client secret books-api minted, and returns the
 * session id books-api completes the link with.
 *
 * Financial Connections can run on a different Stripe account than billing, so
 * `VITE_STRIPE_FC_PUBLISHABLE_KEY` takes precedence over the billing
 * `VITE_STRIPE_PUBLISHABLE_KEY`. The key must belong to the Stripe account the
 * books-api secret key belongs to.
 *
 * Stripe.js comes from `@stripe/stripe-js/pure`, which loads the script on
 * first use instead of on import, so the banking pages do not pull it in.
 */
import { BankFeedLaunchError, type Launcher } from './types';

/** The publishable key of the Stripe account that serves Financial Connections, or null. */
export function stripeFcPublishableKey(): string | null {
  const dedicated = import.meta.env.VITE_STRIPE_FC_PUBLISHABLE_KEY as string | undefined;
  const billing = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
  return dedicated?.trim() || billing?.trim() || null;
}

export const launchStripeFc: Launcher = async (session) => {
  if (!session.clientSecret) throw new BankFeedLaunchError('incomplete_session');
  const publishableKey = stripeFcPublishableKey();
  if (!publishableKey) throw new BankFeedLaunchError('stripe_not_configured');

  const { loadStripe } = await import('@stripe/stripe-js/pure');
  let stripe;
  try {
    stripe = await loadStripe(publishableKey);
  } catch {
    throw new BankFeedLaunchError('script_failed');
  }
  if (!stripe) throw new BankFeedLaunchError('script_failed');

  const result = await stripe.collectFinancialConnectionsAccounts({ clientSecret: session.clientSecret });
  if (result.error) throw new BankFeedLaunchError('provider_error', result.error.message ?? null);

  // Closing the modal without linking returns the session with no accounts.
  const { financialConnectionsSession } = result;
  if (!financialConnectionsSession || financialConnectionsSession.accounts.length === 0) {
    return { status: 'cancelled' };
  }
  return { status: 'completed', payload: { sessionId: financialConnectionsSession.id } };
};
