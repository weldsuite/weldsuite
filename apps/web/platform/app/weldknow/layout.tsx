import { useAppAccess } from '@/hooks/use-app-access';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { KnowledgeSidebar } from './components/knowledge-sidebar';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * WeldKnow layout — two-pane shell: a ~280px page-tree sidebar on the left
 * and the routed page/trash content on the right. Gated on both app
 * installation (useAppAccess) and the `knowledge:read` permission object.
 */
export default function WeldKnowLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const tKnow = getTranslations('weldknow');
  const { isInstalled, isLoading } = useAppAccess('weldknow');
  const canRead = useCan('knowledge:read');

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.common.empty.appNotInstalled}
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {tKnow.emptyState.noAccessDescription}
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <aside className="w-[280px] shrink-0 border-r flex flex-col h-full">
        <KnowledgeSidebar />
      </aside>
      <ModuleContent className="overflow-y-auto">{children}</ModuleContent>
    </div>
  );
}
