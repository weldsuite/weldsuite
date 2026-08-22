'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from '@/lib/router';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import { HostLayoutClient } from '@/app/weldhost/components/host-layout-client';
import { DomainsClient } from '@/app/weldhost/domains/domains-client';
import { useObjectPanel } from '@/components/object-panel';
import { cn } from '@/lib/utils';
import {
  previewDnsRecords,
  previewDomain,
  previewDomainsList,
  previewInstalledApps,
  type HelpDocsPreviewScene,
} from './fixtures';
import { PreviewHelpDocsProvider } from './preview-help-docs-context';
import { useSeedPreviewHostData } from './use-seed-preview-host-data';

const PREVIEW_PERMISSIONS = [
  '*',
  'weldhost:domains:update',
  'weldhost:domains:delete',
  'weldhost:dns:create',
  'weldhost:dns:update',
  'weldhost:dns:delete',
];

function HelpDocsPreviewContent() {
  const searchParams = useSearchParams();
  const scene = (searchParams.get('scene') ?? 'dns-list') as HelpDocsPreviewScene;
  const { open, closeAll } = useObjectPanel();

  const dnsRecords = useMemo(() => {
    if (scene === 'dns-locked') {
      return previewDnsRecords.filter((record) => record.metadata?.locks);
    }
    return previewDnsRecords;
  }, [scene]);

  useSeedPreviewHostData(dnsRecords);

  useEffect(() => {
    closeAll();
    if (scene !== 'domains') {
      open({
        type: 'domain',
        id: previewDomain.id,
        mode: 'fullscreen',
        initialTab: 'dns',
      });
    }
    return () => closeAll();
  }, [scene, open, closeAll]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DomainsClient domains={previewDomainsList} />
    </div>
  );
}

export function HelpDocsPreviewClient() {
  const [ready, setReady] = useState(false);
  const searchParams = useSearchParams();
  const scene = (searchParams.get('scene') ?? 'dns-list') as HelpDocsPreviewScene;

  useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };
    void document.fonts.ready.then(markReady);
    const fallback = window.setTimeout(markReady, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, []);

  const previewUi = useMemo(
    () => ({
      initialShowAddRecord: scene === 'dns-add',
    }),
    [scene],
  );

  return (
    <PreviewInstalledAppsProvider apps={previewInstalledApps}>
      <PermissionProvider permissions={PREVIEW_PERMISSIONS} isLoading={false} role="OWNER">
        <PreviewHelpDocsProvider value={previewUi}>
          <div
            data-screenshot-frame
            data-screenshot-ready={ready ? 'true' : 'false'}
            className={cn(
              'mx-auto w-[1440px] max-w-full overflow-hidden rounded-xl shadow-2xl ring-1 ring-border',
              scene === 'domains' ? 'h-[780px]' : 'h-[900px]',
            )}
          >
            <PlatformShell embedded>
              <HostLayoutClient>
                <HelpDocsPreviewContent />
              </HostLayoutClient>
            </PlatformShell>
          </div>
        </PreviewHelpDocsProvider>
      </PermissionProvider>
    </PreviewInstalledAppsProvider>
  );
}
