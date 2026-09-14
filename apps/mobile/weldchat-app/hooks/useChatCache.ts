/**
 * Org-bound view of the WeldChat offline cache.
 *
 * Binds the latched org id and returns accessors with it applied so screens
 * can read/write without repeating scoping boilerplate.
 */

import { useMemo } from 'react';
import { chatCache } from '@/lib/offline/cache';
import { useCacheOrgId } from '@/hooks/useCacheOrgId';

export function useChatCache() {
  const orgId = useCacheOrgId();

  return useMemo(() => {
    if (orgId === null) {
      return {
        getChannels: () => Promise.resolve<unknown[] | null>(null),
        setChannels: (_channels: unknown[]) => Promise.resolve(),
        getSections: () => Promise.resolve<unknown[] | null>(null),
        setSections: (_sections: unknown[]) => Promise.resolve(),
        getDms: () => Promise.resolve<unknown[] | null>(null),
        setDms: (_dms: unknown[]) => Promise.resolve(),
      };
    }
    const oid = orgId;
    return {
      getChannels: () => chatCache.getChannels(oid),
      setChannels: (channels: unknown[]) => chatCache.setChannels(oid, channels),
      getSections: () => chatCache.getSections(oid),
      setSections: (sections: unknown[]) => chatCache.setSections(oid, sections),
      getDms: () => chatCache.getDms(oid),
      setDms: (dms: unknown[]) => chatCache.setDms(oid, dms),
    };
  }, [orgId]);
}
