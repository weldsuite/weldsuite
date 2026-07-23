import { useEffect } from 'react';
import { atom, useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { setWeldbooksEntityId } from '@/lib/api/weldbooks-client';

/**
 * Selected accounting entity id. Persisted in localStorage so the user's choice
 * survives reloads. The weldbooks-client mirror (via setWeldbooksEntityId) makes
 * sure every accounting request carries the `X-Accounting-Entity-Id` header.
 */
const currentAccountingEntityIdAtom = atomWithStorage<string | null>(
  'weldsuite.currentAccountingEntityId',
  null,
);

/** Read/write the current entity id. */
export function useCurrentAccountingEntity() {
  const [entityId, setEntityId] = useAtom(currentAccountingEntityIdAtom);

  // Keep the imperative client mirror in sync with the atom.
  useEffect(() => {
    setWeldbooksEntityId(entityId);
  }, [entityId]);

  return { entityId, setEntityId };
}

/** Read-only atom for components that only need to react to changes. */
const accountingEntityIdReadonlyAtom = atom((get) => get(currentAccountingEntityIdAtom));
