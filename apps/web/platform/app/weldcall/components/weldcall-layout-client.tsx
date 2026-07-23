import { useEffect, ReactNode } from 'react';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { BreadcrumbProvider, useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { useWeldAgentDrawerOpen } from '@/hooks/use-weldagent-drawer-open';
import { usePathname } from '@/lib/router';

interface WeldCallLayoutClientProps {
  children: ReactNode;
}

export function WeldCallLayoutClient({ children }: WeldCallLayoutClientProps) {
  const pathname = usePathname();
  const mobileNav = useMobileNavOptional();

  const callRouteSegments = ['new', 'history', 'contacts'];
  const subPath = pathname?.replace(/^\/weldcall\/?/, '').split('/')[0];
  const isCallDetailPage = !!subPath && !callRouteSegments.includes(subPath);

  const [, setShowWeldAgentDirect] = useWeldAgentDrawerOpen();
  const setShowWeldAgent = mobileNav?.setShowWeldAgent ?? setShowWeldAgentDirect;

  // Auto-open WeldAgent on the call detail page (mirrors WeldCRM behavior)
  useEffect(() => {
    if (isCallDetailPage) {
      mobileNav?.setWeldAgentSkipAnimation?.(true);
      setShowWeldAgent(true);
      requestAnimationFrame(() => {
        mobileNav?.setWeldAgentSkipAnimation?.(false);
      });
    }
  }, [isCallDetailPage, setShowWeldAgent]);

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: 'WeldCall', href: '/weldcall' }]}>
      <WeldCallInnerLayout>{children}</WeldCallInnerLayout>
    </BreadcrumbProvider>
  );
}

function WeldCallInnerLayout({ children }: { children: ReactNode }) {
  const breadcrumbs = useCurrentBreadcrumbs();

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <BreadcrumbHeader segments={breadcrumbs} moduleKey="weldcall" />
      <ModuleContent>{children}</ModuleContent>
    </div>
  );
}
