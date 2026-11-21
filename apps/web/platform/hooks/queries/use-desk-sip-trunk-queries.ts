/**
 * WeldDesk phone: the customer's own phone system (SIP trunk / PBX such as
 * Xelion or Dstny), `/api/desk/phone/sip-trunks` (call-api). The password of a
 * trunk that signs in with a login is in the answer of `create` and
 * `rotate-password` only.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddDeskSipTrunkNumberInput,
  CreateDeskSipTrunkInput,
  DeskSipTrunk,
  DeskSipTrunkCreated,
  DeskSipTrunkCredentials,
  DeskSipTrunkNumber,
  DeskSipVerificationMethod,
  UpdateDeskSipTrunkInput,
} from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { deskPhoneSettingsKeys } from './use-desk-phone-settings-queries';

export type { DeskSipTrunk, DeskSipTrunkCreated, DeskSipTrunkCredentials, DeskSipTrunkNumber };

const BASE = '/desk/phone/sip-trunks';

export const deskSipTrunkKeys = {
  all: ['desk', 'phone', 'sip-trunks'] as const,
  list: () => [...deskSipTrunkKeys.all, 'list'] as const,
};

/** The error code of a refused call (`number_taken`, `wrong_code`, ...), when the answer carried one. */
export function sipTrunkErrorCode(err: unknown): string | null {
  const body = (err as { body?: { error?: { code?: unknown } } } | null)?.body;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : null;
}

/** The workspace's connected phone systems with their numbers. */
export function useDeskSipTrunks() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskSipTrunkKeys.list(),
    queryFn: async (): Promise<DeskSipTrunk[]> => {
      const client = await getClient();
      const res = await client.get<{ data: DeskSipTrunk[] }>(BASE);
      return res.data ?? [];
    },
  });
}

/** Changes to a trunk or its numbers show in the trunk list and in the numbers of the phone settings. */
function useInvalidateSipTrunks() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: deskSipTrunkKeys.all }),
      qc.invalidateQueries({ queryKey: deskPhoneSettingsKeys.numbers() }),
    ]);
}

export function useCreateDeskSipTrunk() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSipTrunks();
  return useMutation({
    mutationFn: async (input: CreateDeskSipTrunkInput): Promise<DeskSipTrunkCreated> => {
      const client = await getClient();
      const res = await client.post<{ data: DeskSipTrunkCreated }>(BASE, input);
      return res.data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateDeskSipTrunk() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSipTrunks();
  return useMutation({
    mutationFn: async (args: { id: string; input: UpdateDeskSipTrunkInput }): Promise<DeskSipTrunk> => {
      const client = await getClient();
      const res = await client.patch<{ data: DeskSipTrunk }>(`${BASE}/${args.id}`, args.input);
      return res.data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteDeskSipTrunk() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSipTrunks();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`${BASE}/${id}`);
    },
    onSuccess: () => invalidate(),
  });
}

/** A new password for a trunk that signs in with a login; shown once. */
export function useRotateDeskSipTrunkPassword() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (id: string): Promise<DeskSipTrunkCredentials> => {
      const client = await getClient();
      const res = await client.post<{ data: { credentials: DeskSipTrunkCredentials } }>(
        `${BASE}/${id}/rotate-password`,
        {},
      );
      return res.data.credentials;
    },
  });
}

export function useAddDeskSipTrunkNumber() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSipTrunks();
  return useMutation({
    mutationFn: async (args: { trunkId: string; input: AddDeskSipTrunkNumberInput }): Promise<DeskSipTrunkNumber> => {
      const client = await getClient();
      const res = await client.post<{ data: DeskSipTrunkNumber }>(`${BASE}/${args.trunkId}/numbers`, args.input);
      return res.data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useRemoveDeskSipTrunkNumber() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSipTrunks();
  return useMutation({
    mutationFn: async (args: { trunkId: string; numberId: string }) => {
      const client = await getClient();
      await client.delete(`${BASE}/${args.trunkId}/numbers/${args.numberId}`);
    },
    onSuccess: () => invalidate(),
  });
}

/** Ask for the code of a number's caller id verification, by call or SMS. */
export function useStartDeskSipVerification() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (args: { trunkId: string; numberId: string; method: DeskSipVerificationMethod }) => {
      const client = await getClient();
      const res = await client.post<{ data: { method: DeskSipVerificationMethod; phoneNumber: string } }>(
        `${BASE}/${args.trunkId}/numbers/${args.numberId}/verification`,
        { method: args.method },
      );
      return res.data;
    },
  });
}

export function useConfirmDeskSipVerification() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSipTrunks();
  return useMutation({
    mutationFn: async (args: { trunkId: string; numberId: string; code: string }): Promise<DeskSipTrunkNumber> => {
      const client = await getClient();
      const res = await client.post<{ data: DeskSipTrunkNumber }>(
        `${BASE}/${args.trunkId}/numbers/${args.numberId}/verification/confirm`,
        { code: args.code },
      );
      return res.data;
    },
    onSuccess: () => invalidate(),
  });
}
