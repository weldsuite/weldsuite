/**
 * WeldSign hooks: the envelope list, one envelope, the draft mutations
 * (documents, recipients, fields), a sent request's lifecycle (void, remind,
 * resend, correct an email, activity, "Sign now") and templates. Keys build on
 * `weldsignKeys.all`, which the realtime sync map invalidates on every
 * `sign_envelope` and `sign_template` event.
 *
 * A template is stored as an envelope, so the editor's documents, fields and
 * settings hooks take a `SignTarget` ({ kind, id }) that picks the envelope or
 * the template API and the matching query keys; the editor steps themselves
 * are the same for both.
 *
 * PDF bytes live under their own root (`weldsignDocumentKeys`): a document's
 * content never changes, so an envelope event must not refetch it, and it is
 * kept out of the persisted cache.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CorrectSignRecipientInput,
  CreateSignEnvelopeInput,
  CreateSignRecipientInput,
  CreateSignTemplateInput,
  CreateSignTemplateRoleInput,
  SignEnvelopeDetail,
  SignEnvelopeFolder,
  SignEnvelopeKind,
  SignFieldInput,
  SendSignEnvelopeInput,
  UpdateSignRecipientInput,
  UpdateSignTemplateInput,
  UpdateSignTemplateRoleInput,
  UseSignTemplateInput,
  VoidSignEnvelopeInput,
} from '@weldsuite/app-api-client/schemas/weldsign';

export const weldsignKeys = {
  all: ['weldsign'] as const,
  lists: () => [...weldsignKeys.all, 'list'] as const,
  list: (folder: SignEnvelopeFolder, search: string) => [...weldsignKeys.lists(), folder, search] as const,
  envelope: (id: string) => [...weldsignKeys.all, 'envelope', id] as const,
  /** Nested under the envelope: invalidating the envelope refreshes its activity too. */
  events: (id: string) => [...weldsignKeys.envelope(id), 'events'] as const,
  templateLists: () => [...weldsignKeys.all, 'template-list'] as const,
  templateList: (search: string) => [...weldsignKeys.templateLists(), search] as const,
  template: (id: string) => [...weldsignKeys.all, 'template', id] as const,
};

/** What the editor's shared hooks work on: a request, or a template (which is stored as one). */
export interface SignTarget {
  kind: SignEnvelopeKind;
  id: string;
}

export const envelopeTarget = (id: string): SignTarget => ({ kind: 'envelope', id });
export const templateTarget = (id: string): SignTarget => ({ kind: 'template', id });
/** The target of a loaded detail: its `kind` says which API serves it. */
export const targetOf = (detail: Pick<SignEnvelopeDetail, 'kind' | 'id'>): SignTarget => ({ kind: detail.kind, id: detail.id });

/** Query key of the target's detail. */
export function signTargetKey(target: SignTarget) {
  return target.kind === 'template' ? weldsignKeys.template(target.id) : weldsignKeys.envelope(target.id);
}

/** Query key of the lists the target appears in. */
function signTargetListsKey(target: SignTarget) {
  return target.kind === 'template' ? weldsignKeys.templateLists() : weldsignKeys.lists();
}

/**
 * The settings a draft and a template share. An envelope's expiry is chosen
 * when it is sent, so the editor never changes it; a template has none.
 */
export type SignSettingsInput = UpdateSignTemplateInput;

/**
 * The API a target's documents, fields and settings go through. Both objects
 * have the same methods for those, so callers use them without branching.
 */
function useScopedSignApi(target: SignTarget) {
  const { weldsign } = useAppApi();
  return target.kind === 'template' ? weldsign.templates : weldsign;
}

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
export function useSignDocumentContent(target: SignTarget, documentId: string | null) {
  const api = useScopedSignApi(target);
  return useQuery({
    queryKey: weldsignDocumentKeys.content(documentId ?? ''),
    queryFn: async () => {
      const res = await api.documentContent(target.id, documentId!);
      if (!res.ok) throw new Error(`Could not load the document (${res.status})`);
      return res.arrayBuffer();
    },
    enabled: !!documentId,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    meta: { persist: false },
  });
}

