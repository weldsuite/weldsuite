/**
 * Hook for the App API client.
 *
 * Returns typed object-based domain APIs (customers, …) backed by the new
 * app-api worker — the long-term home for all first-party API work,
 * superseding core-api and api-worker.
 */

import { useAuth } from '@clerk/clerk-react';
import { useRef, useCallback, useMemo } from 'react';
import { createClientApi } from '@weldsuite/api-client/client';
import type { ClientApi } from '@weldsuite/api-client/types';
import { createTeamMembersApi } from '@weldsuite/core-api-client/domains/team-members';
import { createTasksApi } from '@weldsuite/app-api-client/domains/tasks';
import { createProjectsApi } from '@weldsuite/app-api-client/domains/projects';
import { createTicketsApi } from '@weldsuite/app-api-client/domains/tickets';
import { createCompaniesApi } from '@weldsuite/app-api-client/domains/companies';
import { createObjectTemplatesApi } from '@weldsuite/app-api-client/domains/object-templates';
import { createTaskCommentsApi } from '@weldsuite/core-api-client/domains/task-comments';
import { createProjectLabelsApi } from '@weldsuite/core-api-client/domains/project-labels';
import { createProjectMembersApi } from '@weldsuite/core-api-client/domains/project-members';
import { createGithubApi } from '@weldsuite/core-api-client/domains/github';
import { createDomainsApi } from '@weldsuite/core-api-client/domains/domains';
import { createDnsZonesApi } from '@weldsuite/core-api-client/domains/dns-zones';
import { createDnsRecordsApi } from '@weldsuite/core-api-client/domains/dns-records';
import { createDomainTransfersApi } from '@weldsuite/core-api-client/domains/domain-transfers';
import { createEmailForwardsApi } from '@weldsuite/core-api-client/domains/email-forwards';
import { createFilesApi } from '@weldsuite/core-api-client/domains/files';
import { createFoldersApi } from '@weldsuite/core-api-client/domains/folders';
import { createStorageApi } from '@weldsuite/core-api-client/domains/storage';
import { createDriveApi } from '@weldsuite/core-api-client/domains/drive';
import { createMailAccountsApi } from '@weldsuite/app-api-client/domains/mail-accounts';
import { createMailMessagesApi } from '@weldsuite/app-api-client/domains/mail-messages';
import { createMailLabelsApi } from '@weldsuite/app-api-client/domains/mail-labels';
import { createMailDraftsApi } from '@weldsuite/app-api-client/domains/mail-drafts';
import { createMailAttachmentsApi } from '@weldsuite/app-api-client/domains/mail-attachments';
import { createMailFoldersApi } from '@weldsuite/app-api-client/domains/mail-folders';
import { createMailTemplatesApi } from '@weldsuite/app-api-client/domains/mail-templates';
import { createMailSignaturesApi } from '@weldsuite/app-api-client/domains/mail-signatures';
import { createMailRulesApi } from '@weldsuite/app-api-client/domains/mail-rules';
import { createMailCampaignsApi } from '@weldsuite/app-api-client/domains/mail-campaigns';
import { createMailDomainsApi } from '@weldsuite/app-api-client/domains/mail-domains';
import { createMailScheduledApi } from '@weldsuite/app-api-client/domains/mail-scheduled';
import { createMailSnoozeApi } from '@weldsuite/app-api-client/domains/mail-snooze';
import { createMailSyncApi } from '@weldsuite/app-api-client/domains/mail-sync';
import { createMailThreadsApi } from '@weldsuite/app-api-client/domains/mail-threads';
import { createMailWeldMailApi } from '@weldsuite/app-api-client/domains/mail-weldmail';
import { createMailAiApi } from '@weldsuite/app-api-client/domains/mail-ai';
import { createAiApi } from '@weldsuite/app-api-client/domains/ai';
import { createWmsSuppliersApi } from '@weldsuite/app-api-client/domains/wms-suppliers';
import { createFeatureFlagsApi } from '@weldsuite/app-api-client/domains/feature-flags';
import { createWeldAgentApi } from '@weldsuite/app-api-client/domains/weldagent';
import { createSocialApi } from '@weldsuite/app-api-client/domains/social';
import { createAccountApi } from '@weldsuite/app-api-client/domains/account';
import { createWorkspaceSettingsApi } from '@weldsuite/app-api-client/domains/workspace-settings';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';
import { createSearchApi } from '@weldsuite/app-api-client/domains/search';
import { createAccessRequestsApi } from '@weldsuite/app-api-client/domains/access-requests';

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

