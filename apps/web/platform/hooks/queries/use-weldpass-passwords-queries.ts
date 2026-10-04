/**
 * WeldPass password manager hooks — vaults, their members and their items.
 *
 * As in `use-weldpass-queries.ts`, a reveal is a mutation, not a query: a
 * decrypted item is written to the vault's trail on every fetch, so it must
 * not be cached, refetched on focus, or replayed in the background. The same
 * goes for a 2FA code.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  WeldPassImportFormat,
  WeldPassItemInput,
  WeldPassRevealedItem,
  WeldPassTotpCode,
  WeldPassVaultRole,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';

export const weldpassPasswordKeys = {
  all: ['weldpass', 'passwords'] as const,
  vaults: () => [...weldpassPasswordKeys.all, 'vaults'] as const,
  items: () => [...weldpassPasswordKeys.all, 'items'] as const,
  teammates: () => [...weldpassPasswordKeys.all, 'teammates'] as const,
  members: (vaultId: string) => [...weldpassPasswordKeys.all, 'members', vaultId] as const,
  activity: (vaultId: string) => [...weldpassPasswordKeys.all, 'activity', vaultId] as const,
  versions: (itemId: string) => [...weldpassPasswordKeys.all, 'versions', itemId] as const,
  health: () => [...weldpassPasswordKeys.all, 'health'] as const,
};

type QueryClient = ReturnType<typeof useQueryClient>;

/** Everything an item write can change: the list, vault counts, the health report. */
function invalidateAfterItemWrite(qc: QueryClient, vaultIds: string[]) {
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.items() });
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.vaults() });
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.health() });
  for (const vaultId of vaultIds) {
    qc.invalidateQueries({ queryKey: weldpassPasswordKeys.activity(vaultId) });
  }
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

/** The caller's vaults, personal first. Creates the personal vault on first use. */
export function useWeldPassVaults() {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.vaults(),
    queryFn: () => weldpassPasswords.listVaults(),
    select: (res) => res.data,
  });
}

export function useCreateWeldPassVault() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; description?: string | null }) =>
      weldpassPasswords.createVault(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassPasswordKeys.vaults() });
    },
  });
}

export function useUpdateWeldPassVault() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { vaultId: string; name?: string; description?: string | null }) =>
      weldpassPasswords.updateVault(input.vaultId, {
        name: input.name,
        description: input.description,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassPasswordKeys.vaults() });
    },
  });
}

export function useDeleteWeldPassVault() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (vaultId) => weldpassPasswords.deleteVault(vaultId),
    onSuccess: (_result, vaultId) => invalidateAfterItemWrite(qc, [vaultId]),
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** Workspace members a vault can be shared with. */
export function useWeldPassTeammates(enabled = true) {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.teammates(),
    queryFn: () => weldpassPasswords.listTeammates(),
    select: (res) => res.data,
    enabled,
  });
}

export function useWeldPassVaultMembers(vaultId: string | undefined) {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.members(vaultId ?? ''),
    queryFn: () => weldpassPasswords.listMembers(vaultId as string),
    select: (res) => res.data,
    enabled: Boolean(vaultId),
  });
}

function invalidateAfterMemberWrite(qc: QueryClient, vaultId: string) {
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.members(vaultId) });
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.activity(vaultId) });
  // Member counts — and, when the caller left or joined, which vaults and
  // items they can see at all.
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.vaults() });
  qc.invalidateQueries({ queryKey: weldpassPasswordKeys.items() });
}

/** Add a teammate, or change the role of one who is already a member. */
export function useAddWeldPassVaultMember(vaultId: string) {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { userId: string; role: WeldPassVaultRole }) =>
      weldpassPasswords.addMember(vaultId, input),
    onSuccess: () => invalidateAfterMemberWrite(qc, vaultId),
  });
}

export function useUpdateWeldPassVaultMember(vaultId: string) {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { userId: string; role: WeldPassVaultRole }) =>
      weldpassPasswords.updateMember(vaultId, input.userId, input.role),
    onSuccess: () => invalidateAfterMemberWrite(qc, vaultId),
  });
}

/** Remove a member — or leave the vault, when given the caller's own id. */
export function useRemoveWeldPassVaultMember(vaultId: string) {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (userId) => weldpassPasswords.removeMember(vaultId, userId),
    onSuccess: () => invalidateAfterMemberWrite(qc, vaultId),
  });
}

