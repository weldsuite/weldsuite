/**
 * Workspace members that conversations can be assigned to.
 *
 * The roster is cached at module level for the app session (members rarely
 * change, and both the thread header and the picker need it); `load()` is a
 * no-op once it has succeeded unless `force` is set. The cache is keyed by
 * the signed-in user and workspace: sign-out doesn't reload the JS bundle, so
 * a different account must never see — or assign to — the previous roster.
 */

import { useCallback, useEffect, useState } from 'react';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

import api from '@/services/api';
import type { DeskMember } from '@/types/desk';

let cache: { key: string; members: DeskMember[] } | null = null;
let inflight: { key: string; promise: Promise<DeskMember[] | null> } | null = null;

function cachedFor(key: string): DeskMember[] | null {
  return cache?.key === key ? cache.members : null;
}

function fetchMembers(key: string): Promise<DeskMember[] | null> {
  if (inflight?.key === key) return inflight.promise;
  const promise = api
    .listAssignableMembers()
    .then((res) => {
      if (res.success && res.data) {
        cache = { key, members: res.data };
        return res.data;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

export function useAssignableMembers() {
  const { user, organizationId } = useClerkAuth();
  const key = `${user?.id ?? ''}:${organizationId ?? ''}`;
  const [members, setMembers] = useState<DeskMember[] | null>(() => cachedFor(key));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Another account or workspace: drop what this screen was showing.
  useEffect(() => {
    setMembers(cachedFor(key));
  }, [key]);

  const load = useCallback(
    async (force = false) => {
      const cached = cachedFor(key);
      if (cached && !force) {
        setMembers(cached);
        return;
      }
      setLoading(true);
      setError(false);
      const result = await fetchMembers(key);
      if (result) setMembers(result);
      else setError(true);
      setLoading(false);
    },
    [key],
  );

  return { members, loading, error, load };
}
