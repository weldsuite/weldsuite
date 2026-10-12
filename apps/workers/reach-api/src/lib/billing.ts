/**
 * WeldReach billing, through billing-worker (`/api/billing/reach/*`).
 *
 * One Stripe subscription per workspace, $5 per inbox per month, quantity =
 * inboxes. billing-worker owns Stripe; this is only the caller. The caller's
 * Clerk Authorization header is forwarded (`callBillingWorker`), so billing-worker
 * re-verifies the member and resolves the workspace itself. Background code
 * (cron, webhooks) has no caller token and cannot adjust billing.
 *
 * Contract (billing-worker side mounted at /api/billing/reach):
 *   GET  /status   -> { data: ReachBillingSummary }
 *   POST /setup    { successUrl, cancelUrl } -> { data: { url } }
 *   POST /inboxes  { delta: 1 | -1, mailboxId } -> { data: { quantity } }
 *                  402 { error: { code: 'PAYMENT_METHOD_REQUIRED' } } without a payment method
 */

import { callBillingWorker } from '@weldsuite/worker-kit/billing-worker';
import type { ReachBillingSetupInput, ReachBillingSummary } from '@weldsuite/app-api-client/schemas/reach';

export const BILLING_REACH_BASE = '/api/billing/reach';

/** The slice of a Hono context `callBillingWorker` reads. */
export type BillingContext = Parameters<typeof callBillingWorker>[0];

/** No payment method on the workspace: adding an inbox needs one first. */
export class PaymentMethodRequiredError extends Error {
  constructor() {
    super('A payment method is required before adding inboxes');
    this.name = 'PaymentMethodRequiredError';
  }
}

/** billing-worker failed or could not be reached. */
export class ReachBillingError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ReachBillingError';
    this.status = status;
    this.code = code;
  }
}

export interface ReachBilling {
  status(): Promise<ReachBillingSummary>;
  setup(input: ReachBillingSetupInput): Promise<{ url: string }>;
  /** Stripe quantity +1 / -1 for one inbox. Returns the new quantity. */
  adjustInboxes(delta: 1 | -1, mailboxId: string): Promise<{ quantity: number }>;
}

type Call = typeof callBillingWorker;

async function parse(res: Response): Promise<{ data?: unknown; error?: { code?: string; message?: string } } | null> {
  try {
    return (await res.json()) as { data?: unknown; error?: { code?: string; message?: string } };
  } catch {
    return null;
  }
}

export function createReachBilling(c: BillingContext, call: Call = callBillingWorker): ReachBilling {
  async function send<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    let res: Response;
    try {
      res = await call(c, `${BILLING_REACH_BASE}${path}`, init);
    } catch (err) {
      throw new ReachBillingError(502, null, `billing-worker unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await parse(res);
    if (res.status === 402 && body?.error?.code === 'PAYMENT_METHOD_REQUIRED') throw new PaymentMethodRequiredError();
    if (!res.ok) {
      throw new ReachBillingError(
        res.status,
        body?.error?.code ?? null,
        body?.error?.message ?? `billing-worker answered ${res.status}`,
      );
    }
    if (body?.data === undefined) throw new ReachBillingError(502, null, 'billing-worker returned no data');
    return body.data as T;
  }

  return {
    status: () => send<ReachBillingSummary>('/status', { method: 'GET' }),
    setup: (input) => send<{ url: string }>('/setup', { method: 'POST', body: input }),
    adjustInboxes: (delta, mailboxId) => send<{ quantity: number }>('/inboxes', { method: 'POST', body: { delta, mailboxId } }),
  };
}
