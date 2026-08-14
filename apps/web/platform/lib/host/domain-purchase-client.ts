// Domain purchase client utilities (browser-only)

/** Status values the success page and poller emit after normalization. */
export type NormalizedPurchaseStatus =
  | 'pending'
  | 'payment_complete'
  | 'registering'
  | 'completed'
  | 'failed'
  | 'timeout';

/**
 * Wire values a status endpoint (current or legacy) may return. Includes
 * raw `host_domains.status` / `registrationStatus` strings from older workers.
 */
export type RawPurchaseStatus =
  | NormalizedPurchaseStatus
  | 'active'
  | 'registered'
  | 'pending_payment'
  | 'pending_registration'
  | 'pending_workflow'
  | 'registration_failed'
  | 'cancelled';

export interface DomainPurchaseStatusResponse {
  status: NormalizedPurchaseStatus;
  domainName?: string;
  domainId?: string;
  totalPrice?: number;
  error?: string;
}

export interface RawDomainPurchaseStatus {
  status: RawPurchaseStatus;
  domainName?: string;
  domainId?: string;
  totalPrice?: number;
  error?: string;
}

export type CheckStatusFn = (registrationId: string) => Promise<RawDomainPurchaseStatus>;

/**
 * Map a registration-status payload (or a raw host_domains.status /
 * registrationStatus value from an older worker) onto the success-page union.
 */
export function normalizePurchaseStatus(
  raw: string | null | undefined,
): NormalizedPurchaseStatus {
  switch (raw) {
    case 'completed':
    case 'registered':
    case 'active':
      return 'completed';
    case 'failed':
    case 'registration_failed':
    case 'cancelled':
      return 'failed';
    case 'pending_registration':
    case 'pending_workflow':
    case 'registering':
    case 'payment_complete':
      return 'registering';
    case 'timeout':
      return 'timeout';
    case 'pending_payment':
    case 'pending':
    default:
      return 'pending';
  }
}

function toNormalizedStatus(raw: RawDomainPurchaseStatus): DomainPurchaseStatusResponse {
  return {
    status: normalizePurchaseStatus(raw.status),
    domainName: raw.domainName,
    domainId: raw.domainId,
    totalPrice: raw.totalPrice,
    error: raw.error,
  };
}

function rejectionStatus(
  previous: DomainPurchaseStatusResponse | undefined,
  reason: unknown,
): DomainPurchaseStatusResponse {
  return {
    status: 'failed',
    domainName: previous?.domainName,
    domainId: previous?.domainId,
    totalPrice: previous?.totalPrice,
    error: reason instanceof Error ? reason.message : String(reason),
  };
}

/**
 * Redirect to Stripe Checkout
 */
export function redirectToCheckout(checkoutUrl: string): void {
  window.location.href = checkoutUrl;
}

/**
 * Map checkout API failures to a toast. Billing-setup / missing Stripe
 * customer is handled silently on the backend — never surface that
 * message in the UI even if an older worker still returns it.
 */
export function checkoutErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (/stripe customer|billing setup first/i.test(message)) return fallback;
  return message || fallback;
}

/**
 * Poll multiple registration statuses simultaneously.
 * Stops when every id is completed or failed. A single `checkStatus`
 * rejection is recorded as failed and does not abort the others. If the
 * attempt budget runs out, unresolved ids are marked `timeout` so the
 * success page can show a timeout message instead of indefinite processing.
 */
export async function pollMultipleRegistrationStatuses(
  registrationIds: string[],
  onStatusUpdate: (statuses: Map<string, DomainPurchaseStatusResponse>) => void,
  checkStatus: CheckStatusFn,
  maxAttempts: number = 60,
  intervalMs: number = 3000
): Promise<Map<string, DomainPurchaseStatusResponse>> {
  const statuses = new Map<string, DomainPurchaseStatusResponse>();
  const completedIds = new Set<string>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pendingIds = registrationIds.filter(id => !completedIds.has(id));

    if (pendingIds.length === 0) {
      return statuses;
    }

    const settled = await Promise.allSettled(pendingIds.map((id) => checkStatus(id)));

    settled.forEach((result, index) => {
      const id = pendingIds[index]!;
      const normalized =
        result.status === 'fulfilled'
          ? toNormalizedStatus(result.value)
          : rejectionStatus(statuses.get(id), result.reason);
      statuses.set(id, normalized);

      if (normalized.status === 'completed' || normalized.status === 'failed') {
        completedIds.add(id);
      }
    });

    onStatusUpdate(statuses);

    if (completedIds.size === registrationIds.length) {
      return statuses;
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  for (const id of registrationIds) {
    const current = statuses.get(id);
    if (
      current &&
      (current.status === 'completed' || current.status === 'failed' || current.status === 'timeout')
    ) {
      continue;
    }
    statuses.set(id, {
      status: 'timeout',
      domainName: current?.domainName,
      domainId: current?.domainId,
      totalPrice: current?.totalPrice,
      error: current?.error ?? 'Registration status polling timed out',
    });
  }
  onStatusUpdate(statuses);

  return statuses;
}
