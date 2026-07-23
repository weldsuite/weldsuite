/**
 * Access Requests Hooks
 *
 * Backs the "Request access" button on the AccessDeniedEmptyState.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { notificationKeys } from '@/hooks/queries/use-notifications-queries';
import type {
  AccessRequest,
  CreateAccessRequestInput,
  ResolveAccessRequestInput,
} from '@weldsuite/app-api-client/schemas/access-requests';

const accessRequestsKeys = {
  all: ['access-requests'] as const,
  myPending: () => [...accessRequestsKeys.all, 'me', 'pending'] as const,
};

export function useMyPendingAccessRequests() {
  const { accessRequests } = useAppApi();

  return useQuery({
    queryKey: accessRequestsKeys.myPending(),
    queryFn: () => accessRequests.listMyPending(),
    select: (res) => res.data,
    staleTime: 60_000,
  });
}

export function useCreateAccessRequest() {
  const { accessRequests } = useAppApi();
  const qc = useQueryClient();

  return useMutation<{ data: AccessRequest }, Error, CreateAccessRequestInput>({
    mutationFn: (input) => accessRequests.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accessRequestsKeys.myPending() });
    },
  });
}

export function useResolveAccessRequest() {
  const { accessRequests } = useAppApi();
  const qc = useQueryClient();

  return useMutation<
    { data: AccessRequest },
    Error,
    { id: string; status: ResolveAccessRequestInput['status'] }
  >({
    mutationFn: ({ id, status }) => accessRequests.resolve(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.all });
      qc.invalidateQueries({ queryKey: accessRequestsKeys.myPending() });
    },
  });
}
