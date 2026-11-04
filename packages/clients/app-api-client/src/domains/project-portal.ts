/**
 * Client for the WeldFlow client portal API (`/public/project-portal`, served
 * by flow-api). Build the `ClientApi` with `apiPrefix: '/public/project-portal'`
 * and the signed-in contact's session token as `getToken`.
 *
 * Request and response shapes are the shared types in `../schemas/project-portal`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  DecidePortalApprovalInput,
  PortalApproval,
  PortalDecisionResult,
  PortalDocument,
  PortalFile,
  PortalMe,
  PortalMessage,
  PortalPageQuery,
  PortalProject,
  PortalProjectSummary,
  PortalReport,
  PortalSignIn,
  PostPortalMessageInput,
  RequestPortalCodeInput,
  VerifyPortalCodeInput,
} from '../schemas/project-portal';

export type {
  DecidePortalApprovalInput,
  PortalAcceptanceCriterion,
  PortalApproval,
  PortalApprovalSubject,
  PortalChangeImpact,
  PortalChangeRequest,
  PortalContact,
  PortalDeliverable,
  PortalDecision,
  PortalDecisionResult,
  PortalDocument,
  PortalFile,
  PortalLocale,
  PortalMe,
  PortalMessage,
  PortalMilestone,
  PortalNextMilestone,
  PortalPageQuery,
  PortalProject,
  PortalProjectSummary,
  PortalReport,
  PortalReportArea,
  PortalSignIn,
  PortalStatusColour,
  PortalWorkspace,
  PostPortalMessageInput,
  RequestPortalCodeInput,
  VerifyPortalCodeInput,
} from '../schemas/project-portal';

export function createProjectPortalApi(api: ClientApi) {
  return {
    // Sign-in --------------------------------------------------------------
    /** Always 204: it does not say whether the address may sign in. */
    requestCode(input: RequestPortalCodeInput): Promise<void> {
      return api.post('/auth/request-code', input);
    },

    verifyCode(input: VerifyPortalCodeInput): Promise<DataResponse<PortalSignIn>> {
      return api.post('/auth/verify', input);
    },

    signOut(): Promise<void> {
      return api.post('/auth/sign-out');
    },

    me(): Promise<DataResponse<PortalMe>> {
      return api.get('/me');
    },

    // Projects -------------------------------------------------------------
    listProjects(): Promise<ListResponse<PortalProjectSummary>> {
      return api.get('/projects');
    },

    getProject(projectId: string): Promise<DataResponse<PortalProject>> {
      return api.get(`/projects/${encodeURIComponent(projectId)}`);
    },

    /** Published, client visible status reports, newest first. */
    listReports(projectId: string, query: PortalPageQuery = {}): Promise<ListResponse<PortalReport>> {
      return api.get(`/projects/${encodeURIComponent(projectId)}/reports${buildQueryString({ ...query })}`);
    },

    listFiles(projectId: string, query: PortalPageQuery = {}): Promise<ListResponse<PortalFile>> {
      return api.get(`/projects/${encodeURIComponent(projectId)}/files${buildQueryString({ ...query })}`);
    },

    /** The download as a response (an attachment), through the portal check. */
    downloadFile(projectId: string, fileId: string): Promise<Response> {
      return api.getRaw(
        `/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download`,
      );
    },

    listDocuments(projectId: string, query: PortalPageQuery = {}): Promise<ListResponse<PortalDocument>> {
      return api.get(`/projects/${encodeURIComponent(projectId)}/documents${buildQueryString({ ...query })}`);
    },

    downloadDocument(projectId: string, documentId: string): Promise<Response> {
      return api.getRaw(
        `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/download`,
      );
    },

    /** The thread, oldest first. */
    listMessages(projectId: string, query: PortalPageQuery = {}): Promise<ListResponse<PortalMessage>> {
      return api.get(`/projects/${encodeURIComponent(projectId)}/messages${buildQueryString({ ...query })}`);
    },

    postMessage(projectId: string, input: PostPortalMessageInput): Promise<DataResponse<PortalMessage>> {
      return api.post(`/projects/${encodeURIComponent(projectId)}/messages`, input);
    },

    // Approvals ------------------------------------------------------------
    /** The reviews addressed to the contact that are waiting for them. */
    listApprovals(): Promise<ListResponse<PortalApproval>> {
      return api.get('/approvals');
    },

    decideApproval(approvalId: string, input: DecidePortalApprovalInput): Promise<DataResponse<PortalDecisionResult>> {
      return api.post(`/approvals/${encodeURIComponent(approvalId)}/decide`, input);
    },
  };
}

export type ProjectPortalApi = ReturnType<typeof createProjectPortalApi>;
