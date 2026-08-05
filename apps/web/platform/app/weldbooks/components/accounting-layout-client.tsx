import { useQuery } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { WeldbooksHeader } from './weldbooks-header';
import { ModuleContent } from '@/components/layout/module-content';
import { PageLoader } from '@/components/page-loader';
import { EntityEmptyState } from '@/components/accounting/entity-empty-state';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useI18n } from '@/lib/i18n/provider';

interface EntityRow {
  id: string;
}

/**
 * The module sidebar is rendered by PlatformShell via UnifiedModuleSidebar + MODULE_CONFIGS.weldbooks.
 * This layout renders the WeldBooks full-width header at the top (with module-wide search and the
 * entity switcher in the actions slot), then the active page's content in the shared content row.
 *
 * When the workspace has no accounting entity yet, short-circuit to EntityEmptyState so the user
 * can create the first legal entity before opening entity-scoped pages.
 */
export function AccountingLayoutClient({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const tl = t.accounting.layout;

  const {
    data: entities,
    isLoading,
    // Only gate on the initial load failure — a background refetch error keeps
    // cached entities so we don't replace the module with the full error view.
    isLoadingError,
    refetch,
    isFetching,
  } = useQuery<EntityRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const hasEntity = (entities?.length ?? 0) > 0;

  let content: React.ReactNode;
  if (isLoading) {
    content = <PageLoader fullScreen={false} />;
  } else if (isLoadingError) {
    content = (
      <div
        className="flex flex-col items-center justify-center gap-3 text-center px-4 min-h-[calc(100vh-120px)]"
        data-testid="weldbooks-entities-load-error"
      >
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground max-w-[360px]">{tl.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          {tl.retry}
        </Button>
      </div>
    );
  } else if (hasEntity) {
    content = children;
  } else {
    content = <EntityEmptyState />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <WeldbooksHeader />
      <ModuleContent className="overflow-auto">{content}</ModuleContent>
    </div>
  );
}
