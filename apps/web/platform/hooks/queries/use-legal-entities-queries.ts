/**
 * Legal entities (Settings → Legal entities, the WeldBooks and WeldHR entity
 * switchers): the workspace's companies, their registrations and bank
 * accounts, and per-entity access. Served by app-api `/api/legal-entities`.
 *
 * Every write invalidates the whole `legal-entities` tree for the workspace:
 * the switchers, the "Used by" panel and `my-access` all derive from it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { useWorkspaceId } from '@/contexts/workspace-context';
import type {
  CreateBankAccountInput,
  CreateLegalEntityInput,
  CreateRegistrationInput,
  LegalEntityApp,
  UpdateBankAccountInput,
  UpdateLegalEntityInput,
  UpdateRegistrationInput,
} from '@weldsuite/app-api-client/schemas/legal-entities';

export const legalEntityKeys = {
  all: (workspaceId: string | null | undefined) => ['legal-entities', workspaceId ?? 'none'] as const,
  list: (workspaceId: string | null | undefined, app?: LegalEntityApp, includeArchived?: boolean) =>
    [...legalEntityKeys.all(workspaceId), 'list', app ?? 'all', includeArchived ? 'archived' : 'active'] as const,
  detail: (workspaceId: string | null | undefined, id: string) => [...legalEntityKeys.all(workspaceId), 'detail', id] as const,
  usage: (workspaceId: string | null | undefined, id: string) => [...legalEntityKeys.all(workspaceId), 'usage', id] as const,
  registrations: (workspaceId: string | null | undefined, id: string) =>
    [...legalEntityKeys.all(workspaceId), 'registrations', id] as const,
  bankAccounts: (workspaceId: string | null | undefined, id: string) =>
    [...legalEntityKeys.all(workspaceId), 'bank-accounts', id] as const,
  access: (workspaceId: string | null | undefined, id: string) => [...legalEntityKeys.all(workspaceId), 'access', id] as const,
  myAccess: (workspaceId: string | null | undefined, id: string) => [...legalEntityKeys.all(workspaceId), 'my-access', id] as const,
};

function useInvalidateLegalEntities() {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  return () => qc.invalidateQueries({ queryKey: legalEntityKeys.all(workspaceId) });
}

/** Entities the signed-in member sees (optionally only those an app is enabled for). */
export function useLegalEntities(options: { app?: LegalEntityApp; includeArchived?: boolean; enabled?: boolean } = {}) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.list(workspaceId, options.app, options.includeArchived),
    queryFn: () => legalEntities.list({ app: options.app, includeArchived: options.includeArchived }),
    select: (res) => res.data,
    enabled: options.enabled ?? true,
  });
}

export function useLegalEntity(id: string | null | undefined) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.detail(workspaceId, id ?? ''),
    queryFn: () => legalEntities.get(id as string),
    select: (res) => res.data,
    enabled: Boolean(id),
  });
}

export function useLegalEntityUsage(id: string | null | undefined) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.usage(workspaceId, id ?? ''),
    queryFn: () => legalEntities.usage(id as string),
    select: (res) => res.data,
    enabled: Boolean(id),
  });
}

export function useLegalEntityRegistrations(id: string | null | undefined) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.registrations(workspaceId, id ?? ''),
    queryFn: () => legalEntities.listRegistrations(id as string),
    select: (res) => res.data,
    enabled: Boolean(id),
  });
}

export function useLegalEntityBankAccounts(id: string | null | undefined) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.bankAccounts(workspaceId, id ?? ''),
    queryFn: () => legalEntities.listBankAccounts(id as string),
    select: (res) => res.data,
    enabled: Boolean(id),
  });
}

/** Who sees the entity and with which role (`legal_entities:manage`). */
export function useLegalEntityAccess(id: string | null | undefined, enabled = true) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.access(workspaceId, id ?? ''),
    queryFn: () => legalEntities.getAccess(id as string),
    select: (res) => res.data,
    enabled: Boolean(id) && enabled,
  });
}

/** The signed-in member's role and permissions inside one entity. */
export function useMyLegalEntityAccess(id: string | null | undefined) {
  const { legalEntities } = useAppApi();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: legalEntityKeys.myAccess(workspaceId, id ?? ''),
    queryFn: () => legalEntities.myAccess(id as string),
    select: (res) => res.data,
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useCreateLegalEntity() {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (input: CreateLegalEntityInput) => legalEntities.create(input).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdateLegalEntity() {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLegalEntityInput }) =>
      legalEntities.update(id, input).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useMakeDefaultLegalEntity() {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (id: string) => legalEntities.makeDefault(id).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useArchiveLegalEntity() {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      (archived ? legalEntities.archive(id) : legalEntities.unarchive(id)).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteLegalEntity() {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (id: string) => legalEntities.delete(id),
    onSuccess: invalidate,
  });
}

export function useSaveRegistration(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (args: { id?: string; create?: CreateRegistrationInput; update?: UpdateRegistrationInput }) =>
      args.id
        ? legalEntities.updateRegistration(entityId, args.id, args.update ?? {}).then((r) => r.data)
        : legalEntities.createRegistration(entityId, args.create as CreateRegistrationInput).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteRegistration(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (registrationId: string) => legalEntities.deleteRegistration(entityId, registrationId),
    onSuccess: invalidate,
  });
}

export function useSaveBankAccount(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (args: { id?: string; create?: CreateBankAccountInput; update?: UpdateBankAccountInput }) =>
      args.id
        ? legalEntities.updateBankAccount(entityId, args.id, args.update ?? {}).then((r) => r.data)
        : legalEntities.createBankAccount(entityId, args.create as CreateBankAccountInput).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteBankAccount(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (accountId: string) => legalEntities.deleteBankAccount(entityId, accountId),
    onSuccess: invalidate,
  });
}

/** Reveal is not cached: the number is shown once and every reveal is logged. */
export function useRevealBankAccountNumber(entityId: string) {
  const { legalEntities } = useAppApi();
  return useMutation({
    mutationFn: ({ accountId, reason }: { accountId: string; reason?: string }) =>
      legalEntities.revealBankAccountNumber(entityId, accountId, reason).then((r) => r.data),
  });
}

export function useSetLegalEntityRestricted(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (restricted: boolean) => legalEntities.setRestricted(entityId, restricted).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useSetLegalEntityMember(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string | null }) =>
      legalEntities.setMember(entityId, userId, roleId).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useRemoveLegalEntityMember(entityId: string) {
  const { legalEntities } = useAppApi();
  const invalidate = useInvalidateLegalEntities();
  return useMutation({
    mutationFn: (userId: string) => legalEntities.removeMember(entityId, userId),
    onSuccess: invalidate,
  });
}
