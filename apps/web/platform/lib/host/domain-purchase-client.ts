// Domain purchase client utilities (browser-only)

export interface DomainPurchaseStatusResponse {
  status: 'pending' | 'payment_complete' | 'registering' | 'completed' | 'failed';
  domainName?: string;
  domainId?: string;
  totalPrice?: number;
  error?: string;
}

type CheckStatusFn = (registrationId: string) => Promise<DomainPurchaseStatusResponse>;

/**
 * Map a registration-status payload (or a raw host_domains.status /
 * registrationStatus value from an older worker) onto the success-page union.
 */
export function normalizePurchaseStatus(
  raw: string | null | undefined,
): DomainPurchaseStatusResponse['status'] {
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
    case 'pending_payment':
    case 'pending':
    default:
      return 'pending';
  }
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
 * Stops when every id is completed or failed. If the attempt budget runs
 * out, returns the last known statuses instead of throwing so the success
 * page can still show in-progress domains (async TLD workflows).
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

    const statusPromises = pendingIds.map(id => checkStatus(id));
    const currentStatuses = await Promise.all(statusPromises);

    currentStatuses.forEach((status, index) => {
      const id = pendingIds[index];
      const normalized: DomainPurchaseStatusResponse = {
        ...status,
        status: normalizePurchaseStatus(status.status),
      };
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

  return statuses;
}
