import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@weldsuite/ui/components/sidebar';
import { Plus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { accountingEntitiesQueryKey } from '@/hooks/use-current-entity-currency';
import { resetEntityScopedAccountingQueries } from '@/hooks/queries/use-accounting-queries';
import { setWeldbooksEntityId, weldbooksApi } from '@/lib/api/weldbooks-client';
import { SidebarScopeSwitcher } from '@/components/layout/sidebar-scope-switcher';
import { CreateEntityDialog } from './create-entity-dialog';

interface EntityRow {
  id: string;
  name: string;
  legalName?: string | null;
  jurisdictionCode: string;
  baseCurrency: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
}

/**
 * Sidebar switcher (top of the WeldBooks sidebar) for the accounting module's
 * legal entities.
 * Writes selection to the persistent Jotai atom — the worker-client automatically
 * picks it up and sends `X-Accounting-Entity-Id` on subsequent API requests.
 */
export function EntitySwitcher() {
  const t = useTranslations();
  const { entityId, setEntityId } = useCurrentAccountingEntity();
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  /**
   * Switch entity without leaving the previous entity's data on screen: point
   * the client at the new entity first (so refetches send the new
   * `X-Accounting-Entity-Id`), then drop every entity-scoped result.
   * AccountingLayoutClient resets again after the atom settles, which covers
   * selections made elsewhere (create dialog, add page).
   */
  const switchEntity = (id: string) => {
    if (id === entityId) return;
    setWeldbooksEntityId(id);
    setEntityId(id);
    void resetEntityScopedAccountingQueries(queryClient);
  };

  const { data: entities = [] } = useQuery<EntityRow[]>({
    queryKey: accountingEntitiesQueryKey(workspaceId),
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: EntityRow[] } | EntityRow[]>('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  // Auto-select the default entity on first load. A selection that isn't one of
  // this workspace's entities is replaced by AccountingLayoutClient.
  useEffect(() => {
    if (!entityId && entities.length > 0) {
      const fallback = entities.find((e) => e.isDefault) ?? entities[0];
      setEntityId(fallback.id);
    }
  }, [entities, entityId, setEntityId]);

  if (entities.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            <span>{t('sweep.weldbooks.entitySwitcher.createEntity')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} firstEntity />
      </SidebarMenu>
    );
  }

  return (
    <>
      <SidebarScopeSwitcher
        options={entities
          .filter((e) => e.isActive !== false)
          .map((e) => ({
            id: e.id,
            name: e.name,
            description: `${e.jurisdictionCode} · ${e.baseCurrency}${e.legalName ? ` · ${e.legalName}` : ''}`,
            trailing: e.isDefault ? (
              <span className="text-[10px] uppercase text-muted-foreground">
                {t('sweep.weldbooks.entitySwitcher.default')}
              </span>
            ) : undefined,
          }))}
        currentId={entityId}
        onSelect={switchEntity}
        label={t('sweep.weldbooks.entitySwitcher.legalEntity')}
        placeholder={t('sweep.weldbooks.entitySwitcher.selectEntity')}
        addLabel={t('sweep.weldbooks.entitySwitcher.newEntity')}
        onAdd={() => setCreateOpen(true)}
      />
      <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
