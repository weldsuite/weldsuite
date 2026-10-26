/**
 * userId → display name for the workspace roster, loaded once per mount.
 *
 * For one-line previews that may still carry raw `<@userId>` mention tokens:
 * the server renders them as `@Name` now, but notifications and channel
 * previews stored before that keep the token. Pass the map to
 * `mentionsToPlainText`. Empty until the roster arrives (and if it fails).
 */
import { useEffect, useState } from 'react';

import { appApi } from '@/services/app-api';

export function useMemberNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    appApi.chatMembers
      .list()
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const m of res.data ?? []) {
          if (m.userId && m.name) map.set(m.userId, m.name);
        }
        setNames(map);
      })
      .catch((err) => console.error('[WeldChat] Failed to load member names:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  return names;
}
