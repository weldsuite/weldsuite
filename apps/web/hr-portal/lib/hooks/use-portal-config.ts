'use client';

import { useEffect, useState } from 'react';
import { PortalApiError, portalGet } from '@/lib/client';
import type { PortalConfig } from '@/lib/types';

export type PortalConfigStatus = 'loading' | 'ready' | 'not_found' | 'error';

/** Fetches branding + feature switches from `/config`. 404 means the portal is disabled for this workspace. */
export function usePortalConfig(slug: string): { config: PortalConfig | null; status: PortalConfigStatus } {
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [status, setStatus] = useState<PortalConfigStatus>('loading');

  useEffect(() => {
    if (!slug) {
      setStatus('not_found');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    portalGet<PortalConfig>(slug, '/config')
      .then((data) => {
        if (cancelled) return;
        setConfig(data);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus(err instanceof PortalApiError && err.status === 404 ? 'not_found' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { config, status };
}
