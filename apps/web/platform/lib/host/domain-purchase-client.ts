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
 * Redirect to Stripe Checkout
 */
export function redirectToCheckout(checkoutUrl: string): void {
  window.location.href = checkoutUrl;
}

/**
 * Poll registration status until completion or failure
 * @param registrationId The registration ID to poll
 * @param onStatusUpdate Callback called on each status update
 * @param checkStatus Function that checks registration status via API
 * @param maxAttempts Maximum number of polling attempts (default: 60)
 * @param intervalMs Milliseconds between polls (default: 2000)
 */
async function pollRegistrationStatus(
  registrationId: string,
  onStatusUpdate: (status: DomainPurchaseStatusResponse) => void,
  checkStatus: CheckStatusFn,
  maxAttempts: number = 60,
  intervalMs: number = 2000
): Promise<DomainPurchaseStatusResponse> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await checkStatus(registrationId);
    onStatusUpdate(status);

    // Terminal states
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Registration status polling timed out');
}

/**
 * Poll multiple registration statuses simultaneously
 * @param registrationIds Array of registration IDs to poll
 * @param onStatusUpdate Callback called when any status updates
 * @param checkStatus Function that checks registration status via API
 * @param maxAttempts Maximum number of polling attempts (default: 60)
 * @param intervalMs Milliseconds between polls (default: 3000)
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
    // Poll all registrations that are not yet completed
    const pendingIds = registrationIds.filter(id => !completedIds.has(id));

    if (pendingIds.length === 0) {
      // All registrations are complete
      return statuses;
    }

    // Fetch statuses in parallel
    const statusPromises = pendingIds.map(id => checkStatus(id));
    const currentStatuses = await Promise.all(statusPromises);

    // Update status map
    currentStatuses.forEach((status, index) => {
      const id = pendingIds[index];
      statuses.set(id, status);

      // Mark as completed if in terminal state
      if (status.status === 'completed' || status.status === 'failed') {
        completedIds.add(id);
      }
    });

    // Notify caller of updated statuses
    onStatusUpdate(statuses);

    // If all are complete, return
    if (completedIds.size === registrationIds.length) {
      return statuses;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Registration status polling timed out');
}
