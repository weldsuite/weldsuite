/**
 * Credits service: wallet reads and the prepaid topup checkout proxy.
 *
 * The balance is a PREPAID WALLET (see @weldsuite/credits), held in the
 * master database and scoped by the internal `workspaceId`. app-api never
 * writes it: plan allocations and topup grants are owned by billing-worker
 * (Stripe webhooks, admin routes).
 */

import { getOrCreateWorkspaceCredits } from '@weldsuite/credits';
import type { CreditTopupCheckoutInput } from '@weldsuite/app-api-client/schemas/credits';
import type { Env } from '../types';
import { fetchBillingWorker } from '@weldsuite/worker-kit/billing-worker';

export { getOrCreateWorkspaceCredits };

// ============================================================================
// Billing-worker proxy (prepaid credit topup Checkout)
// ============================================================================

export type CreditCheckoutProxyFailure =
  | { kind: 'bad_request'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'upstream'; message: string };

export type CreditCheckoutProxyResult =
  | { ok: true; url: string }
  | { ok: false; error: CreditCheckoutProxyFailure };

function checkoutHttpFailure(
  status: number,
  payload: Record<string, unknown> | null,
): CreditCheckoutProxyResult {
  const message =
    (payload && typeof payload.error === 'string' && payload.error) ||
    'Failed to start credit checkout';
  if (status === 400) return { ok: false, error: { kind: 'bad_request', message } };
  if (status === 404) return { ok: false, error: { kind: 'not_found', message } };
  return { ok: false, error: { kind: 'upstream', message } };
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError')
  );
}

function checkoutErrorMessage(err: unknown): string {
  if (isAbortError(err)) return 'Billing worker timed out';
  return err instanceof Error ? err.message : 'Failed to start credit checkout';
}

/**
 * Create a Stripe Checkout session for a prepaid credit package via
 * billing-worker. Credits are granted by the webhook after payment — this
 * only returns the hosted Checkout URL.
 */
export async function createCreditTopupCheckout(params: {
  env: Pick<Env, 'ENVIRONMENT'>;
  authorization?: string | null;
  body: CreditTopupCheckoutInput;
  fetchImpl?: typeof fetch;
}): Promise<CreditCheckoutProxyResult> {
  try {
    const resp = await fetchBillingWorker(params.env, '/api/billing/credits/checkout', {
      method: 'POST',
      authorization: params.authorization,
      body: params.body,
      fetchImpl: params.fetchImpl,
    });
    const payload = (await resp.json().catch(() => null)) as Record<string, unknown> | null;

    if (!resp.ok) return checkoutHttpFailure(resp.status, payload);

    const url = payload && typeof payload.url === 'string' ? payload.url : null;
    if (!url) {
      return {
        ok: false,
        error: { kind: 'upstream', message: 'Billing worker returned no checkout URL' },
      };
    }

    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: { kind: 'upstream', message: checkoutErrorMessage(err) } };
  }
}

