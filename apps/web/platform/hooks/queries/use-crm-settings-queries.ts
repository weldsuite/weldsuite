/**
 * WeldCRM workspace settings (`/api/crm-settings`): auto-add. The route is
 * Rust only, so the query stays idle on Global (`crm-auto-add` is not
 * available there) and never requests a route that does not exist.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import type { CrmSettings, UpdateCrmSettingsInput } from '@weldsuite/app-api-client/schemas/crm-settings';

export const crmSettingsKeys = {
  all: ['crm-settings'] as const,
};

export function useCrmSettings() {
  const { crmSettings } = useAppApi();
  return useQuery({
    queryKey: crmSettingsKeys.all,
    queryFn: () => crmSettings.get(),
    select: (res) => res.data,
    enabled: isFeatureAvailable('crm-auto-add'),
  });
}

/** Changes the keys given; the answer is the new settings. */
export function useUpdateCrmSettings() {
  const { crmSettings } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCrmSettingsInput) => crmSettings.update(input),
    onSuccess: (res) => {
      qc.setQueryData(crmSettingsKeys.all, res);
    },
  });
}

export type { CrmSettings };
