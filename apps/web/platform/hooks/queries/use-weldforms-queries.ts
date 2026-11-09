/**
 * WeldForms hooks: the form list and one form, the draft and lifecycle
 * mutations (update, duplicate, delete, publish, close, reopen, discard),
 * versions, access, folders, themes, workspace settings, usage, media upload,
 * the member's own notification subscription and the AI helpers.
 *
 * Every key sits under `weldformsKeys.all`, the root the realtime sync map
 * invalidates for the `form*` entity events (lib/realtime/sync-map.ts). The
 * factory also names the keys of the results, invitations and integrations
 * queries so the pages of the second half of the module share one cache.
 *
 * The builder keeps its own copy of the draft (see
 * app/weldforms/form/editor-context.tsx) and writes saves into the cache with
 * `setQueryData`, so a refetch caused by a realtime event never overwrites what
 * someone is typing.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateFormFolderInput,
  CreateFormInput,
  CreateFormThemeInput,
  DuplicateFormInput,
  FormDetail,
  FormSubscription,
  GenerateFormInput,
  ListFormsQuery,
  SetFormAccessInput,
  SuggestBlocksInput,
  UpdateFormFolderInput,
  UpdateFormInput,
  UpdateFormsWorkspaceSettingsInput,
  UpdateFormThemeInput,
} from '@weldsuite/app-api-client/schemas/weldforms';

export const weldformsKeys = {
  all: ['weldforms'] as const,
  lists: () => [...weldformsKeys.all, 'list'] as const,
  list: (params: ListFormsQuery) => [...weldformsKeys.lists(), params] as const,
  form: (id: string) => [...weldformsKeys.all, 'form', id] as const,
  /** Nested under the form: invalidating the form refreshes what hangs off it. */
  versions: (id: string) => [...weldformsKeys.form(id), 'versions'] as const,
  version: (id: string, versionId: string) => [...weldformsKeys.versions(id), versionId] as const,
  access: (id: string) => [...weldformsKeys.form(id), 'access'] as const,
  subscription: (id: string) => [...weldformsKeys.form(id), 'subscription'] as const,
  responses: (id: string) => [...weldformsKeys.form(id), 'responses'] as const,
  responseList: (id: string, params: unknown) => [...weldformsKeys.responses(id), 'list', params] as const,
  response: (id: string, responseId: string) => [...weldformsKeys.responses(id), 'detail', responseId] as const,
  columns: (id: string) => [...weldformsKeys.form(id), 'columns'] as const,
  summary: (id: string, params: unknown) => [...weldformsKeys.form(id), 'summary', params] as const,
  insights: (id: string, params: unknown) => [...weldformsKeys.form(id), 'insights', params] as const,
  invitations: (id: string) => [...weldformsKeys.form(id), 'invitations'] as const,
  integrations: (id: string) => [...weldformsKeys.form(id), 'integrations'] as const,
  folders: () => [...weldformsKeys.all, 'folders'] as const,
  themes: () => [...weldformsKeys.all, 'themes'] as const,
  settings: () => [...weldformsKeys.all, 'settings'] as const,
  usage: () => [...weldformsKeys.all, 'usage'] as const,
};

const PAGE_SIZE = 50;

/** The AI endpoints answer 503 `ai_unavailable` on the Kubernetes editions: the UI hides those entry points. */
export function isAiUnavailable(err: unknown): boolean {
  if (!isApiError(err) || err.status !== 503) return false;
  const body = err.body as { error?: { code?: string } } | undefined;
  const code = body?.error?.code;
  return code === undefined || code.toLowerCase() === 'ai_unavailable';
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function useForms(params: Omit<ListFormsQuery, 'cursor'> = {}) {
  const { weldforms } = useAppApi();
  const query = useInfiniteQuery({
    queryKey: weldformsKeys.list(params),
    queryFn: ({ pageParam }) => weldforms.list({ ...params, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
  });
  return { ...query, forms: query.data?.pages.flatMap((page) => page.data) ?? [] };
}

export function useForm(id: string) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.form(id),
    queryFn: () => weldforms.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useCreateForm() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFormInput) => weldforms.create(input),
    onSuccess: (res) => {
      queryClient.setQueryData(weldformsKeys.form(res.data.id), res);
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() });
    },
  });
}

/** A raw draft save. The builder's autosave uses it and handles the 409 itself. */
export function useUpdateForm(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFormInput) => weldforms.update(id, input),
    onSuccess: (res) => {
      queryClient.setQueryData(weldformsKeys.form(id), res);
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
    },
  });
}

