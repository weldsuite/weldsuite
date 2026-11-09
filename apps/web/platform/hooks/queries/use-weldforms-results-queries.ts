/**
 * WeldForms hooks for the second half of the module: results (columns,
 * summary, insights, the responses list and one response, deleting, retrying
 * an integration action, export, files), AI summaries, invitations and
 * reminders, integrations, filling a members-only form and a person's
 * responses for the CRM Forms tab.
 *
 * Keys come from `weldformsKeys` in `use-weldforms-queries.ts`, so the realtime
 * sync map's invalidation of `weldformsKeys.all` refreshes these too, and a
 * mutation here only has to invalidate the form it touched.
 */

import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import { isAiUnavailable, weldformsKeys } from '@/hooks/queries/use-weldforms-queries';
import type {
  CreateFormInvitationsInput,
  FormAiSummary,
  FormIntegrationInput,
  ListFormInvitationsQuery,
  ListFormResponsesQuery,
  MemberSubmitInput,
  RemindFormInvitationsInput,
  ExportFormResponsesQuery,
  FormSummaryQuery,
  UpdateFormIntegrationInput,
} from '@weldsuite/app-api-client/schemas/weldforms';

const RESPONSES_PAGE = 50;
const INVITATIONS_PAGE = 50;

export const weldformsResultsKeys = {
  aiSummary: (id: string, blockId: string | null) => [...weldformsKeys.form(id), 'ai-summary', blockId ?? 'form'] as const,
  invitationList: (id: string, params: unknown) => [...weldformsKeys.invitations(id), 'list', params] as const,
  invitationStats: (id: string) => [...weldformsKeys.invitations(id), 'stats'] as const,
  fill: (publicId: string) => [...weldformsKeys.all, 'fill', publicId] as const,
  person: (personId: string) => [...weldformsKeys.all, 'person', personId] as const,
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function useFormColumns(id: string, enabled = true) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.columns(id),
    queryFn: () => weldforms.columns(id),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

export function useFormSummary(id: string, params: FormSummaryQuery, enabled = true) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.summary(id, params),
    queryFn: () => weldforms.summary(id, params),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

export function useFormInsights(id: string, params: { from?: string; to?: string }, enabled = true) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.insights(id, params),
    queryFn: () => weldforms.insights(id, params),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

export function useFormResponses(id: string, params: Omit<ListFormResponsesQuery, 'cursor' | 'limit'>, enabled = true) {
  const { weldforms } = useAppApi();
  const query = useInfiniteQuery({
    queryKey: weldformsKeys.responseList(id, params),
    queryFn: ({ pageParam }) => weldforms.responses(id, { ...params, limit: RESPONSES_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: enabled && id !== '',
  });
  const pages = query.data?.pages ?? [];
  return {
    ...query,
    responses: pages.flatMap((page) => page.data),
    totalCount: pages[0]?.pagination?.totalCount ?? null,
  };
}

export function useFormResponse(id: string, responseId: string | null) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.response(id, responseId ?? ''),
    queryFn: () => weldforms.response(id, responseId ?? ''),
    select: (res) => res.data,
    enabled: id !== '' && responseId !== null,
  });
}

/**
 * The definitions of the versions the loaded responses were given under, by
 * version id. A published version never changes, so each is fetched once.
 */
export function useVersionDefinitions(id: string, versionIds: string[]) {
  const { weldforms } = useAppApi();
  const results = useQueries({
    queries: versionIds.map((versionId) => ({
      queryKey: [...weldformsKeys.versions(id), 'definition', versionId] as const,
      queryFn: () => weldforms.version(id, versionId),
      select: (res: Awaited<ReturnType<typeof weldforms.version>>) => res.data.definition,
      staleTime: Infinity,
      enabled: id !== '',
    })),
  });
  const byVersion = new Map<string, NonNullable<(typeof results)[number]['data']>>();
  versionIds.forEach((versionId, index) => {
    const definition = results[index]?.data;
    if (definition) byVersion.set(versionId, definition);
  });
  return byVersion;
}

export function useDeleteFormResponse(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (responseId: string) => weldforms.deleteResponse(id, responseId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.form(id) }),
  });
}

export function useBulkDeleteFormResponses(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => weldforms.bulkDeleteResponses(id, { ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.form(id) }),
  });
}

export function useRetryResponseAction(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { responseId: string; actionId: string }) =>
      weldforms.retryResponseAction(id, input.responseId, input.actionId),
    onSuccess: (_res, input) => queryClient.invalidateQueries({ queryKey: weldformsKeys.response(id, input.responseId) }),
  });
}

/** Export as CSV or XLSX: resolves with the file bytes and the name the server suggested. */
export function useExportFormResponses(id: string) {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: async (params: ExportFormResponsesQuery) => {
      const res = await weldforms.exportResponses(id, params);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      return { blob: await res.blob(), filename: filenameFrom(res, `responses.${params.format}`) };
    },
  });
}

/** An uploaded file or signature of a response, as a blob to open or save. */
export function useFormResponseFile(id: string) {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: async (input: { responseId: string; fileId: string; fallbackName: string }) => {
      const res = await weldforms.responseFile(id, input.responseId, input.fileId);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      return { blob: await res.blob(), filename: filenameFrom(res, input.fallbackName) };
    },
  });
}

