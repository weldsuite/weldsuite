/** What starts a ProcessResponse run. Kept free of Workers imports so services and tests can use it. */
export interface ProcessResponseParams {
  /** Clerk org id of the workspace. */
  clerkOrgId: string;
  /** `workspaces.id`. */
  workspaceId: string;
  formId: string;
  responseId: string;
  /** `update`: a verified respondent edited a completed response; steps update what they made. */
  mode: 'submit' | 'update';
  /** Retry of one integration (the Retry button): only that integration's step runs, the always-steps are skipped. */
  retryIntegrationId?: string;
}