/** Moves a form to a folder (or to none) from the home page, without opening the builder. */
export function useMoveForm() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, folderId }: { id: string; folderId: string | null }) => {
      const current = await weldforms.get(id);
      return weldforms.update(id, { revision: current.data.revision, folderId });
    },
    onSuccess: (res) => {
      queryClient.setQueryData(weldformsKeys.form(res.data.id), res);
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() });
    },
  });
}

export function useDuplicateForm() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & DuplicateFormInput) => weldforms.duplicate(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() });
    },
  });
}

export function useDeleteForm() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldforms.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldformsKeys.form(id) });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.usage() });
    },
  });
}

/** Lifecycle calls answer with the form (publish with the version too); the cache takes the form. */
function useLifecycle<R extends { data: FormDetail | { form: FormDetail } }>(call: (id: string) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (res) => {
      const form = 'form' in res.data ? res.data.form : res.data;
      queryClient.setQueryData(weldformsKeys.form(form.id), { data: form });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.versions(form.id) });
    },
  });
}

export function usePublishForm() {
  const { weldforms } = useAppApi();
  return useLifecycle((id: string) => weldforms.publish(id));
}

export function useCloseForm() {
  const { weldforms } = useAppApi();
  return useLifecycle((id: string) => weldforms.close(id));
}

export function useReopenForm() {
  const { weldforms } = useAppApi();
  return useLifecycle((id: string) => weldforms.reopen(id));
}

export function useDiscardFormChanges() {
  const { weldforms } = useAppApi();
  return useLifecycle((id: string) => weldforms.discardChanges(id));
}

export function useFormVersions(id: string) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.versions(id),
    queryFn: () => weldforms.versions(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useFormAccess(id: string, enabled = true) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.access(id),
    queryFn: () => weldforms.access(id),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

export function useSetFormAccess(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetFormAccessInput) => weldforms.setAccess(id, input),
    onSuccess: (res) => {
      queryClient.setQueryData(weldformsKeys.access(id), res);
    },
  });
}

export function useFormSubscription(id: string) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.subscription(id),
    queryFn: () => weldforms.subscription(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useSetFormSubscription(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FormSubscription) => weldforms.setSubscription(id, input),
    onSuccess: (res) => {
      queryClient.setQueryData(weldformsKeys.subscription(id), res);
    },
  });
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function useFormFolders() {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.folders(),
    queryFn: () => weldforms.folders(),
    select: (res) => res.data,
  });
}

export function useCreateFormFolder() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFormFolderInput) => weldforms.createFolder(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() }),
  });
}

export function useUpdateFormFolder() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateFormFolderInput) => weldforms.updateFolder(id, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() }),
  });
}

export function useDeleteFormFolder() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldforms.deleteFolder(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.folders() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.lists() });
    },
  });
}

// ---------------------------------------------------------------------------
// Themes, settings, usage
// ---------------------------------------------------------------------------

export function useFormThemes() {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.themes(),
    queryFn: () => weldforms.themes(),
    select: (res) => res.data,
  });
}

export function useCreateFormTheme() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFormThemeInput) => weldforms.createTheme(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.themes() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.settings() });
    },
  });
}

export function useUpdateFormTheme() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateFormThemeInput) => weldforms.updateTheme(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.themes() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.settings() });
    },
  });
}

export function useDeleteFormTheme() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldforms.deleteTheme(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.themes() });
      void queryClient.invalidateQueries({ queryKey: weldformsKeys.settings() });
    },
  });
}

export function useFormsSettings() {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.settings(),
    queryFn: () => weldforms.settings(),
    select: (res) => res.data,
  });
}

export function useUpdateFormsSettings() {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFormsWorkspaceSettingsInput) => weldforms.updateSettings(input),
    onSuccess: (res) => queryClient.setQueryData(weldformsKeys.settings(), res),
  });
}

export function useFormsUsage() {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.usage(),
    queryFn: () => weldforms.usage(),
    select: (res) => res.data,
  });
}

/** Uploads an image for a question, a choice or a theme; resolves to its public URL. */
export function useUploadFormMedia() {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: async (file: File) => (await weldforms.uploadMedia(file)).data,
  });
}

// ---------------------------------------------------------------------------
// AI (hidden when the API answers 503 `ai_unavailable`)
// ---------------------------------------------------------------------------

export function useGenerateForm() {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: async (input: GenerateFormInput) => (await weldforms.generate(input)).data,
  });
}

export function useSuggestFormBlocks() {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: async (input: SuggestBlocksInput) => (await weldforms.suggestBlocks(input)).data,
  });
}
