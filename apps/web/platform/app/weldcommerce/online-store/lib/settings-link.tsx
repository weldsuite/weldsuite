/**
 * Domains, visibility and deployments of an online store are settings, so
 * they live in Settings → Apps → WeldCommerce → Online store (AGENTS.md:
 * an app's settings have one home). The online store links there with this
 * link, which remembers the page so the Settings back button returns to it.
 */

import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { stripWorkspacePrefix } from '@/lib/workspace-url';

export const ONLINE_STORE_SETTINGS_TAB = 'online-store';

export function rememberSettingsReturn(): void {
  try {
    sessionStorage.setItem('settings-return-url', stripWorkspacePrefix(globalThis.location.pathname) || '/');
  } catch {
    // Storage blocked: the Settings back button falls back to its default.
  }
}

export function OnlineStoreSettingsLink({
  siteId,
  className,
  children,
  'aria-label': ariaLabel,
}: Readonly<{ siteId?: string; className?: string; children: ReactNode; 'aria-label'?: string }>) {
  return (
    <Link
      to="/settings/apps/weldcommerce"
      search={siteId ? { tab: ONLINE_STORE_SETTINGS_TAB, site: siteId } : { tab: ONLINE_STORE_SETTINGS_TAB }}
      onClick={rememberSettingsReturn}
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}
