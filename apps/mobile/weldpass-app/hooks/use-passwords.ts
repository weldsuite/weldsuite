/**
 * Queries and mutations for the password manager. Lists carry no secrets and
 * are cached; a revealed item is never cached (see `useRevealItem`).
 *
 * Query keys start with the active workspace, so switching workspace never
 * shows another workspace's vaults from the cache.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import type {
  WeldPassItem,
  WeldPassItemInput,
  WeldPassRevealedItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';

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

export function useVaults() {
  const workspace = useWorkspaceKey();
  return useQuery({
    queryKey: passwordKeys.vaults(workspace),
    queryFn: async (): Promise<WeldPassVault[]> => (await appApi.passwords.listVaults()).data,
  });
}

/** Every item the person can open, across vaults. Screens filter on the device. */
export function useItems() {
  const workspace = useWorkspaceKey();
  return useQuery({
    queryKey: passwordKeys.items(workspace),
    queryFn: async (): Promise<WeldPassItem[]> => (await appApi.passwords.listItems()).data,
  });
}

export function usePasswordHealth() {
  const workspace = useWorkspaceKey();
  return useQuery({
    queryKey: passwordKeys.health(workspace),
    queryFn: async () => (await appApi.passwords.passwordHealth()).data,
  });
}

/**
 * Decrypts one item (audited on the server, `X-WeldPass-Client: mobile`).
 * A mutation, not a query: the fields stay in the calling screen's state and
 * never enter the shared cache.
 */
export function useRevealItem() {
  return useMutation({
    mutationFn: async ({ vaultId, itemId }: { vaultId: string; itemId: string }): Promise<WeldPassRevealedItem> =>
      (await appApi.passwords.revealItem(vaultId, itemId)).data,
    gcTime: 0,
  });
}

/** Lists and health after a write. */
function useInvalidatePasswords() {
  const queryClient = useQueryClient();
  const workspace = useWorkspaceKey();
  return () => queryClient.invalidateQueries({ queryKey: passwordKeys.all(workspace) });
}

export function useCreateItem() {
  const invalidate = useInvalidatePasswords();
  return useMutation({
    mutationFn: async ({ vaultId, input }: { vaultId: string; input: WeldPassItemInput }) =>
      (await appApi.passwords.createItem(vaultId, input)).data,
    onSuccess: invalidate,
  });
}

export function useUpdateItem() {
  const invalidate = useInvalidatePasswords();
  return useMutation({
    mutationFn: async ({ vaultId, itemId, input }: { vaultId: string; itemId: string; input: WeldPassItemInput }) =>
      (await appApi.passwords.updateItem(vaultId, itemId, input)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteItem() {
  const invalidate = useInvalidatePasswords();
  return useMutation({
    mutationFn: async ({ vaultId, itemId }: { vaultId: string; itemId: string }) =>
      appApi.passwords.deleteItem(vaultId, itemId),
    onSuccess: invalidate,
  });
}
