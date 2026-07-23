
import { ReactNode, lazy, Suspense } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { HelpdeskHeader } from './helpdesk-header';
import { ComposeProvider } from '@/contexts/compose-context';
// Lazy + dynamic-only — see mail-layout-client.tsx. Scoped to this layout's
// nested ComposeProvider (not redundant); imported dynamically to avoid a
// mixed static+dynamic import that the CI build mis-chunks.
const FloatingComposePanel = lazy(() =>
  import('@/app/weldmail/components/floating-compose-panel').then((m) => ({ default: m.FloatingComposePanel })),
);
import { ModuleContent } from '@/components/layout/module-content';
import { useI18n } from '@/lib/i18n/provider';

interface HelpdeskLayoutClientProps {
  children: ReactNode;
}

export function HelpdeskLayoutClient({ children }: HelpdeskLayoutClientProps) {
  const { t } = useI18n();

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.helpdesk.dashboard.helpdeskBreadcrumb, href: '/welddesk' }]}>
      <ComposeProvider>
        <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
          <HelpdeskHeader />
          <ModuleContent className="overflow-auto">{children}</ModuleContent>

          {/* Floating Compose Panel */}
          <Suspense fallback={null}>
            <FloatingComposePanel />
          </Suspense>
        </div>
      </ComposeProvider>
    </BreadcrumbProvider>
  );
}
