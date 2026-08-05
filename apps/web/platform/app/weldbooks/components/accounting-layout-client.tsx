import { useQuery } from '@tanstack/react-query';
import { WeldbooksHeader } from './weldbooks-header';
import { ModuleContent } from '@/components/layout/module-content';
import { PageLoader } from '@/components/page-loader';
import { EntityEmptyState } from '@/components/accounting/entity-empty-state';
import { weldbooksApi } from '@/lib/api/weldbooks-client';

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
  const { data: entities, isLoading } = useQuery<EntityRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const hasEntity = (entities?.length ?? 0) > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <WeldbooksHeader />
      <ModuleContent className="overflow-auto">
        {isLoading ? (
          <PageLoader fullScreen={false} />
        ) : hasEntity ? (
          children
        ) : (
          <EntityEmptyState />
        )}
      </ModuleContent>
    </div>
  );
}
