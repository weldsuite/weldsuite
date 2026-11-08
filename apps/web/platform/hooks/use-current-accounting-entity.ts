import { useEffect } from 'react';
import { setWeldbooksEntityId } from '@/lib/api/weldbooks-client';
import { useCurrentLegalEntityId } from '@/hooks/use-current-legal-entity';

/**
 * Selected accounting entity id. It is the workspace's selected legal entity
 * (`currentLegalEntityIdAtom`, persisted per workspace and shared with WeldHR);
 * an accounting entity has the id of its legal entity. The weldbooks-client
 * mirror (via setWeldbooksEntityId) makes sure every accounting request carries
 * the `X-Accounting-Entity-Id` and `X-Legal-Entity-Id` headers.
 *
 * The selection is not checked against the WeldBooks entities here:
 * AccountingLayoutClient replaces one WeldBooks is not enabled for with the
 * workspace default (or the first WeldBooks entity).
 */
export function useCurrentAccountingEntity() {
  const { entityId, setEntityId } = useCurrentLegalEntityId();

  // Keep the imperative client mirror in sync with the atom.
  useEffect(() => {
    setWeldbooksEntityId(entityId);
  }, [entityId]);

  return { entityId, setEntityId };
}
