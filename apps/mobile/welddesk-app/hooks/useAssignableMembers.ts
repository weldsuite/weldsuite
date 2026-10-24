/**
 * Workspace members that conversations can be assigned to.
 *
 * The roster is cached at module level for the app session (members rarely
 * change, and both the thread header and the picker need it); `load()` is a
 * no-op once it has succeeded unless `force` is set.
 */

import { useCallback, useState } from 'react';

import api from '@/services/api';
import type { DeskMember } from '@/types/desk';

let cachedMembers: DeskMember[] | null = null;
let inflight: Promise<DeskMember[] | null> | null = null;

function fetchMembers(): Promise<DeskMember[] | null> {
  inflight ??= api
    .listAssignableMembers()
    .then((res) => {
      if (res.success && res.data) {
        cachedMembers = res.data;
        return res.data;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useAssignableMembers() {
  const [members, setMembers] = useState<DeskMember[] | null>(cachedMembers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async (force = false) => {
    if (cachedMembers && !force) {
      setMembers(cachedMembers);
      return;
    }
    setLoading(true);
    setError(false);
    const result = await fetchMembers();
    if (result) setMembers(result);
    else setError(true);
    setLoading(false);
  }, []);

  return { members, loading, error, load };
}