/** Every draft or template mutation refreshes what it changed and the lists it appears in. */
function useInvalidateTarget() {
  const queryClient = useQueryClient();
  return (target: SignTarget) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: signTargetKey(target) }),
      queryClient.invalidateQueries({ queryKey: signTargetListsKey(target) }),
    ]);
}

function useInvalidateEnvelope() {
  const invalidate = useInvalidateTarget();
  return (id: string) => invalidate(envelopeTarget(id));
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

/** Title, message, signing order and reminders of a draft or a template. */
export function useUpdateSignEnvelope(target: SignTarget) {
  const api = useScopedSignApi(target);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SignSettingsInput) => api.update(target.id, input).then((res) => res.data),
    onSuccess: (detail) => {
      queryClient.setQueryData(signTargetKey(target), { data: detail });
      void queryClient.invalidateQueries({ queryKey: signTargetListsKey(target) });
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

export function useSignDocumentMutations(target: SignTarget) {
  const api = useScopedSignApi(target);
  const invalidate = useInvalidateTarget();
  const done = () => invalidate(target);
  return {
    upload: useMutation({
      mutationFn: (file: File) => api.uploadDocument(target.id, file).then((res) => res.data),
      onSettled: done,
    }),
    reorder: useMutation({
      mutationFn: (documentIds: string[]) => api.reorderDocuments(target.id, { documentIds }),
      onSettled: done,
    }),
    remove: useMutation({
      mutationFn: (documentId: string) => api.removeDocument(target.id, documentId),
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
export function useSaveSignFields(target: SignTarget, onError?: (error: unknown) => void) {
  const api = useScopedSignApi(target);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fields: SignFieldInput[]) => api.replaceFields(target.id, { fields }).then((res) => res.data),
    onError,
    onSuccess: (fields) => {
      queryClient.setQueryData<{ data: SignEnvelopeDetail }>(signTargetKey(target), (old) =>
        old ? { data: { ...old.data, fields } } : old,
      );
    },
  });
}

export function useSendSignEnvelope(id: string) {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendSignEnvelopeInput) => weldsign.send(id, input).then((res) => res.data),
    onSuccess: (envelope) => {
      queryClient.setQueryData(weldsignKeys.envelope(id), { data: envelope });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.lists() });
    },
  });
}

