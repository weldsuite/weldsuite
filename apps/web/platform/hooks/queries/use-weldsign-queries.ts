/**
 * WeldSign hooks: the envelope list, one envelope, and the draft mutations
 * (documents, recipients, fields). Keys build on `weldsignKeys.all`, which the
 * realtime sync map invalidates on every `sign_envelope` event.
 *
 * PDF bytes live under their own root (`weldsignDocumentKeys`): a document's
 * content never changes, so an envelope event must not refetch it, and it is
 * kept out of the persisted cache.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateSignEnvelopeInput,
  CreateSignRecipientInput,
  SignEnvelopeDetail,
  SignEnvelopeFolder,
  SignFieldInput,
  UpdateSignEnvelopeInput,
  UpdateSignRecipientInput,
} from '@weldsuite/app-api-client/schemas/weldsign';

export const weldsignKeys = {
  all: ['weldsign'] as const,
  lists: () => [...weldsignKeys.all, 'list'] as const,
  list: (folder: SignEnvelopeFolder, search: string) => [...weldsignKeys.lists(), folder, search] as const,
  envelope: (id: string) => [...weldsignKeys.all, 'envelope', id] as const,
};

export const weldsignDocumentKeys = {
  content: (documentId: string) => ['weldsign-document', documentId] as const,
};

const PAGE_SIZE = 50;

export function useSignEnvelopes(folder: SignEnvelopeFolder, search = '') {
  const { weldsign } = useAppApi();
  const query = useInfiniteQuery({
    queryKey: weldsignKeys.list(folder, search),
    queryFn: ({ pageParam }) => weldsign.list({ folder, search: search || undefined, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
  });
  return { ...query, envelopes: query.data?.pages.flatMap((page) => page.data) ?? [] };
}

export function useSignEnvelope(id: string) {
  const { weldsign } = useAppApi();
  return useQuery({
    queryKey: weldsignKeys.envelope(id),
    queryFn: () => weldsign.get(id),
    select: (res) => res.data,
  });
}

/** A document's PDF bytes, for pdf.js. */
export function useSignDocumentContent(envelopeId: string, documentId: string | null) {
  const { weldsign } = useAppApi();
  return useQuery({
    queryKey: weldsignDocumentKeys.content(documentId ?? ''),
    queryFn: async () => {
      const res = await weldsign.documentContent(envelopeId, documentId!);
      if (!res.ok) throw new Error(`Could not load the document (${res.status})`);
      return res.arrayBuffer();
    },
    enabled: !!documentId,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    meta: { persist: false },
  });
}

/** Every draft mutation refreshes the envelope and the lists it appears in. */
function useInvalidateEnvelope() {
  const queryClient = useQueryClient();
  return (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: weldsignKeys.envelope(id) }),
      queryClient.invalidateQueries({ queryKey: weldsignKeys.lists() }),
    ]);
}

export function useCreateSignEnvelope() {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSignEnvelopeInput) => weldsign.create(input).then((res) => res.data),
    onSuccess: (envelope) => {
      queryClient.setQueryData(weldsignKeys.envelope(envelope.id), { data: envelope });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.lists() });
    },
  });
}

export function useUpdateSignEnvelope(id: string) {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSignEnvelopeInput) => weldsign.update(id, input).then((res) => res.data),
    onSuccess: (envelope) => {
      queryClient.setQueryData(weldsignKeys.envelope(id), { data: envelope });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.lists() });
    },
  });
}

export function useDeleteSignEnvelope() {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldsign.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldsignKeys.envelope(id) });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.lists() });
    },
  });
}

export function useSignDocumentMutations(envelopeId: string) {
  const { weldsign } = useAppApi();
  const invalidate = useInvalidateEnvelope();
  const done = () => invalidate(envelopeId);
  return {
    upload: useMutation({
      mutationFn: (file: File) => weldsign.uploadDocument(envelopeId, file).then((res) => res.data),
      onSettled: done,
    }),
    reorder: useMutation({
      mutationFn: (documentIds: string[]) => weldsign.reorderDocuments(envelopeId, { documentIds }),
      onSettled: done,
    }),
    remove: useMutation({
      mutationFn: (documentId: string) => weldsign.removeDocument(envelopeId, documentId),
      onSettled: done,
    }),
  };
}

export function useSignRecipientMutations(envelopeId: string) {
  const { weldsign } = useAppApi();
  const invalidate = useInvalidateEnvelope();
  const done = () => invalidate(envelopeId);
  return {
    add: useMutation({
      mutationFn: (input: CreateSignRecipientInput) => weldsign.addRecipient(envelopeId, input).then((res) => res.data),
      onSettled: done,
    }),
    update: useMutation({
      mutationFn: ({ recipientId, input }: { recipientId: string; input: UpdateSignRecipientInput }) =>
        weldsign.updateRecipient(envelopeId, recipientId, input).then((res) => res.data),
      onSettled: done,
    }),
    remove: useMutation({
      mutationFn: (recipientId: string) => weldsign.removeRecipient(envelopeId, recipientId),
      onSettled: done,
    }),
  };
}

/**
 * Save the whole field set. `onError` lives on the mutation, not on `mutate`,
 * so it still fires for the save made when the fields step unmounts.
 */
export function useSaveSignFields(envelopeId: string, onError?: (error: unknown) => void) {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fields: SignFieldInput[]) => weldsign.replaceFields(envelopeId, { fields }).then((res) => res.data),
    onError,
    onSuccess: (fields) => {
      queryClient.setQueryData<{ data: SignEnvelopeDetail }>(weldsignKeys.envelope(envelopeId), (old) =>
        old ? { data: { ...old.data, fields } } : old,
      );
    },
  });
}
