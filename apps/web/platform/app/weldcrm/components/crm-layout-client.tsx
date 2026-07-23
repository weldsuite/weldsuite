
import { useTranslations } from '@weldsuite/i18n/client';
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AppHeader } from '@/components/layout/app-header';
import { ModuleContent } from '@/components/layout/module-content';

interface CrmLayoutClientProps {
  children: ReactNode;
}

export function CrmLayoutClient({ children }: CrmLayoutClientProps) {
  const t = useTranslations();

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t('crm.breadcrumb.crm'), href: '/weldcrm' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        {/* Full-width header. Drawer state lives in shared hooks (the header's
            buttons toggle it, DrawerHost renders it), so no callbacks needed. */}
        <AppHeader />
        {/* Content row: module content + object panel(s) + drawers, all flex
            siblings with a uniform gap (see ModuleContent). */}
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
