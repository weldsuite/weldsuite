'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { installedAppsKeys } from '@/hooks/use-installed-apps';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { InstalledApp } from '@/lib/api/apps';

const APP_NAMES: Record<string, string> = {
  weldcrm: 'WeldCRM',
  welddesk: 'WeldDesk',
  weldmail: 'WeldMail',
  weldflow: 'WeldFlow',
  weldhost: 'WeldHost',
  weldstash: 'WeldStash',
  weldbooks: 'WeldBooks',
  weldchat: 'WeldChat',
  weldmeet: 'WeldMeet',
  weldcalendar: 'WeldCalendar',
  welddrive: 'WeldDrive',
  weldknow: 'WeldKnow',
  weldcommerce: 'WeldCommerce',
};

/**
 * Installed apps for the left rail in support videos, read from
 * `GET /api/dashboard/installed-apps` (answered by the video's fixtures) so
 * the rail updates when an install invalidates the installed-apps queries.
 */
export function PreviewLiveInstalledApps({ children }: Readonly<{ children: ReactNode }>) {
  const { getClient } = useAppApiClient();
  const { data: codes = [] } = useQuery({
    queryKey: [...installedAppsKeys.all, 'preview'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: string[] }>('/dashboard/installed-apps');
      return res?.data ?? [];
    },
  });

  const apps: InstalledApp[] = codes.map((code, index) => ({
    id: code,
    workspaceId: 'ws_help_preview',
    appCode: code,
    name: APP_NAMES[code] ?? code,
    status: 'active',
    installedAt: '2026-01-15T12:00:00.000Z',
    displayOrder: index,
    appType: 'system',
  }));

  return <PreviewInstalledAppsProvider apps={apps}>{children}</PreviewInstalledAppsProvider>;
}
