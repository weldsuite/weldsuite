'use client';

import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { brandingStyle, useBranding } from '@/lib/hooks/use-branding';
import { usePortalRealtime } from '@/lib/hooks/use-portal-realtime';
import { MeProvider } from '@/lib/me-context';
import type { Me } from '@/lib/types';
import { PortalTopbar } from '@/components/portal-topbar';
import { ErrorState, LoadingState } from '@/components/ui/states';

/**
 * Authenticated portal chrome. `/me` is preloaded by the server layout, so this
 * renders complete on the server; afterwards it follows the cache, so a live
 * branding change or profile update re-renders it in place.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const slug = String(useParams().workspace ?? '');
  const { data: me, loading, error, refetch } = usePortalQuery<Me>(slug, '/me');
  const { dict } = useI18n();
  useBranding(me?.config);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <LoadingState />
      </main>
    );
  }

  if (error || !me) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <ErrorState onRetry={refetch} />
      </main>
    );
  }

  return (
    <MeProvider value={me}>
      <LiveUpdates slug={slug} me={me} />
      <div className="min-h-screen flex flex-col bg-gray-50" style={brandingStyle(me.config)}>
        <PortalTopbar me={me} config={me.config} />
        <div className="flex-1 px-4 py-6 sm:px-6 max-w-5xl w-full mx-auto">{children}</div>
        {!me.config.hideWeldsuiteBranding && <footer className="py-6 text-center text-xs text-gray-400">{dict.common.poweredBy}</footer>}
      </div>
    </MeProvider>
  );
}

function LiveUpdates({ slug, me }: { slug: string; me: Me }) {
  usePortalRealtime(slug, me);
  return null;
}
