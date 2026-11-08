import { useQueryClient } from '@tanstack/react-query';
import { LegalEntitySwitcher } from '@/components/legal-entity/legal-entity-switcher';
import { useCurrentLegalEntity } from '@/hooks/use-current-legal-entity';
import { resetHrQueries } from '@/hooks/queries/use-weldhr-queries';
import { setHrLegalEntityId } from '@/lib/api/legal-entity-scope';
import { useRouter } from '@/lib/router';

/**
 * Sidebar switcher (top of the WeldHR sidebar) for the legal entities WeldHR is
 * enabled for. Every WeldHR request carries the selected entity
 * (`X-Legal-Entity-Id`); a switch points the client at the new entity and drops
 * the previous entity's results. "Add" opens Settings → Legal entities, where
 * entities are created.
 */
export function WeldhrEntitySwitcher() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { entityId, setEntityId } = useCurrentLegalEntity({ app: 'weldhr' });

  const switchEntity = (id: string) => {
    if (id === entityId) return;
    setHrLegalEntityId(id);
    setEntityId(id);
    void resetHrQueries(queryClient);
  };

  return (
    <LegalEntitySwitcher
      app="weldhr"
      currentId={entityId}
      onSelect={switchEntity}
      onAdd={() => router.push('/settings/legal-entities')}
    />
  );
}
