/**
 * Services outside the EU (ADR OPS-026): the workspace's opt-ins, for the
 * settings page and the "Leaves the EU" labels on the integrations that use
 * one. Only the EU edition offers it (`outside-eu-services`); elsewhere the
 * hooks never request anything.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import type {
  OutsideEuService,
  OutsideEuServices,
  SwitchOutsideEuServiceInput,
} from '@weldsuite/app-api-client/schemas/outside-eu-services';
import type { DataResponse } from '@weldsuite/app-api-client/types';

export const outsideEuKeys = {
  all: ['outside-eu-services'] as const,
  list: () => [...outsideEuKeys.all, 'list'] as const,
};

/** Whether this deployment has the opt-in at all (the EU edition). */
export function hasOutsideEuServices(): boolean {
  return isFeatureAvailable('outside-eu-services');
}

/** Every service with the workspace's state. */
export function useOutsideEuServices(enabled = true) {
  const { outsideEuServices } = useAppApi();
  return useQuery({
    queryKey: outsideEuKeys.list(),
    queryFn: () => outsideEuServices.list(),
    select: (res) => res.data,
    enabled: enabled && hasOutsideEuServices(),
    staleTime: 60_000,
  });
}

/**
 * The service an integration code sends data to, with its state: null when
 * the code is an EU service, the install doesn't enforce the opt-in, or the
 * list has not loaded.
 */
export function useOutsideEuServiceFor(code: string | null | undefined): OutsideEuService | null {
  const { data } = useOutsideEuServices(Boolean(code));
  return data?.enforced ? outsideEuServiceFor(data, code) : null;
}

/** Pure lookup behind `useOutsideEuServiceFor`. */
export function outsideEuServiceFor(
  data: OutsideEuServices | undefined,
  code: string | null | undefined,
): OutsideEuService | null {
  if (!data || !code) return null;
  const normalized = code.trim().toLowerCase().replaceAll('-', '_');
  const id = data.integrations[normalized] ?? (data.services.some((s) => s.id === normalized) ? normalized : null);
  return id ? (data.services.find((s) => s.id === id) ?? null) : null;
}

/** Switch one service on (with the acknowledgement) or off. */
export function useSwitchOutsideEuService() {
  const { outsideEuServices } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ service, input }: { service: string; input: SwitchOutsideEuServiceInput }) =>
      outsideEuServices.switch(service, input),
    onSuccess: (res) => {
      qc.setQueryData<DataResponse<OutsideEuServices>>(outsideEuKeys.list(), (current) =>
        current
          ? {
              ...current,
              data: {
                ...current.data,
                services: current.data.services.map((s) => (s.id === res.data.id ? res.data : s)),
              },
            }
          : current,
      );
      void qc.invalidateQueries({ queryKey: outsideEuKeys.all });
    },
  });
}
