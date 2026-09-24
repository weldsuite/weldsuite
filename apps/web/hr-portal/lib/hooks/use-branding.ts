'use client';

import { useEffect, type CSSProperties } from 'react';
import type { PortalConfig } from '@/lib/types';

/**
 * Brand colours as CSS custom properties for a wrapper element. Rendered on
 * the server as an inline style, so the first paint is already on-brand (no
 * flash of the default colours).
 */
export function brandingStyle(config: PortalConfig | null | undefined): CSSProperties {
  const style: Record<string, string> = {};
  if (config?.primaryColor) style['--portal-primary'] = config.primaryColor;
  if (config?.accentColor) style['--portal-accent'] = config.accentColor;
  return style as CSSProperties;
}

/**
 * Keeps the tab title and favicon in step with the branding after a live
 * config change. The initial values come from generateMetadata on the server.
 */
export function useBranding(config: PortalConfig | null | undefined) {
  useEffect(() => {
    if (!config) return;
    document.title = config.displayName || 'Portal';
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
