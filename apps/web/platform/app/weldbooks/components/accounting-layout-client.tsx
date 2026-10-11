import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { WeldbooksHeader } from './weldbooks-header';
import { ModuleContent } from '@/components/layout/module-content';
import { PageLoader } from '@/components/page-loader';
import { EntityEmptyState } from '@/components/accounting/entity-empty-state';
import { setWeldbooksEntityId, weldbooksApi } from '@/lib/api/weldbooks-client';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { accountingEntitiesQueryKey } from '@/hooks/use-current-entity-currency';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { resetEntityScopedAccountingQueries } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

interface EntityRow {
  id: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
}

/** The entity to fall back to: the workspace default, else the first active one, else the first. */
function fallbackEntity(entities: EntityRow[]): EntityRow {
  return (
    entities.find((e) => e.isDefault && e.isActive !== false) ??
    entities.find((e) => e.isActive !== false) ??
    entities[0]
  );
}

/**
 * The selected entity is kept in localStorage, one key for every workspace.
 * After a workspace switch (or once the entity is deleted) it names an entity
 * this workspace doesn't have, and every request would carry it. Replace it
 * with this workspace's default; returns false until the selection is valid.
 */
function useValidAccountingEntity(entities: EntityRow[] | undefined): boolean {
  const { entityId, setEntityId } = useCurrentAccountingEntity();
  const known = !entityId || !entities || entities.length === 0 || entities.some((e) => e.id === entityId);

  useEffect(() => {
    if (known || !entities || entities.length === 0) return;
    const fallback = fallbackEntity(entities);
    setWeldbooksEntityId(fallback.id);
    setEntityId(fallback.id);
  }, [known, entities, setEntityId]);

  return known;
}

/**
 * When the selected entity changes — from the switcher, the create dialog or
 * the add-entity page — drop every entity-scoped accounting result so the
 * previous entity's numbers are never shown under the new one. Runs after the
 * client mirror is updated, so the refetches carry the new entity header.
 */
function useResetAccountingDataOnEntityChange() {
  const { entityId } = useCurrentAccountingEntity();
  const queryClient = useQueryClient();
  const previous = useRef(entityId);

  useEffect(() => {
    if (previous.current === entityId) return;
    previous.current = entityId;
    setWeldbooksEntityId(entityId);
    void resetEntityScopedAccountingQueries(queryClient);
  }, [entityId, queryClient]);
}

/**
 * The module sidebar is rendered by PlatformShell via UnifiedModuleSidebar + MODULE_CONFIGS.weldbooks.
 * This layout renders the WeldBooks full-width header at the top (with module-wide search and the
 * entity switcher in the actions slot), then the active page's content in the shared content row.
 *
 * When the workspace has no accounting entity yet, short-circuit to EntityEmptyState so the user
 * can create the first legal entity before opening entity-scoped pages.
 */
export function AccountingLayoutClient({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const tl = t.accounting.layout;
  const workspaceId = useWorkspaceId();
  useResetAccountingDataOnEntityChange();

  const {
    data: entities,
    isLoading,
    // Only gate on the initial load failure — a background refetch error keeps
    // cached entities so we don't replace the module with the full error view.
    isLoadingError,
    refetch,
    isFetching,
  } = useQuery<EntityRow[]>({
    queryKey: accountingEntitiesQueryKey(workspaceId),
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const hasEntity = (entities?.length ?? 0) > 0;
  const entityValid = useValidAccountingEntity(entities);

  let content: React.ReactNode;
  // Pages wait while a stale selection is replaced, so no request goes out for an entity of another workspace.
  if (isLoading || (hasEntity && !entityValid)) {
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