/** The file name in a `Content-Disposition` header, or the fallback. */
export function filenameFrom(res: Pick<Response, 'headers'>, fallback: string): string {
  const header = res.headers.get('content-disposition');
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}

/** Saves a blob through a temporary link. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// AI summaries (Global only: a 503 `ai_unavailable` hides the card)
// ---------------------------------------------------------------------------

export function useAiSummary(id: string, blockId: string | null, enabled = true) {
  const { weldforms } = useAppApi();
  // The Kubernetes editions have no AI: no request, the card stays hidden.
  const offered = isFeatureAvailable('forms-ai');
  const query = useQuery({
    queryKey: weldformsResultsKeys.aiSummary(id, blockId),
    queryFn: () => weldforms.aiSummary(id, blockId),
    select: (res) => res.data,
    enabled: offered && enabled && id !== '',
    retry: (count, err) => !isAiUnavailable(err) && count < 2,
  });
  return { ...query, unavailable: !offered || isAiUnavailable(query.error) };
}

export function useCreateAiSummary(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blockId: string | null) => weldforms.createAiSummary(id, { blockId }),
    onSuccess: (res, blockId) => {
      queryClient.setQueryData<{ data: FormAiSummary }>(weldformsResultsKeys.aiSummary(id, blockId), res);
    },
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export function useFormInvitations(id: string, params: Omit<ListFormInvitationsQuery, 'cursor' | 'limit'>, enabled = true) {
  const { weldforms } = useAppApi();
  const query = useInfiniteQuery({
    queryKey: weldformsResultsKeys.invitationList(id, params),
    queryFn: ({ pageParam }) => weldforms.invitations(id, { ...params, limit: INVITATIONS_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: enabled && id !== '',
  });
  return { ...query, invitations: query.data?.pages.flatMap((page) => page.data) ?? [] };
}

export function useFormInvitationStats(id: string, enabled = true) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsResultsKeys.invitationStats(id),
    queryFn: () => weldforms.invitationStats(id),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

export function useInviteToForm(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFormInvitationsInput) => weldforms.invite(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.invitations(id) }),
  });
}

export function useRemindInvitations(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RemindFormInvitationsInput) => weldforms.remind(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.invitations(id) }),
  });
}

export function useRevokeInvitation(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => weldforms.revokeInvitation(id, invitationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.invitations(id) }),
  });
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export function useFormIntegrations(id: string) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsKeys.integrations(id),
    queryFn: () => weldforms.integrations(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

export function useCreateFormIntegration(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FormIntegrationInput) => weldforms.createIntegration(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.integrations(id) }),
  });
}

export function useUpdateFormIntegration(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { integrationId: string; patch: UpdateFormIntegrationInput }) =>
      weldforms.updateIntegration(id, input.integrationId, input.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.integrations(id) }),
  });
}

export function useDeleteFormIntegration(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => weldforms.deleteIntegration(id, integrationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.integrations(id) }),
  });
}

export function useTestFormIntegration(id: string) {
  const { weldforms } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => weldforms.testIntegration(id, integrationId),
    // A test can set or clear the integration's last error.
    onSettled: () => queryClient.invalidateQueries({ queryKey: weldformsKeys.integrations(id) }),
  });
}

// ---------------------------------------------------------------------------
// Members-only forms
// ---------------------------------------------------------------------------

export function useMemberFill(publicId: string) {
  const { weldforms } = useAppApi();
  return useQuery({
    queryKey: weldformsResultsKeys.fill(publicId),
    queryFn: () => weldforms.fill(publicId),
    select: (res) => res.data,
    enabled: publicId !== '',
    // The definition must not change under someone who is filling it in.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useSubmitMemberFill(publicId: string) {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: (input: MemberSubmitInput) => weldforms.submitFill(publicId, input),
  });
}

// ---------------------------------------------------------------------------
// A person's responses (CRM Forms tab)
// ---------------------------------------------------------------------------

/**
 * A person's responses across every form the member may read, newest first, in
 * one call (`personResponses`): the rows the CRM Forms tab lists, each with the
 * title of its form.
 */
export function usePersonFormResponses(personId: string) {
  const { weldforms } = useAppApi();
  const query = useInfiniteQuery({
    queryKey: weldformsResultsKeys.person(personId),
    queryFn: ({ pageParam }) => weldforms.personResponses({ personId, limit: RESPONSES_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: personId !== '',
  });
  const rows = (query.data?.pages.flatMap((page) => page.data) ?? []).map(({ formTitle, ...response }) => ({
    form: { id: response.formId, title: formTitle },
    response,
  }));
  return {
    rows,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}

/** A file or signature for one field of a members-only form, kept with the member's unfinished response until they submit. */
export function useUploadMemberFile(publicId: string) {
  const { weldforms } = useAppApi();
  return useMutation({
    mutationFn: async (input: { fieldId: string; file: File }) => (await weldforms.uploadFill(publicId, input.fieldId, input.file)).data.file,
  });
}