/**
 * Returns a token-aware ClientApi instance pointing at the app-api worker.
 * Cached and only recreated when the token changes.
 */
export function useAppApiClient() {
  const { getToken } = useAuth();
  const clientRef = useRef<ClientApi | null>(null);
  const tokenRef = useRef<string | null>(null);

  const getClient = useCallback(async () => {
    const token = await getToken();
    if (token !== tokenRef.current || !clientRef.current) {
      tokenRef.current = token;
      clientRef.current = createClientApi({
        getToken: async () => token,
        baseUrl: APP_API_URL,
      });
    }
    return clientRef.current;
  }, [getToken]);

  return { getClient };
}

/**
 * Returns typed domain APIs for the app-api.
 *
 * Add new object domains here as their endpoints land in `apps/workers/app-api`.
 */
export function useAppApi() {
  const { getClient } = useAppApiClient();

  const lazyClient = useMemo<ClientApi>(() => {
    const handler = (method: keyof ClientApi) =>
      async (...args: unknown[]) => {
        const client = await getClient();
        return (client[method] as (...a: unknown[]) => unknown)(...args);
      };

    return {
      get: handler('get'),
      getRaw: handler('getRaw'),
      post: handler('post'),
      put: handler('put'),
      patch: handler('patch'),
      delete: handler('delete'),
    } as ClientApi;
  }, [getClient]);

  return useMemo(
    () => ({
      teamMembers: createTeamMembersApi(lazyClient),
      tasks: createTasksApi(lazyClient),
      projects: createProjectsApi(lazyClient),
      tickets: createTicketsApi(lazyClient),
      companies: createCompaniesApi(lazyClient),
      objectTemplates: createObjectTemplatesApi(lazyClient),
      taskComments: createTaskCommentsApi(lazyClient),
      projectLabels: createProjectLabelsApi(lazyClient),
      projectMembers: createProjectMembersApi(lazyClient),
      github: createGithubApi(lazyClient),
      domains: createDomainsApi(lazyClient),
      dnsZones: createDnsZonesApi(lazyClient),
      dnsRecords: createDnsRecordsApi(lazyClient),
      domainTransfers: createDomainTransfersApi(lazyClient),
      emailForwards: createEmailForwardsApi(lazyClient),
      files: createFilesApi(lazyClient),
      folders: createFoldersApi(lazyClient),
      storage: createStorageApi(lazyClient),
      drive: createDriveApi(lazyClient),

      // WeldMail — one entry per route group on apps/workers/app-api.
      mailAccounts: createMailAccountsApi(lazyClient),
      mailMessages: createMailMessagesApi(lazyClient),
      mailLabels: createMailLabelsApi(lazyClient),
      mailDrafts: createMailDraftsApi(lazyClient),
      mailAttachments: createMailAttachmentsApi(lazyClient),
      mailFolders: createMailFoldersApi(lazyClient),
      mailTemplates: createMailTemplatesApi(lazyClient),
      mailSignatures: createMailSignaturesApi(lazyClient),
      mailRules: createMailRulesApi(lazyClient),
      mailCampaigns: createMailCampaignsApi(lazyClient),
      mailDomains: createMailDomainsApi(lazyClient),
      mailScheduled: createMailScheduledApi(lazyClient),
      mailSnooze: createMailSnoozeApi(lazyClient),
      mailSync: createMailSyncApi(lazyClient),
      mailThreads: createMailThreadsApi(lazyClient),
      mailWeldMail: createMailWeldMailApi(lazyClient),
      mailAi: createMailAiApi(lazyClient),
      wmsSuppliers: createWmsSuppliersApi(lazyClient),
      featureFlags: createFeatureFlagsApi(lazyClient),
      weldAgent: createWeldAgentApi(lazyClient),

      // WeldAgent chat + one-shot generation via the Cloudflare AI Gateway.
      ai: createAiApi(lazyClient),

      // WeldSocial — accounts, posts (PostPeer publish/schedule), campaigns,
      // media, analytics, approvals, team, settings.
      social: createSocialApi(lazyClient),

      // Account self-service (deletion) — org-less.
      account: createAccountApi(lazyClient),

      // Workspace settings — name/slug mutations + owner-only deletion.
      workspaceSettings: createWorkspaceSettingsApi(lazyClient),

      // Workspace chrome — notification bell, Cmd+K search, access requests.
      notifications: createNotificationsApi(lazyClient),
      search: createSearchApi(lazyClient),
      accessRequests: createAccessRequestsApi(lazyClient),
    }),
    [lazyClient],
  );
}
