'use client';

import { useEffect } from 'react';
import type { PortalConfig } from '@/lib/types';

/** Applies branding from `/config` to the document: title, favicon, CSS vars. */
export function useBranding(config: PortalConfig | null | undefined) {
  useEffect(() => {
    if (!config) return;
    document.title = config.displayName || 'Portal';

    const root = document.documentElement;
    if (config.primaryColor) root.style.setProperty('--portal-primary', config.primaryColor);
    if (config.accentColor) root.style.setProperty('--portal-accent', config.accentColor);

    if (config.faviconUrl) {
      let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = config.faviconUrl;
    }
  }, [config]);
}
