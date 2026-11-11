/**
 * Audit log streams (Settings → Activity → Log streaming): the destinations a
 * workspace's audit events are pushed to. Served by app-api
 * `/api/audit-log-streams`; every route needs `general:update`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { useWorkspaceId } from '@/contexts/workspace-context';
import type {
  CreateAuditLogStreamInput,
  UpdateAuditLogStreamInput,
} from '@weldsuite/core-api-client/schemas/audit-log-streams';

export const auditLogStreamKeys = {
  all: (workspaceId: string | null | undefined) => ['audit-log-streams', workspaceId ?? 'none'] as const,
  list: (workspaceId: string | null | undefined) => [...auditLogStreamKeys.all(workspaceId), 'list'] as const,
};

/** The workspace's streams, oldest first. Pass `enabled: false` for a member without `general:update`. */
export function useAuditLogStreams(options: { enabled?: boolean } = {}) {
  const { auditLogStreams } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: auditLogStreamKeys.list(workspaceId),
    queryFn: () => auditLogStreams.list(),
    select: (res) => res.data,
    enabled: options.enabled ?? true,
  });
}

function useInvalidateAuditLogStreams() {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  return () => qc.invalidateQueries({ queryKey: auditLogStreamKeys.all(workspaceId) });
}

export function useCreateAuditLogStream() {
  const { auditLogStreams } = useAppApi();
  const invalidate = useInvalidateAuditLogStreams();
  return useMutation({
    mutationFn: (input: CreateAuditLogStreamInput) => auditLogStreams.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateAuditLogStream() {
  const { auditLogStreams } = useAppApi();
  const invalidate = useInvalidateAuditLogStreams();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAuditLogStreamInput }) => auditLogStreams.update(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAuditLogStream() {
  const { auditLogStreams } = useAppApi();
  const invalidate = useInvalidateAuditLogStreams();
  return useMutation({
    mutationFn: (id: string) => auditLogStreams.delete(id),
    onSuccess: invalidate,
  });
}

/** Sends one synthetic event. The result is returned to the caller; nothing is cached. */
export function useTestAuditLogStream() {
  const { auditLogStreams } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => auditLogStreams.test(id).then((res) => res.data),
  });
}
