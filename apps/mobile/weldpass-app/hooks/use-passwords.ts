/**
 * Vaults and items, from the offline copy while it is open (ADR PASS-010),
 * from the server otherwise. Lists carry no secrets; a revealed item never
 * enters the shared cache (see `useRevealItem`).
 *
 * Query keys start with the active workspace, so switching workspace never
 * shows another workspace's vaults from the cache.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import type {
  WeldPassItem,
  WeldPassItemInput,
  WeldPassRevealedItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';

import { useOffline } from '@/contexts/OfflineContext';
import { findItem, itemsOf, vaultsOf } from '@/lib/offline/copy';
import { appApi } from '@/services/app-api';

export function useWorkspaceKey(): string {
  const { organizationId, user } = useAuthSession();
  return organizationId ?? user?.organizationId ?? 'none';
}

export const passwordKeys = {
  all: (workspace: string) => ['weldpass', workspace] as const,
  vaults: (workspace: string) => ['weldpass', workspace, 'vaults'] as const,
  items: (workspace: string) => ['weldpass', workspace, 'items'] as const,
  health: (workspace: string) => ['weldpass', workspace, 'health'] as const,
};

/** What the list screens read, whichever the source. */
export interface ListState<T> {
  data: T[] | undefined;
  isLoading: boolean;
  isRefetching: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  /** Read from the offline copy. */
  fromCopy: boolean;
}

export function useVaults(): ListState<WeldPassVault> {
  const workspace = useWorkspaceKey();
  const offline = useOffline();
  const fromCopy = offline.copy !== null;
  const query = useQuery({
    queryKey: passwordKeys.vaults(workspace),
    queryFn: async (): Promise<WeldPassVault[]> => (await appApi.passwords.listVaults()).data,
    enabled: !fromCopy,
  });
  const copied = useMemo(() => (offline.copy ? vaultsOf(offline.copy) : undefined), [offline.copy]);
  if (fromCopy) {
    return { data: copied, isLoading: false, isRefetching: offline.syncing, error: null, refetch: offline.sync, fromCopy };
  }
  return {
    data: query.data,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    error: query.error,
    refetch: query.refetch,
    fromCopy,
  };
}

/** Every item the person can open, across vaults. Screens filter on the device. */
export function useItems(): ListState<WeldPassItem> {
  const workspace = useWorkspaceKey();
  const offline = useOffline();
  const fromCopy = offline.copy !== null;
  const query = useQuery({
    queryKey: passwordKeys.items(workspace),
    queryFn: async (): Promise<WeldPassItem[]> => (await appApi.passwords.listItems()).data,
    enabled: !fromCopy,
  });
  const copied = useMemo(() => (offline.copy ? itemsOf(offline.copy) : undefined), [offline.copy]);
  if (fromCopy) {
    return { data: copied, isLoading: false, isRefetching: offline.syncing, error: null, refetch: offline.sync, fromCopy };
  }
  return {
    data: query.data,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    error: query.error,
    refetch: query.refetch,
    fromCopy,
  };
}

export function usePasswordHealth() {
  const workspace = useWorkspaceKey();
  return useQuery({
    queryKey: passwordKeys.health(workspace),
    queryFn: async () => (await appApi.passwords.passwordHealth()).data,
  });
}

/**
 * The item's fields. A mutation, not a query: they stay in the calling
 * screen's state and never enter the shared cache.
 *
 * - `copy` (the item screen): from the offline copy when it holds the item,
 *   queued for the vault's trail as an offline reveal; else from the server.
 * - `server` (the edit form): always the server's reveal. A shared vault's
 *   login has its 2FA secret left out of the copy, and saving replaces the
 *   whole item, so an edit started from the copy would erase the secret.
 */
export function useRevealItem(source: 'copy' | 'server' = 'copy') {
  const offline = useOffline();
  return useMutation({
    mutationFn: async ({ vaultId, itemId }: { vaultId: string; itemId: string }): Promise<WeldPassRevealedItem> => {
      const copied = source === 'copy' && offline.copy ? findItem(offline.copy, vaultId, itemId) : null;
      if (copied) {
        offline.recordEvent(vaultId, itemId, 'revealed');
        return copied;
      }
      return (await appApi.passwords.revealItem(vaultId, itemId)).data;
    },
    gcTime: 0,
  });
}

/** After a write: the server's lists, the health report and the copy. */
function useAfterWrite() {
  const queryClient = useQueryClient();
  const workspace = useWorkspaceKey();
  const offline = useOffline();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: passwordKeys.all(workspace) });
    await offline.sync();
  };
}

export function useCreateItem() {
  const afterWrite = useAfterWrite();
  return useMutation({
    mutationFn: async ({ vaultId, input }: { vaultId: string; input: WeldPassItemInput }) =>
      (await appApi.passwords.createItem(vaultId, input)).data,
    onSuccess: afterWrite,
  });
}

export function useUpdateItem() {
  const afterWrite = useAfterWrite();
  return useMutation({
    mutationFn: async ({ vaultId, itemId, input }: { vaultId: string; itemId: string; input: WeldPassItemInput }) =>
      (await appApi.passwords.updateItem(vaultId, itemId, input)).data,
    onSuccess: afterWrite,
  });
}

export function useDeleteItem() {
  const afterWrite = useAfterWrite();
  return useMutation({
    mutationFn: async ({ vaultId, itemId }: { vaultId: string; itemId: string }) =>
      appApi.passwords.deleteItem(vaultId, itemId),
    onSuccess: afterWrite,
  });
}