/** A vault's trail. Requires the manager role on it. */
export function useWeldPassVaultActivity(vaultId: string | undefined, enabled = true) {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.activity(vaultId ?? ''),
    queryFn: () => weldpassPasswords.listActivity(vaultId as string, { limit: 100 }),
    select: (res) => res.data,
    enabled: Boolean(vaultId) && enabled,
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Every item the caller can open, across vaults. One list, filtered in the
 * browser: it carries no secrets, and a vault switch or a search should not
 * cost a request.
 */
export function useWeldPassItems() {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.items(),
    queryFn: () => weldpassPasswords.listItems(),
    select: (res) => res.data,
  });
}

export function useCreateWeldPassItem() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { vaultId: string; item: WeldPassItemInput }) =>
      weldpassPasswords.createItem(input.vaultId, input.item),
    onSuccess: (_result, input) => invalidateAfterItemWrite(qc, [input.vaultId]),
  });
}

/** Replaces the whole item — pass every field, not only the changed ones. */
export function useUpdateWeldPassItem() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { vaultId: string; itemId: string; item: WeldPassItemInput }) =>
      weldpassPasswords.updateItem(input.vaultId, input.itemId, input.item),
    onSuccess: (_result, input) => {
      invalidateAfterItemWrite(qc, [input.vaultId]);
      qc.invalidateQueries({ queryKey: weldpassPasswordKeys.versions(input.itemId) });
    },
  });
}

export function useDeleteWeldPassItem() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, { vaultId: string; itemId: string }>({
    mutationFn: (input) => weldpassPasswords.deleteItem(input.vaultId, input.itemId),
    onSuccess: (_result, input) => invalidateAfterItemWrite(qc, [input.vaultId]),
  });
}

/**
 * Decrypt one item. A mutation rather than a query so it is never cached or
 * replayed — each reveal is a recorded event and should happen exactly when
 * the user asks for it.
 */
export function useRevealWeldPassItem() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation<WeldPassRevealedItem, Error, { vaultId: string; itemId: string }>({
    // The mutation cache would otherwise keep the decrypted item for five
    // minutes after the dialog that asked for it has closed.
    gcTime: 0,
    mutationFn: async (input) => {
      const res = await weldpassPasswords.revealItem(input.vaultId, input.itemId);
      return res.data;
    },
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: weldpassPasswordKeys.activity(input.vaultId) });
    },
  });
}

/** The current 2FA code for a login. Not cached, for the same reason as a reveal. */
export function useWeldPassTotp() {
  const { weldpassPasswords } = useAppApi();

  return useMutation<WeldPassTotpCode, Error, { vaultId: string; itemId: string }>({
    gcTime: 0,
    mutationFn: async (input) => {
      const res = await weldpassPasswords.generateTotp(input.vaultId, input.itemId);
      return res.data;
    },
  });
}

/** Move an item to another vault. The item gets a new id in the target. */
export function useMoveWeldPassItem() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { vaultId: string; itemId: string; targetVaultId: string }) =>
      weldpassPasswords.moveItem(input.vaultId, input.itemId, input.targetVaultId),
    onSuccess: (_result, input) =>
      invalidateAfterItemWrite(qc, [input.vaultId, input.targetVaultId]),
  });
}

export function useWeldPassItemVersions(vaultId: string, itemId: string | undefined) {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.versions(itemId ?? ''),
    queryFn: () => weldpassPasswords.listItemVersions(vaultId, itemId as string),
    select: (res) => res.data,
    enabled: Boolean(itemId),
  });
}

export function useRestoreWeldPassItem() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { vaultId: string; itemId: string; version: number }) =>
      weldpassPasswords.restoreItemVersion(input.vaultId, input.itemId, input.version),
    onSuccess: (_result, input) => {
      invalidateAfterItemWrite(qc, [input.vaultId]);
      qc.invalidateQueries({ queryKey: weldpassPasswordKeys.versions(input.itemId) });
    },
  });
}

export function useImportWeldPassItems() {
  const { weldpassPasswords } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { vaultId: string; content: string; format?: WeldPassImportFormat }) =>
      weldpassPasswords.importItems(input.vaultId, {
        content: input.content,
        format: input.format,
      }),
    onSuccess: (_result, input) => invalidateAfterItemWrite(qc, [input.vaultId]),
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Weak, reused and old passwords across the caller's vaults. Verdicts only. */
export function useWeldPassHealth() {
  const { weldpassPasswords } = useAppApi();

  return useQuery({
    queryKey: weldpassPasswordKeys.health(),
    queryFn: () => weldpassPasswords.passwordHealth(),
    select: (res) => res.data,
  });
}
