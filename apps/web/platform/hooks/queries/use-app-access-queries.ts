/**
 * Apps that are on request only (`app_catalog.requires_approval`, WeldReach
 * first): a workspace owner or admin files an access request from the app
 * store, WeldSuite staff approve it in the admin console.
 *
 * The endpoints live in app-api (`/api/app-catalog/:code/access-request`),
 * reachable before approval, unlike the module's own API.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { AppAccessRequestInput } from '@weldsuite/app-api-client/schemas/reach';

export const appAccessKeys = {
  all: ['app-access'] as const,
  detail: (appCode: string) => [...appAccessKeys.all, appCode] as const,
};

/** The app-store list (`useAvailableApps`) carries each app's access state; refresh it after a request. */
const AVAILABLE_APPS_KEY = ['settings', 'available-apps'] as const;

/** This workspace's request for `appCode`; `data` is null when it never asked. */
export function useAppAccessRequest(appCode: string, enabled = true) {
  const { appAccess } = useAppApi();
  return useQuery({
    queryKey: appAccessKeys.detail(appCode),
    queryFn: () => appAccess.get(appCode),
    select: (res) => res.data,
    enabled: enabled && Boolean(appCode),
  });
}

/** File (or re-file after a rejection) the request. 409 while one is pending, approved or suspended. */
export function useRequestAppAccess(appCode: string) {
  const { appAccess } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AppAccessRequestInput) => appAccess.request(appCode, input),
    onSuccess: (res) => {
      qc.setQueryData(appAccessKeys.detail(appCode), res);
      void qc.invalidateQueries({ queryKey: AVAILABLE_APPS_KEY });
    },
  });
}
