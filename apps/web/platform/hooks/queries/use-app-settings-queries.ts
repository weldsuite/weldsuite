/**
 * Per-app settings surfaces (WeldDesk, WeldMail).
 *
 * WeldDesk settings load from app-api (/api/helpdesk-settings). WeldMail plan
 * usage is the one call still on the legacy worker — see the TODO below.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type {
  TicketSettingsData,
  SatisfactionSettingsData,
  AutomationSettingsData,
} from '@/hooks/queries/use-helpdesk-queries';
import type { MailAccountRow } from '@weldsuite/app-api-client/domains/mail-accounts';
import type { EmailAccount } from '@/app/settings/apps/weldmail/accounts/email-accounts-list';

const MAIL_ACCOUNT_STATUSES: EmailAccount['status'][] = [
  'active',
  'inactive',
  'error',
  'suspended',
  'quota_exceeded',
];

function toEmailAccount(row: MailAccountRow): EmailAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName ?? undefined,
    provider: row.provider,
    isShared: row.isShared,
    assignedUserIds: row.assignedUserIds ?? undefined,
    lastSyncAt: row.lastSyncAt ?? undefined,
    status: MAIL_ACCOUNT_STATUSES.includes(row.status as EmailAccount['status'])
      ? (row.status as EmailAccount['status'])
      : undefined,
  };
}

export const appSettingsKeys = {
  all: ['app-settings'] as const,
  helpdesk: () => [...appSettingsKeys.all, 'helpdesk'] as const,
  mail: () => [...appSettingsKeys.all, 'mail'] as const,
};

interface HelpdeskSettingsEnvelope {
  data: {
    settings: Record<string, unknown> | null;
    widgetSettings: Record<string, unknown> | null;
  };
}

export function useHelpdeskSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: appSettingsKeys.helpdesk(),
    queryFn: async () => {
      const client = await getClient();
      // The old companion call to `/settings/app/helpdesk` was dropped: that
      // route never existed on api-worker (no `/settings/app/*` handler), so it
      // 404'd and its .catch() always yielded {}. app-api /helpdesk-settings is
      // the sole source for these settings.
      const res = await client
        .get<HelpdeskSettingsEnvelope>('/helpdesk-settings')
        .catch(() => ({ data: null }) as unknown as HelpdeskSettingsEnvelope);

      const hdSettings = (res?.data?.settings ?? {}) as Record<string, unknown>;

      return {
        data: {
          tickets: (hdSettings.tickets as TicketSettingsData | undefined) || undefined,
          satisfaction: (hdSettings.satisfaction as SatisfactionSettingsData | undefined) || undefined,
          automation: (hdSettings.automation as AutomationSettingsData | undefined) || undefined,
          widgetSettings: res?.data?.widgetSettings ?? undefined,
        },
      };
    },
  });
}

export function useMailAppSettings() {
  const { mailAccounts, mailDomains } = useAppApi();
  return useQuery({
    queryKey: appSettingsKeys.mail(),
    queryFn: async () => {
      const [accountsRes, domainsRes] = await Promise.all([
        // Email accounts + domains load from app-api (api-worker is obsolete).
        mailAccounts.list({ limit: 100 }).catch(() => ({ data: [] as MailAccountRow[] })),
        mailDomains.list().catch(() => ({ data: [] as unknown[] })),
      ]);
      return {
        accounts: (accountsRes?.data || []).map(toEmailAccount),
        domains: domainsRes?.data || [],
        // TODO(phase-out): plan usage/limits have NO app-api endpoint. The old
        // legacy call to `/mail/usage` was removed rather than carried over:
        // api-worker mounts no `/api/mail` router at all, so it 404'd and its
        // .catch() always produced null — exactly what this literal yields.
        // Behaviour is unchanged; port /mail/usage to app-api to restore limits.
        usage: null as { emailAccounts?: { current?: number; limit?: number } } | null,
      };
    },
  });
}
