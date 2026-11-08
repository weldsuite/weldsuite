import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@weldsuite/ui/components/sidebar';
import { Plus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useLegalEntities } from '@/hooks/queries/use-legal-entities-queries';
import { resetEntityScopedAccountingQueries } from '@/hooks/queries/use-accounting-queries';
import { setWeldbooksEntityId } from '@/lib/api/weldbooks-client';
import { LegalEntitySwitcher } from '@/components/legal-entity/legal-entity-switcher';
import { CreateEntityDialog } from './create-entity-dialog';

/**
 * Sidebar switcher (top of the WeldBooks sidebar) for the legal entities
 * WeldBooks is enabled for: the shared `LegalEntitySwitcher` with the WeldBooks
 * client pointed at the selection. It writes the workspace's selected legal entity;
 * the client mirror sends it as `X-Accounting-Entity-Id` and `X-Legal-Entity-Id`
 * on subsequent API requests.
 */
export function EntitySwitcher() {
  const t = useTranslations();
  const { entityId, setEntityId } = useCurrentAccountingEntity();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const { data: entities, isLoading } = useLegalEntities({ app: 'weldbooks' });

  /**
   * Switch entity without leaving the previous entity's data on screen: point
   * the client at the new entity first (so refetches send the new headers),
   * then drop every entity-scoped result. AccountingLayoutClient resets again
   * after the atom settles, which covers selections made elsewhere (create
   * dialog, add page).
   */
  const switchEntity = (id: string) => {
    if (id === entityId) return;
    setWeldbooksEntityId(id);
    setEntityId(id);
    void resetEntityScopedAccountingQueries(queryClient);
  };

  if (isLoading) return null;

  if ((entities?.length ?? 0) === 0) {
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
      <LegalEntitySwitcher
        app="weldbooks"
        currentId={entityId}
        onSelect={switchEntity}
        onAdd={() => setCreateOpen(true)}
        addLabel={t('sweep.weldbooks.entitySwitcher.newEntity')}
      />
      <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
