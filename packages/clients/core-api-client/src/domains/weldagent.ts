import type { ClientApi } from '../types';

export type PurchaseAgentPackageInput = {
  packageSlug: string;
  successUrl?: string;
  cancelUrl?: string;
};

export type PurchaseAgentPackageResponse =
  | { url: string; addedInline?: false }
  | { addedInline: true; subscriptionItemId: string; url?: undefined };

export type CancelAgentPackageInput = { packageSlug: string };

export type CancelAgentPackageResponse = { ok: true; cancelAt: string | null };

export function createWeldagentApi(api: ClientApi) {
  return {
    purchaseAgentPackage(
      input: PurchaseAgentPackageInput,
    ): Promise<PurchaseAgentPackageResponse> {
      return api.post<PurchaseAgentPackageResponse>(
        '/weldagent/packages/checkout',
        input,
      );
    },

    cancelAgentPackage(
      input: CancelAgentPackageInput,
    ): Promise<CancelAgentPackageResponse> {
      return api.post<CancelAgentPackageResponse>(
        '/weldagent/packages/cancel',
        input,
      );
    },
  };
}
