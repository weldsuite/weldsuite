'use client';

import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { useBranding } from '@/lib/hooks/use-branding';
import { MeProvider } from '@/lib/me-context';
import type { Me } from '@/lib/types';
import { PortalTopbar } from '@/components/portal-topbar';
import { LoadingState, ErrorState } from '@/components/ui/states';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const slug = String(useParams().workspace ?? '');
  const { data: me, loading, error, refetch } = usePortalQuery<Me>(slug, '/me');
  useBranding(me?.config);
  const { dict } = useI18n();

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
      <div className="min-h-screen flex flex-col bg-gray-50">
        <PortalTopbar me={me} config={me.config} />
        <div className="flex-1 px-4 py-6 sm:px-6 max-w-5xl w-full mx-auto">{children}</div>
        {!me.config.hideWeldsuiteBranding && <footer className="py-6 text-center text-xs text-gray-400">{dict.common.poweredBy}</footer>}
      </div>
    </MeProvider>
  );
}
