/**
 * WeldBooks settings shown under an entity in Settings → Entities (its
 * WeldBooks tab, the invoice templates and their designer) read and write
 * through the entity selected in WeldBooks: the `X-Accounting-Entity-Id` of
 * every accounting request, and the currency and locale the previews use.
 * These pages select the entity of their URL first.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageLoader } from '@/components/page-loader';
import { resetEntityScopedAccountingQueries } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { setWeldbooksEntityId } from '@/lib/api/weldbooks-client';

/**
 * Selects the entity in WeldBooks and drops the previous entity's results,
 * as the entity switcher does. True once the entity is the selected one.
 */
export function useSelectWeldbooksEntity(entityId: string): boolean {
  const { entityId: selected, setEntityId } = useCurrentAccountingEntity();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!entityId || selected === entityId) return;
    setWeldbooksEntityId(entityId);
    setEntityId(entityId);
    void resetEntityScopedAccountingQueries(queryClient);
  }, [selected, entityId, setEntityId, queryClient]);

  return Boolean(entityId) && selected === entityId;
}

/** Renders its children once the entity is the one selected in WeldBooks. */
export function WeldbooksEntityScope({ entityId, children }: Readonly<{ entityId: string; children: React.ReactNode }>) {
  const selected = useSelectWeldbooksEntity(entityId);
  if (!selected) return <PageLoader fullScreen={false} />;
  return <>{children}</>;
}
