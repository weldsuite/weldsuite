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
 *
 * Billing is off where the caller's token cannot be forwarded to billing-worker
 * (`canForwardAuthorization(billingWorkerUrl(env))`: local wrangler, plain
 * HTTP), the signal WeldBooks' bank connections use, and on the Kubernetes
 * editions, which have no billing-worker at all (the `billing` feature). Then
 * mailboxes are provisioned unbilled: `status()` is null, `adjustInboxes` is
 * a no-op answering null, and `setup` refuses (409 `BILLING_OFF`), as there is
 * no payment method to add.
 */

import { billingWorkerUrl, callBillingWorker, canForwardAuthorization } from '@weldsuite/worker-kit/billing-worker';
import { ReachDomainError } from '@weldsuite/reach-domain/errors';
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
  /** Null when billing is off in this environment. */
  status(): Promise<ReachBillingSummary | null>;
  /** Refuses with 409 `BILLING_OFF` when billing is off. */
  setup(input: ReachBillingSetupInput): Promise<{ url: string }>;
  /** Stripe quantity +1 / -1 for one inbox. Returns the new quantity; null (nothing billed) when billing is off. */
  adjustInboxes(delta: 1 | -1, mailboxId: string): Promise<{ quantity: number } | null>;
}

/** Whether billing is on for this worker env (the caller's token can reach billing-worker). */
export function reachBillingEnabled(env: BillingContext['env']): boolean {
  return canForwardAuthorization(billingWorkerUrl(env));
}

/** `POST /billing/setup` where billing is off. */
export function billingOffError(): ReachDomainError {
  return new ReachDomainError(
    'BILLING_OFF',
    409,
    'Billing is off in this environment: mailboxes are not charged, so there is no payment method to add.',
  );
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
  if (!reachBillingEnabled(c.env)) {
    return {
      status: async () => null,
      setup: async () => {
        throw billingOffError();
      },
      adjustInboxes: async () => null,
    };
  }

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
