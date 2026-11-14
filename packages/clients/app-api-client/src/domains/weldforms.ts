/**
 * App-API WeldForms domain client — `/api/forms/*` (forms-api).
 *
 * Forms (drafts, publishing, versions, access), folders, themes, workspace
 * settings and usage, responses (list, summary, insights, export, erase),
 * invitations, integrations, subscriptions, AI, and members-only filling.
 * The respondent side (`/public/forms/*`) is forms-portal's, not this client's.
 * See weldsuite-documentation/plans/weldforms.md.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  BulkDeleteFormResponsesInput,
  CreateAiSummaryInput,
  CreateFormFolderInput,
  CreateFormInput,
  CreateFormInvitationsInput,
  CreateFormInvitationsResult,
  CreateFormThemeInput,
  DuplicateFormInput,
  EraseRespondentInput,
  EraseRespondentResult,
  ExportFormResponsesQuery,
  FormAccessEntry,
  FormAiSummary,
  FormDetail,
  FormFolder,
  FormInsights,
  FormIntegration,
  FormIntegrationInput,
  FormInvitation,
  FormInvitationStats,
  FormMediaUploadResult,
  FormResponseColumn,
  FormResponseDetail,
  FormResponseDto,
  FormResultsSummary,
  FormsUsage,
  FormSubscription,
  FormSummary,
  FormSummaryQuery,
  FormsWorkspaceSettings,
  FormTheme,
  FormVersionDetail,
  FormVersionSummary,
  GenerateFormInput,
  GenerateFormResult,
  ListFormInvitationsQuery,
  ListPersonResponsesQuery,
  PersonFormResponse,
  ListFormResponsesQuery,
  ListFormsQuery,
  MemberFill,
  MemberSubmitInput,
  MemberUploadResult,
  PublishFormResult,
  RemindFormInvitationsInput,
  RemindFormInvitationsResult,
  SetFormAccessInput,
  SubmitSessionResult,
  SuggestBlocksInput,
  SuggestBlocksResult,
  UpdateFormFolderInput,
  UpdateFormInput,
  UpdateFormIntegrationInput,
  UpdateFormsWorkspaceSettingsInput,
  UpdateFormThemeInput,
} from '../schemas/weldforms';

const forms = '/forms/forms';

export function createWeldFormsApi(api: ClientApi) {
  return {
    // ── Forms ──────────────────────────────────────────────────────────
    list(params: ListFormsQuery = {}): Promise<ListResponse<FormSummary>> {
      return api.get(`${forms}${buildQueryString(params)}`);
    },
    get(id: string): Promise<DataResponse<FormDetail>> {
      return api.get(`${forms}/${id}`);
    },
    create(input: CreateFormInput): Promise<DataResponse<FormDetail>> {
      return api.post(forms, input);
    },
    /** Saves the draft; 409 `REVISION_CONFLICT` when someone saved in between. */
    update(id: string, input: UpdateFormInput): Promise<DataResponse<FormDetail>> {
      return api.patch(`${forms}/${id}`, input);
    },
    duplicate(id: string, input: DuplicateFormInput = {}): Promise<DataResponse<FormDetail>> {
      return api.post(`${forms}/${id}/duplicate`, input);
    },
    /** Deletes the form with its responses, files and links. */
    remove(id: string): Promise<void> {
      return api.delete(`${forms}/${id}`);
    },
    publish(id: string): Promise<DataResponse<PublishFormResult>> {
      return api.post(`${forms}/${id}/publish`);
    },
    close(id: string): Promise<DataResponse<FormDetail>> {
      return api.post(`${forms}/${id}/close`);
    },
    reopen(id: string): Promise<DataResponse<FormDetail>> {
      return api.post(`${forms}/${id}/reopen`);
    },
    /** Throws the draft away and goes back to the published version. */
    discardChanges(id: string): Promise<DataResponse<FormDetail>> {
      return api.post(`${forms}/${id}/discard`);
    },
    versions(id: string): Promise<DataResponse<FormVersionSummary[]>> {
      return api.get(`${forms}/${id}/versions`);
    },
    version(id: string, versionId: string): Promise<DataResponse<FormVersionDetail>> {
      return api.get(`${forms}/${id}/versions/${versionId}`);
    },
    access(id: string): Promise<DataResponse<FormAccessEntry[]>> {
      return api.get(`${forms}/${id}/access`);
    },
    setAccess(id: string, input: SetFormAccessInput): Promise<DataResponse<FormAccessEntry[]>> {
      return api.put(`${forms}/${id}/access`, input);
    },

    // ── Responses ──────────────────────────────────────────────────────
    responses(id: string, params: ListFormResponsesQuery = {}): Promise<ListResponse<FormResponseDto>> {
      return api.get(`${forms}/${id}/responses${buildQueryString(params)}`);
    },
    response(id: string, responseId: string): Promise<DataResponse<FormResponseDetail>> {
      return api.get(`${forms}/${id}/responses/${responseId}`);
    },
    deleteResponse(id: string, responseId: string): Promise<void> {
      return api.delete(`${forms}/${id}/responses/${responseId}`);
    },
    bulkDeleteResponses(id: string, input: BulkDeleteFormResponsesInput): Promise<DataResponse<{ deleted: number }>> {
      return api.post(`${forms}/${id}/responses/bulk-delete`, input);
    },
    /** CSV or XLSX bytes; the caller saves the response body. */
    exportResponses(id: string, params: ExportFormResponsesQuery): Promise<Response> {
      return api.getRaw(`${forms}/${id}/responses/export${buildQueryString(params)}`);
    },
    /** An uploaded file or signature; the caller reads the body. */
    responseFile(id: string, responseId: string, fileId: string): Promise<Response> {
      return api.getRaw(`${forms}/${id}/responses/${responseId}/files/${fileId}`);
    },
    retryResponseAction(id: string, responseId: string, actionId: string): Promise<DataResponse<{ queued: true }>> {
      return api.post(`${forms}/${id}/responses/${responseId}/actions/${actionId}/retry`);
    },
    columns(id: string): Promise<DataResponse<FormResponseColumn[]>> {
      return api.get(`${forms}/${id}/columns`);
    },
    summary(id: string, params: FormSummaryQuery = {}): Promise<DataResponse<FormResultsSummary>> {
      return api.get(`${forms}/${id}/summary${buildQueryString(params)}`);
    },
    insights(id: string, params: { from?: string; to?: string } = {}): Promise<DataResponse<FormInsights>> {
      return api.get(`${forms}/${id}/insights${buildQueryString(params)}`);
    },
    /** A CRM person's responses across the forms the member may read (the CRM Forms tab). */
    personResponses(params: ListPersonResponsesQuery): Promise<ListResponse<PersonFormResponse>> {
      return api.get(`/forms/responses${buildQueryString(params)}`);
    },
    /** GDPR: erase one respondent's responses across every form. */
    eraseRespondent(input: EraseRespondentInput): Promise<DataResponse<EraseRespondentResult>> {
      return api.post('/forms/erase', input);
    },

    // ── Invitations ────────────────────────────────────────────────────
    invite(id: string, input: CreateFormInvitationsInput): Promise<DataResponse<CreateFormInvitationsResult>> {
      return api.post(`${forms}/${id}/invitations`, input);
    },
    invitations(id: string, params: ListFormInvitationsQuery = {}): Promise<ListResponse<FormInvitation>> {
      return api.get(`${forms}/${id}/invitations${buildQueryString(params)}`);
    },
    invitationStats(id: string): Promise<DataResponse<FormInvitationStats>> {
      return api.get(`${forms}/${id}/invitations/stats`);
    },
    remind(id: string, input: RemindFormInvitationsInput = {}): Promise<DataResponse<RemindFormInvitationsResult>> {
      return api.post(`${forms}/${id}/invitations/remind`, input);
    },
    revokeInvitation(id: string, invitationId: string): Promise<DataResponse<FormInvitation>> {
      return api.post(`${forms}/${id}/invitations/${invitationId}/revoke`);
    },

    // ── Integrations ───────────────────────────────────────────────────
    integrations(id: string): Promise<DataResponse<FormIntegration[]>> {
      return api.get(`${forms}/${id}/integrations`);
    },
    createIntegration(id: string, input: FormIntegrationInput): Promise<DataResponse<FormIntegration>> {
      return api.post(`${forms}/${id}/integrations`, input);
    },
    updateIntegration(id: string, integrationId: string, input: UpdateFormIntegrationInput): Promise<DataResponse<FormIntegration>> {
      return api.patch(`${forms}/${id}/integrations/${integrationId}`, input);
    },
    deleteIntegration(id: string, integrationId: string): Promise<void> {
      return api.delete(`${forms}/${id}/integrations/${integrationId}`);
    },
    /** Runs the integration against the latest completed response, without recording it. */
    testIntegration(id: string, integrationId: string): Promise<DataResponse<{ ok: boolean; message: string }>> {
      return api.post(`${forms}/${id}/integrations/${integrationId}/test`);
    },

    // ── Subscription (my notifications for this form) ──────────────────
    subscription(id: string): Promise<DataResponse<FormSubscription>> {
      return api.get(`${forms}/${id}/subscription`);
    },
    setSubscription(id: string, input: FormSubscription): Promise<DataResponse<FormSubscription>> {
      return api.put(`${forms}/${id}/subscription`, input);
    },

    // ── AI (Global only) ───────────────────────────────────────────────
    generate(input: GenerateFormInput): Promise<DataResponse<GenerateFormResult>> {
      return api.post('/forms/ai/generate', input);
    },
    suggestBlocks(input: SuggestBlocksInput): Promise<DataResponse<SuggestBlocksResult>> {
      return api.post('/forms/ai/suggest-blocks', input);
    },
    aiSummary(id: string, blockId: string | null = null): Promise<DataResponse<FormAiSummary>> {
      return api.get(`${forms}/${id}/ai/summary${buildQueryString({ blockId: blockId ?? undefined })}`);
    },
    createAiSummary(id: string, input: CreateAiSummaryInput): Promise<DataResponse<FormAiSummary>> {
      return api.post(`${forms}/${id}/ai/summary`, input);
    },

    // ── Folders ────────────────────────────────────────────────────────
    folders(): Promise<DataResponse<FormFolder[]>> {
      return api.get('/forms/folders');
    },
    createFolder(input: CreateFormFolderInput): Promise<DataResponse<FormFolder>> {
      return api.post('/forms/folders', input);
    },
    updateFolder(folderId: string, input: UpdateFormFolderInput): Promise<DataResponse<FormFolder>> {
      return api.patch(`/forms/folders/${folderId}`, input);
    },
    /** Forms in it move to "no folder". */
    deleteFolder(folderId: string): Promise<void> {
      return api.delete(`/forms/folders/${folderId}`);
    },

    // ── Themes ─────────────────────────────────────────────────────────
    themes(): Promise<DataResponse<FormTheme[]>> {
      return api.get('/forms/themes');
    },
    createTheme(input: CreateFormThemeInput): Promise<DataResponse<FormTheme>> {
      return api.post('/forms/themes', input);
    },
    updateTheme(themeId: string, input: UpdateFormThemeInput): Promise<DataResponse<FormTheme>> {
      return api.patch(`/forms/themes/${themeId}`, input);
    },
    deleteTheme(themeId: string): Promise<void> {
      return api.delete(`/forms/themes/${themeId}`);
    },

    /** An image for a question, a choice or a theme (public bucket). */
    uploadMedia(file: File): Promise<DataResponse<FormMediaUploadResult>> {
      const form = new FormData();
      form.append('file', file);
      return api.postForm('/forms/media', form);
    },

    // ── Workspace settings and usage ───────────────────────────────────
    settings(): Promise<DataResponse<FormsWorkspaceSettings>> {
      return api.get('/forms/settings');
    },
    updateSettings(input: UpdateFormsWorkspaceSettingsInput): Promise<DataResponse<FormsWorkspaceSettings>> {
      return api.patch('/forms/settings', input);
    },
    usage(): Promise<DataResponse<FormsUsage>> {
      return api.get('/forms/usage');
    },

    // ── Members-only forms ─────────────────────────────────────────────
    fill(publicId: string): Promise<DataResponse<MemberFill>> {
      return api.get(`/forms/fill/${publicId}`);
    },
    /** A file or signature for one field of a members-only form; kept with the member's in-progress response until they submit. */
    uploadFill(publicId: string, blockId: string, file: File): Promise<DataResponse<MemberUploadResult>> {
      const body = new FormData();
      body.append('blockId', blockId);
      body.append('file', file);
      return api.postForm(`/forms/fill/${publicId}/uploads`, body);
    },
    /** 422 `VALIDATION_FAILED` with `details.fields` as on the public submit. */
    submitFill(publicId: string, input: MemberSubmitInput): Promise<DataResponse<SubmitSessionResult>> {
      return api.post(`/forms/fill/${publicId}`, input);
    },
  };
}

export type WeldFormsApi = ReturnType<typeof createWeldFormsApi>;
