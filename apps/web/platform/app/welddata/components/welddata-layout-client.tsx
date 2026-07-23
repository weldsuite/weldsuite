import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * The module sidebar is rendered globally by PlatformShell via
 * UnifiedModuleSidebar + MODULE_CONFIGS.welddata. This layout provides the
 * full-width header and lays the active page out in the shared content row
 * (content + object panel(s) + drawers) via ModuleContent.
 */
export function WelddataLayoutClient({ children }: { children: ReactNode }) {
  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: 'WeldData', href: '/welddata' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <AppHeader />
        <ModuleContent className="overflow-auto">{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
