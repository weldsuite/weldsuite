/**
 * Per-app settings surfaces (WeldDesk, WeldMail).
 *
 * WeldDesk settings load from app-api (/api/helpdesk-settings). WeldMail plan
 * usage is the one call still on the legacy worker — see the TODO below.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';

export const appSettingsKeys = {
  all: ['app-settings'] as const,
  helpdesk: () => [...appSettingsKeys.all, 'helpdesk'] as const,
  mail: () => [...appSettingsKeys.all, 'mail'] as const,
};

interface HelpdeskSettingsEnvelope {
  data: {
    settings: Record<string, any> | null;
    widgetSettings: Record<string, any> | null;
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

      const hdSettings = (res?.data?.settings ?? {}) as Record<string, any>;

      return {
        data: {
          tickets: hdSettings.tickets || undefined,
          satisfaction: hdSettings.satisfaction || undefined,
          automation: hdSettings.automation || undefined,
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
        mailAccounts.list({ limit: 100 }).catch(() => ({ data: [] as any[] })),
        mailDomains.list().catch(() => ({ data: [] as any[] })),
      ]);
      return {
        accounts: accountsRes?.data || [],
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
