/**
 * Asset sources (Settings → Apps → WeldDesk → Asset register): the device
 * imports into the asset register, today Microsoft Intune. Served by app-api
 * `/api/asset-sources`; every route needs `weldobjects:manage`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { useWorkspaceId } from '@/contexts/workspace-context';
import type {
  AssetSource,
  CreateAssetSourceInput,
  TestAssetSourceInput,
  TestSavedAssetSourceInput,
  UpdateAssetSourceInput,
} from '@weldsuite/core-api-client/schemas/asset-sources';

/** How often a running import is looked at again. */
export const ASSET_SOURCE_POLL_MS = 4000;

export const assetSourceKeys = {
  all: (workspaceId: string | null | undefined) => ['asset-sources', workspaceId ?? 'none'] as const,
  list: (workspaceId: string | null | undefined) => [...assetSourceKeys.all(workspaceId), 'list'] as const,
};

const isRunning = (sources: AssetSource[] | undefined) => (sources ?? []).some((source) => source.lastStatus === 'running');

/**
 * The workspace's sources. Polls only while an import is running, so an idle
 * page makes no requests. Pass `enabled: false` for a member without
 * `weldobjects:manage`.
 */
export function useAssetSources(options: { enabled?: boolean } = {}) {
  const { assetSources } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: assetSourceKeys.list(workspaceId),
    queryFn: () => assetSources.list(),
    select: (res) => res.data,
    enabled: options.enabled ?? true,
    refetchInterval: (query) => (isRunning(query.state.data?.data) ? ASSET_SOURCE_POLL_MS : false),
  });
}

function useInvalidateAssetSources() {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  return () => qc.invalidateQueries({ queryKey: assetSourceKeys.all(workspaceId) });
}

export function useCreateAssetSource() {
  const { assetSources } = useAppApi();
  const invalidate = useInvalidateAssetSources();
  return useMutation({
    mutationFn: (input: CreateAssetSourceInput) => assetSources.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateAssetSource() {
  const { assetSources } = useAppApi();
  const invalidate = useInvalidateAssetSources();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAssetSourceInput }) => assetSources.update(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAssetSource() {
  const { assetSources } = useAppApi();
  const invalidate = useInvalidateAssetSources();
  return useMutation({
    mutationFn: (id: string) => assetSources.delete(id),
    onSuccess: invalidate,
  });
}

/** Starts an import now; the list then shows it running and starts polling. */
export function useSyncAssetSource() {
  const { assetSources } = useAppApi();
  const invalidate = useInvalidateAssetSources();
  return useMutation({
    mutationFn: (id: string) => assetSources.sync(id),
    onSuccess: invalidate,
  });
}

/** Tries a connection that is not saved yet. The result is returned to the caller; nothing is cached. */
export function useTestNewAssetSource() {
  const { assetSources } = useAppApi();
  return useMutation({
    mutationFn: (input: TestAssetSourceInput) => assetSources.testNew(input).then((res) => res.data),
  });
}

/** Tries a saved source, optionally with a replacement secret. Saves nothing. */
export function useTestAssetSource() {
  const { assetSources } = useAppApi();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: TestSavedAssetSourceInput }) =>
      assetSources.test(id, input).then((res) => res.data),
  });
}