/** Save the signed PDF of a completed request to the user's device. */
export function useDownloadSignedPdf(id: string) {
  const { weldsign } = useAppApi();
  return useMutation({
    mutationFn: async (title: string) => {
      const res = await weldsign.download(id);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'signed'}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
}

// ---------------------------------------------------------------------------
// A sent request: activity and lifecycle actions
// ---------------------------------------------------------------------------

/**
 * A request's activity (the evidence trail), oldest first. Owners only: anyone
 * else gets a 404, so callers pass `enabled: envelope.isOwner`. Names and IP
 * addresses stay out of the persisted query cache.
 */
export function useSignEnvelopeEvents(id: string, enabled: boolean) {
  const { weldsign } = useAppApi();
  return useQuery({
    queryKey: weldsignKeys.events(id),
    queryFn: () => weldsign.events(id),
    select: (res) => res.data,
    enabled,
    meta: { persist: false },
  });
}

/**
 * The lifecycle mutations below refresh the envelope, its activity and the
 * lists whether they worked or not: a 409 means the request is no longer open,
 * and the refetch takes its buttons away. `onError` lives on the mutation, not
 * on `mutate`, so a toast still shows when the page was left in the meantime.
 */
type ErrorHandler = (error: unknown) => void;

/** Stop a sent request; signers who already got it are told, with the reason. */
export function useVoidSignEnvelope(id: string, onError?: ErrorHandler) {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateEnvelope();
  return useMutation({
    mutationFn: (input: VoidSignEnvelopeInput) => weldsign.voidEnvelope(id, input).then((res) => res.data),
    onError,
    onSuccess: (envelope) => queryClient.setQueryData(weldsignKeys.envelope(id), { data: envelope }),
    onSettled: () => invalidate(id),
  });
}

/** Remind every signer whose turn it is; resolves to how many were reminded. */
export function useRemindSignEnvelope(id: string, onError?: ErrorHandler) {
  const { weldsign } = useAppApi();
  const invalidate = useInvalidateEnvelope();
  return useMutation({
    mutationFn: () => weldsign.remind(id).then((res) => res.data.reminded),
    onError,
    onSettled: () => invalidate(id),
  });
}

/** Email a signer whose turn it is a new link. Takes the recipient id. */
export function useResendSignRecipient(id: string, onError?: ErrorHandler) {
  const { weldsign } = useAppApi();
  const invalidate = useInvalidateEnvelope();
  return useMutation({
    mutationFn: (recipientId: string) => weldsign.resendRecipient(id, recipientId).then((res) => res.data),
    onError,
    onSettled: () => invalidate(id),
  });
}

/** Fix a recipient's name or email; a signer whose turn it is gets a new link and the old one stops working. */
export function useCorrectSignRecipient(id: string, onError?: ErrorHandler) {
  const { weldsign } = useAppApi();
  const invalidate = useInvalidateEnvelope();
  return useMutation({
    mutationFn: ({ recipientId, input }: { recipientId: string; input: CorrectSignRecipientInput }) =>
      weldsign.correctRecipient(id, recipientId, input).then((res) => res.data),
    onError,
    onSettled: () => invalidate(id),
  });
}

/** A fresh link for the caller's own turn ("Sign now"); resolves to the URL. */
export function useSignSigningLink(id: string, onError?: ErrorHandler) {
  const { weldsign } = useAppApi();
  return useMutation({
    mutationFn: () => weldsign.signingLink(id).then((res) => res.data.url),
    onError,
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * The template list. `enabled` keeps it quiet for a member who may not read
 * templates (the server would answer 403).
 */
export function useSignTemplates(search = '', enabled = true) {
  const { weldsign } = useAppApi();
  const query = useInfiniteQuery({
    queryKey: weldsignKeys.templateList(search),
    queryFn: ({ pageParam }) => weldsign.templates.list({ search: search || undefined, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled,
  });
  return { ...query, templates: query.data?.pages.flatMap((page) => page.data) ?? [] };
}

/** One template: a `SignEnvelopeDetail` of kind `template`, its roles as the recipient list. */
export function useSignTemplate(id: string, enabled = true) {
  const { weldsign } = useAppApi();
  return useQuery({
    queryKey: weldsignKeys.template(id),
    queryFn: () => weldsign.templates.get(id),
    select: (res) => res.data,
    enabled,
  });
}

export function useCreateSignTemplate() {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSignTemplateInput) => weldsign.templates.create(input).then((res) => res.data),
    onSuccess: (template) => {
      queryClient.setQueryData(weldsignKeys.template(template.id), { data: template });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.templateLists() });
    },
  });
}

export function useDeleteSignTemplate() {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldsign.templates.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldsignKeys.template(id) });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.templateLists() });
    },
  });
}

/** The roles of a template: add, change and remove (removing a role removes its fields). */
export function useSignTemplateRoleMutations(templateId: string) {
  const { weldsign } = useAppApi();
  const invalidate = useInvalidateTarget();
  const done = () => invalidate(templateTarget(templateId));
  return {
    add: useMutation({
      mutationFn: (input: CreateSignTemplateRoleInput) => weldsign.templates.addRole(templateId, input).then((res) => res.data),
      onSettled: done,
    }),
    update: useMutation({
      mutationFn: ({ roleId, input }: { roleId: string; input: UpdateSignTemplateRoleInput }) =>
        weldsign.templates.updateRole(templateId, roleId, input).then((res) => res.data),
      onSettled: done,
    }),
    remove: useMutation({
      mutationFn: (roleId: string) => weldsign.templates.removeRole(templateId, roleId),
      onSettled: done,
    }),
  };
}

/**
 * Make a draft request from a template (a person in every role). It resolves
 * to the new draft's detail, which is put in the cache so its editor opens
 * without a second round trip.
 */
export function useUseSignTemplate(templateId: string) {
  const { weldsign } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UseSignTemplateInput) => weldsign.templates.use(templateId, input).then((res) => res.data),
    onSuccess: (envelope) => {
      queryClient.setQueryData(weldsignKeys.envelope(envelope.id), { data: envelope });
      void queryClient.invalidateQueries({ queryKey: weldsignKeys.lists() });
    },
  });
}
