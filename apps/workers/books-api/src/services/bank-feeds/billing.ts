/**
 * Bank connections in the subscription, through billing-worker
 * (`/api/billing/bank-connections`). The plan includes some connections
 * (default 1); each one above that is billed monthly. billing-worker counts
 * the connections itself (the master `bank_feed_connection_index`), owns
 * Stripe, and only lets a workspace admin raise the charge; this is the caller.
 *
 * The caller's Clerk Authorization header is forwarded (`callBillingWorker`).
 * Where billing-worker cannot authenticate the caller (local wrangler, plain
 * HTTP) or has no Stripe key, billing is off: connections are not limited.
 *
 * Contract (billing-worker side):
 *   GET  /status -> { data: BankConnectionBillingSummary }
 *   POST /sync   -> { data: { connections, included, quantity } }
 *                   402 PAYMENT_METHOD_REQUIRED | PAYMENT_FAILED, 403 BILLING_ADMIN_REQUIRED
 */

import { billingWorkerUrl, callBillingWorker, canForwardAuthorization } from '@weldsuite/worker-kit/billing-worker';
import {
  BANK_CONNECTION_BILLING_ADMIN_REQUIRED,
  BANK_CONNECTION_LIMIT_REACHED,
  BANK_CONNECTION_PAYMENT_METHOD_REQUIRED,
  type BankConnectionBillingSummary,
} from '@weldsuite/app-api-client/schemas/bank-connection-billing';

export const BILLING_BANK_CONNECTIONS_BASE = '/api/billing/bank-connections';

/** The slice of a Hono context `callBillingWorker` reads. */
export type BillingContext = Parameters<typeof callBillingWorker>[0];

/** A connect that billing refuses, or billing-worker failing; `status` is the HTTP status to answer with. */
export class BankConnectionBillingError extends Error {
  constructor(
    readonly status: 402 | 403 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BankConnectionBillingError';
  }
}

export interface BankConnectionBilling {
  /** Null when billing is off in this environment. */
  status(): Promise<BankConnectionBillingSummary | null>;
  /** Align the Stripe quantity with the workspace's connections. No-op when billing is off. */
  sync(): Promise<void>;
}

type Call = typeof callBillingWorker;

interface Body {
  data?: unknown;
  error?: { code?: string; message?: string };
}

async function parse(res: Response): Promise<Body | null> {
  try {
    return (await res.json()) as Body;
  } catch {
    return null;
  }
}

function errorStatus(status: number): BankConnectionBillingError['status'] {
  if (status === 402 || status === 403 || status === 409 || status === 503) return status;
  return 502;
}

export function createBankConnectionBilling(c: BillingContext, call: Call = callBillingWorker): BankConnectionBilling {
  const enabled = canForwardAuthorization(billingWorkerUrl(c.env));

  async function send<T>(path: string, method: 'GET' | 'POST'): Promise<T | null> {
    if (!enabled) return null;
    let res: Response;
    try {
      res = await call(c, `${BILLING_BANK_CONNECTIONS_BASE}${path}`, { method, body: method === 'POST' ? {} : undefined });
    } catch (err) {
      throw new BankConnectionBillingError(502, 'BILLING_UNAVAILABLE', `billing-worker unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await parse(res);
    if (res.status === 503 && body?.error?.code === 'BILLING_NOT_CONFIGURED') return null;
    if (!res.ok) {
      throw new BankConnectionBillingError(
        errorStatus(res.status),
        body?.error?.code ?? 'BILLING_UNAVAILABLE',
        body?.error?.message ?? `billing-worker answered ${res.status}`,
      );
    }
    if (body?.data === undefined) throw new BankConnectionBillingError(502, 'BILLING_UNAVAILABLE', 'billing-worker returned no data');
    return body.data as T;
  }

  return {
    status: () => send<BankConnectionBillingSummary>('/status', 'GET'),
    sync: async () => {
      await send<unknown>('/sync', 'POST');
    },
  };
}

/**
 * Whether one more connection may be linked. Within what the plan includes,
 * always. Above it the user has to have agreed to the extra charge (`accepted`,
 * when `requireAcceptance`), be a workspace admin, and have a payment method.
 * Returns whether the new connection is billed on top of the plan.
 */
export async function checkNewConnection(
  billing: BankConnectionBilling,
  options: { accepted: boolean; requireAcceptance: boolean },
): Promise<{ billed: boolean }> {
  const summary = await billing.status();
  if (!summary || summary.connections < summary.included) return { billed: false };

  if (options.requireAcceptance && !options.accepted) {
    throw new BankConnectionBillingError(
      402,
      BANK_CONNECTION_LIMIT_REACHED,
      `The plan includes ${summary.included} bank connection(s); another one is billed on top of it.`,
    );
  }
  if (!summary.canAddPaid) {
    throw new BankConnectionBillingError(
      403,
      BANK_CONNECTION_BILLING_ADMIN_REQUIRED,
      'Only workspace admins can add a bank connection that is billed on top of the plan.',
    );
  }
  if (!summary.hasPaymentMethod) {
    throw new BankConnectionBillingError(
      402,
      BANK_CONNECTION_PAYMENT_METHOD_REQUIRED,
      'Add a payment method before adding a bank connection that is billed on top of the plan.',
    );
  }
  return { billed: true };
}
