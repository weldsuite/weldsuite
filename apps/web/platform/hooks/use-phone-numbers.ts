/**
 * Phone-number hooks — app-api `/api/telephony/*` + `/api/call-intelligence/*`.
 *
 * Migrated off the legacy api-worker (`/api/settings/telephony/*`,
 * `/api/crm/call-intelligence/*`) in W5. app-api wraps every payload in
 * `{ data: T }`; each hook unwraps it so callers keep their previous contract.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { VoipPhoneNumber } from '@/lib/api/domains/call-intelligence';
import type {
  ProviderAddress,
  ProviderBundle,
  AvailableNumber,
} from '@/app/settings/apps/phone-numbers/new-number/new-number-client';

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
      const result = await client.get<Envelope<VoipPhoneNumber[]>>('/call-intelligence/phone-numbers');
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
      const result = await client.get<Envelope<{ addresses: ProviderAddress[] }>>('/telephony/addresses');
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
      const result = await client.get<Envelope<{ bundles: ProviderBundle[] }>>(`/telephony/bundles${params}`);
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
          setupFee?: number;
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
      const result = await client.post<Envelope<{ numbers: AvailableNumber[] }>>('/telephony/phone-numbers/search', options);
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
      const result = await client.post<Envelope<{ address: ProviderAddress }>>('/telephony/addresses', {
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

export type PhoneRequirementFieldType = 'textual' | 'address' | 'document' | 'action' | 'datetime';

export interface PhoneOrderRequirement {
  id: string;
  name: string;
  description: string;
  fieldType: PhoneRequirementFieldType;
  example?: string;
  fieldValue?: string;
  status?: string;
}

export function usePhoneOrderRequirements(phoneNumberId: string | null) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...phoneNumberKeys.all, 'order-requirements', phoneNumberId],
    enabled: Boolean(phoneNumberId),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<{
        orderId?: string;
        phoneNumberOrderId?: string;
        requirementsMet: boolean;
        requirements: PhoneOrderRequirement[];
      }>>(`/telephony/phone-numbers/${phoneNumberId}/regulatory-requirements`);
      return result.data;
    },
  });
}

export function useUploadTelephonyDocument() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const client = await getClient();
      const form = new FormData();
      form.append('file', file);
      const result = await client.postForm<Envelope<{ id: string; filename: string }>>(
        '/telephony/documents',
        form,
      );
      return result.data;
    },
  });
}

export function useSubmitPhoneOrderRequirements() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      phoneNumberId: string;
      values: Array<{ requirementId: string; fieldValue: string }>;
    }) => {
      const client = await getClient();
      const result = await client.post<Envelope<{ requirementsMet: boolean }>>(
        `/telephony/phone-numbers/${args.phoneNumberId}/regulatory-requirements`,
        { values: args.values },
      );
      return result.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: phoneNumberKeys.all });
    },
  });
}