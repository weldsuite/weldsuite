/**
 * Phone-number hooks — app-api `/api/telephony/*` + `/api/call-intelligence/*`.
 *
 * Migrated off the legacy api-worker (`/api/settings/telephony/*`,
 * `/api/crm/call-intelligence/*`) in W5. app-api wraps every payload in
 * `{ data: T }`; each hook unwraps it so callers keep their previous contract.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

/** app-api single envelope. */
interface Envelope<T> {
  data: T;
}

const phoneNumberKeys = {
  all: ['phone-numbers'] as const,
  list: () => [...phoneNumberKeys.all, 'list'] as const,
  voipConfigured: () => [...phoneNumberKeys.all, 'voip-configured'] as const,
  addresses: () => [...phoneNumberKeys.all, 'addresses'] as const,
  bundles: (isoCountry?: string) => [...phoneNumberKeys.all, 'bundles', isoCountry] as const,
  pricing: () => [...phoneNumberKeys.all, 'pricing'] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Phone numbers. The list surface lives on `/call-intelligence`; the mutation
 * surface (which also touches billing) lives on `/telephony`.
 */
export function usePhoneNumbers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: phoneNumberKeys.list(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<any[]>>('/call-intelligence/phone-numbers');
      return result.data || [];
    },
  });
}

export function useVoipConfigured() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: phoneNumberKeys.voipConfigured(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<{ configured: boolean }>>('/telephony/configured');
      return result.data?.configured ?? false;
    },
  });
}

export function useAddresses() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: phoneNumberKeys.addresses(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<{ addresses: any[] }>>('/telephony/addresses');
      return result.data?.addresses || [];
    },
  });
}

export function useBundles(isoCountry?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: phoneNumberKeys.bundles(isoCountry),
    queryFn: async () => {
      const client = await getClient();
      const params = isoCountry ? `?isoCountry=${isoCountry}` : '';
      const result = await client.get<Envelope<{ bundles: any[] }>>(`/telephony/bundles${params}`);
      return result.data?.bundles || [];
    },
  });
}

/**
 * Number pricing. app-api already coerces `monthlyPrice` to a number and nests
 * the array under `data.pricing` (the legacy worker returned it top-level and
 * left the mapping to the client).
 */
export function useNumberPricing() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: phoneNumberKeys.pricing(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<{
        pricing: Array<{
          countryCode: string;
          numberType: string;
          monthlyPrice: number;
          currency: string;
          stripePriceId?: string;
        }>;
      }>>('/telephony/pricing');
      return result.data?.pricing ?? [];
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Update a phone number (display name, etc.)
 */
export function useUpdatePhoneNumber() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { displayName?: string | null; isDefault?: boolean } }) => {
      const client = await getClient();
      return client.put<Envelope<{ success: boolean }>>(`/telephony/phone-numbers/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.all });
    },
  });
}

/**
 * Delete a phone number (includes billing removal)
 */
export function useDeletePhoneNumber() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<Envelope<{ success: boolean }>>(`/telephony/phone-numbers/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.all });
    },
  });
}

/**
 * Set a phone number as the default
 */
export function useSetDefaultPhoneNumber() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<Envelope<{ success: boolean }>>(`/telephony/phone-numbers/${id}/set-default`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.all });
    },
  });
}

/**
 * Search available phone numbers via Telnyx
 */
export function useSearchAvailableNumbers() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (options: {
      country: string;
      areaCode?: string;
      contains?: string;
      type?: 'local' | 'toll-free' | 'mobile';
      limit?: number;
    }) => {
      const client = await getClient();
      const result = await client.post<Envelope<{ numbers: any[] }>>('/telephony/phone-numbers/search', options);
      // Callers read `.data.numbers` — preserve the legacy `{ success, data }`
      // envelope so `new-number-client.tsx` needs no change.
      return { success: true, data: result.data };
    },
  });
}

/**
 * Provision (purchase) a phone number via billing + Telnyx.
 *
 * app-api nests everything under `data` and signals failures by throwing
 * (`ApiError`) rather than returning `{ success: false }`. Flatten back to the
 * legacy shape so `new-number-client.tsx` keeps working unchanged.
 */
export function useProvisionPhoneNumber() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      phoneNumber: string;
      friendlyName?: string;
      displayName?: string;
      countryCode: string;
      numberType?: 'local' | 'toll-free' | 'mobile';
      addressId?: string;
    }): Promise<{
      success: boolean;
      data?: { provisioningStatus: 'pending' };
      checkoutUrl?: string;
      requiresAddress?: boolean;
      error?: { message: string };
    }> => {
      const client = await getClient();
      const result = await client.post<Envelope<{
        success?: boolean;
        provisioningStatus?: 'pending';
        requiresCheckout?: boolean;
        checkoutUrl?: string;
      }>>('/telephony/phone-numbers/provision', data);

      const payload = result.data ?? {};
      if (payload.requiresCheckout) {
        return { success: false, checkoutUrl: payload.checkoutUrl };
      }
      return {
        success: payload.success ?? true,
        data: payload.provisioningStatus ? { provisioningStatus: payload.provisioningStatus } : undefined,
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.all });
    },
  });
}

/**
 * Create a Telnyx address for regulatory compliance
 */
export function useCreateAddress() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      customerName: string;
      street: string;
      streetSecondary?: string;
      city: string;
      region: string;
      postalCode: string;
      isoCountry: string;
      friendlyName?: string;
    }) => {
      const client = await getClient();
      // Map legacy field names to Telnyx address format
      const result = await client.post<Envelope<{ address: any }>>('/telephony/addresses', {
        businessName: data.customerName,
        firstName: data.customerName.split(' ')[0] || data.customerName,
        lastName: data.customerName.split(' ').slice(1).join(' ') || '-',
        streetAddress: data.street,
        extendedAddress: data.streetSecondary,
        locality: data.city,
        administrativeArea: data.region,
        postalCode: data.postalCode,
        countryCode: data.isoCountry,
      });
      return { success: true, data: result.data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.addresses() });
    },
  });
}

/**
 * Sync phone numbers from Telnyx to the database
 */
function useSyncPhoneNumbers() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<Envelope<{ count: number }>>('/telephony/phone-numbers/sync', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.all });
    },
  });
}
