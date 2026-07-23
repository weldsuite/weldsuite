/**
 * Billing Worker Client
 *
 * Client for calling the Billing Worker (Cloudflare Worker) from Next.js server actions.
 * Handles ONLY phone billing operations and internal pricing sync.
 *
 * All other billing operations (subscription reads, plan writes, checkout, portal,
 * seats, cancel, reactivate) are handled by the api-worker via
 * apps/web/platform/lib/api/domains/billing.ts.
 */

import { getAccessToken } from '@/lib/auth';
import { createM2MToken } from '@/lib/api/m2m';

const BILLING_WORKER_URL = import.meta.env.VITE_BILLING_WORKER_URL || 'http://localhost:8788';
const API_PREFIX = '/api/billing';

class BillingWorkerClient {
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async post<T>(path: string, data?: any): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${BILLING_WORKER_URL}${API_PREFIX}${path}`, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || error.message || `Request failed with status ${response.status}`);
    }

    return response.json();
  }

  private async get<T>(path: string): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${BILLING_WORKER_URL}${API_PREFIX}${path}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || error.message || `Request failed with status ${response.status}`);
    }

    return response.json();
  }

  private async internalPost<T>(path: string, data?: any): Promise<T> {
    const m2mToken = await createM2MToken();
    const response = await fetch(`${BILLING_WORKER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${m2mToken}`,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || error.message || `Request failed with status ${response.status}`);
    }

    return response.json();
  }

  // ==========================================
  // Phone Number Billing (Stripe writes)
  // ==========================================

  async getPhoneSubscription(): Promise<PhoneSubscriptionResponse> {
    return this.get<PhoneSubscriptionResponse>('/phone/subscription');
  }

  async addPhoneNumber(params: {
    stripePriceId: string;
    countryCode: string;
    numberType: string;
    phoneNumber: string;
    friendlyName?: string;
    displayName?: string;
    addressId?: string;
  }): Promise<PhoneAddNumberResponse> {
    return this.post<PhoneAddNumberResponse>('/phone/add-number', params);
  }

  async removePhoneNumber(params: { stripePriceId: string }): Promise<PhoneRemoveNumberResponse> {
    return this.post<PhoneRemoveNumberResponse>('/phone/remove-number', params);
  }

  async createPhoneCheckoutSession(params: {
    stripePriceId: string;
    phoneNumber: string;
    countryCode: string;
    numberType: string;
    friendlyName?: string;
    displayName?: string;
    addressId?: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<{ url: string }> {
    return this.post<{ url: string }>('/phone/checkout', params);
  }

  // ==========================================
  // Prepaid Credit Topups (Stripe writes)
  // ==========================================

  /**
   * Buy a prepaid credit package. Returns `{ url }` — a Stripe Checkout
   * session (mode=payment) the user is redirected to. The credits are granted
   * by the `checkout.session.completed` webhook once payment succeeds.
   */
  async createCreditTopupCheckout(params: {
    packageId: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<{ url: string }> {
    return this.post<{ url: string }>('/credits/checkout', params);
  }

  // ==========================================
  // Internal: Pricing Sync (M2M auth)
  // ==========================================

  async syncPhonePricing(params: {
    countryCode: string;
    numberType: string;
    monthlyPrice: string;
    currency: string;
    existingProductId?: string | null;
    existingPriceId?: string | null;
  }): Promise<{ stripeProductId: string; stripePriceId: string }> {
    return this.internalPost<{ stripeProductId: string; stripePriceId: string }>(
      '/api/internal/pricing/sync-price',
      params
    );
  }

  async syncAllPhonePricing(prices: Array<{
    countryCode: string;
    numberType: string;
    monthlyPrice: string;
    currency: string;
    existingProductId?: string | null;
    existingPriceId?: string | null;
  }>): Promise<{
    results: Array<{
      countryCode: string;
      numberType: string;
      stripeProductId?: string;
      stripePriceId?: string;
      error?: string;
    }>;
  }> {
    return this.internalPost('/api/internal/pricing/sync-all-prices', { prices });
  }
}

// Phone billing types
export interface PhoneSubscriptionResponse {
  exists: boolean;
  subscriptionId?: string;
  status?: string;
  items?: Array<{
    id: string;
    priceId: string;
    quantity: number;
    amount: number;
    currency: string;
    interval: string;
  }>;
  totalMonthly?: number;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
}

interface PhoneAddNumberResponse {
  success?: boolean;
  subscriptionId?: string;
  provisioningStatus?: 'pending';
  taskId?: string;
  requiresCheckout?: boolean;
}

interface PhoneRemoveNumberResponse {
  success: boolean;
  subscriptionCanceled: boolean;
}

// Singleton instance
export const billingWorkerApi = new BillingWorkerClient();
