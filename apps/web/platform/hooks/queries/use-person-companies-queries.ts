/**
 * Mutations for the person ↔ company affiliation junction.
 *
 * Backed by `apps/workers/app-api` so the company / person panels can stay on a
 * single backend. Linking, updating, and unlinking each invalidate both
 * sides of the relationship so any open panel stays in sync.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { companyKeys } from '@/hooks/queries/use-companies-queries';
import { personKeys } from '@/hooks/queries/use-people-queries';
import type {
  CreatePersonCompanyInput,
  UpdatePersonCompanyInput,
} from '@weldsuite/core-api-client/schemas/person-companies';

function invalidateBothSides(
  qc: ReturnType<typeof useQueryClient>,
  personId?: string,
  companyId?: string,
) {
  if (personId) qc.invalidateQueries({ queryKey: personKeys.companies(personId) });
  if (companyId) qc.invalidateQueries({ queryKey: companyKeys.people(companyId) });
}

export function useLinkPersonToCompany() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePersonCompanyInput) => {
      const client = await getClient();
      return client.post(`/person-companies`, data);
    },
    onSuccess: (_, vars) => invalidateBothSides(qc, vars.personId, vars.companyId),
    onError: (err) => {
      console.error('[person-companies] link failed:', err);
      toast.error('Failed to link person');
    },
  });
}

function useUpdatePersonCompany() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: UpdatePersonCompanyInput;
      /** Optional invalidation hints — the API row doesn't include them. */
      personId?: string;
      companyId?: string;
    }) => {
      const client = await getClient();
      return client.patch(`/person-companies/${id}`, data);
    },
    onSuccess: (_, vars) => invalidateBothSides(qc, vars.personId, vars.companyId),
  });
}

export function useUnlinkPersonFromCompany() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
    }: {
      id: string;
      personId?: string;
      companyId?: string;
    }) => {
      const client = await getClient();
      return client.delete(`/person-companies/${id}`);
    },
    onSuccess: (_, vars) => invalidateBothSides(qc, vars.personId, vars.companyId),
    onError: (err) => {
      console.error('[person-companies] unlink failed:', err);
      toast.error('Failed to unlink person');
    },
  });
}
