import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useAppAccess } from '@/hooks/use-app-access';
import { installedAppsKeys } from '@/hooks/use-installed-apps';
import type { InstalledApp } from '@/lib/api/apps';
import { MailLayoutClient } from './components/mail-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { markMailGatePassed } from './lib/open-timing';
import { cachedWeldmailInstalled, canRenderMailGate } from './lib/mail-gate';

export default function MailLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { t } = useI18n();
  const { orgId } = useAuth();
  const queryClient = useQueryClient();
  const { isInstalled, isLoading } = useAppAccess('weldmail');

  // A cached "installed" answer — this page's own earlier fetch, or the
  // persisted query cache restored from a previous session — lets mail render
  // before `useAppAccess` resolves again, instead of behind its `isLoading`
  // gate (docs/plans/weldmail-mailbox-storage.md phase 1 item 10). Read the
  // installed-apps query cache directly rather than through `useAppAccess`'s
  // own `isLoading`, which also waits on the unrelated WeldApps and
  // custom-objects sub-queries `useInstalledApps` merges in.
  const cachedApps = queryClient.getQueryData<InstalledApp[]>(installedAppsKeys.byOrg(orgId));
  const canRenderMail = canRenderMailGate({ isLoading, isInstalled }, cachedWeldmailInstalled(cachedApps));

  useEffect(() => {
    if (canRenderMail) markMailGatePassed();
  }, [canRenderMail]);

  if (!canRenderMail) {
    if (isLoading) return <PageLoader />;
    return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.mail.layout.appNotInstalled}</div>;
  }

  return (
    <MailLayoutClient>
      {children}
    </MailLayoutClient>
  );
}
